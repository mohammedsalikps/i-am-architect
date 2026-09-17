import * as THREE from "three";
import type { PlacementController, PlacementTool } from "./PlacementController";
import { AssetLoader } from "../assets/AssetLoader";
import { getAssetDefinition } from "../../engine/assets/catalog";
import type { AssetDefinition } from "../../engine/assets/catalog";
import type { PlacementHudState } from "../../ui/placementHud";
import type { AssetPlacementSnapResult } from "../../engine/snapping/assetPlacementSnapper";

/** The narrow shape this module needs from createAssetPlacementSnapper() - structural, so a test double never needs the real engine/snapping wiring. */
export interface AssetPlacementSnapperLike {
  snap(candidate: { x: number; z: number }, dimensions: { width: number; height: number; depth: number }, rotationRadians: number): AssetPlacementSnapResult;
}

export interface AssetPlacementPreviewOptions {
  scene: THREE.Scene;
  camera: THREE.Camera;
  canvas: HTMLCanvasElement;
  placementController: PlacementController;
  /** Initial-placement snapping (Phase 6) - see engine/snapping/assetPlacementSnapper.ts for why this is a separate adapter from the manipulation-time one. */
  snapper: AssetPlacementSnapperLike;
  onHudChange(state: PlacementHudState | null): void;
}

export interface AssetPlacementPreview {
  /**
   * The preview's current rotation, in radians - read once, at the
   * moment of a confirmed placement click, and folded into the same
   * asset.add command main.ts's own placement closure already builds, so
   * the real placed object matches exactly what was previewed. Never
   * itself calls CommandExecutor.
   */
  getCurrentRotation(): number;
  /**
   * The preview's current (already-snapped) ground position, read at the
   * moment of a confirmed placement click and used INSTEAD OF
   * PlacementController's own raw click point - so what actually gets
   * placed matches exactly what was previewed and snapped, not the raw,
   * unsnapped point under the cursor. Null before the first pointermove
   * (or when nothing is armed) - main.ts falls back to the raw click
   * point in that case.
   */
  getCurrentPosition(): { x: number; z: number } | null;
  /** Removes every listener this module added and any in-scene preview - main.ts constructs one for the app's lifetime, so this exists mainly for completeness/tests. */
  dispose(): void;
}

/** main.ts's own `asset:<id>` convention (ui/assetLibrary.ts's placementIdFor) - the one place this module needs to recognize "an asset tool, not a wall/pillar/etc tool", never a second, hand-maintained way to ask that question. */
const ASSET_TOOL_PREFIX = "asset:";
const GROUND_PLANE = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
/** Translucent and subdued (task: "opacity around 0.35-0.55") - clearly a preview, never mistakable for a placed object. */
const PREVIEW_OPACITY = 0.45;
/** Drawn after the box ghost (renderOrder 999) and with depthWrite disabled, exactly like the ghost itself - so it's never fought by real scene depth, and visually supersedes the ghost wherever both would otherwise show. */
const PREVIEW_RENDER_ORDER = 1000;
const ROTATION_STEP = Math.PI / 2;

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  return target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable;
}

/** Disposes only this preview's own cloned materials - never the geometry, which is shared with AssetLoader's cached template (same disposal contract as scene/assets/buildAssetVisual.ts's disposeAssetVisual() for a loaded model). */
function disposePreviewGroup(group: THREE.Group): void {
  group.traverse((object) => {
    if (object instanceof THREE.Mesh) {
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) {
        material.dispose();
      }
    }
  });
}

/**
 * A richer, asset-specific placement visual layered ADDITIVELY over
 * PlacementController's own generic box-ghost lifecycle (Phase 5A).
 * PlacementController itself is never modified beyond the one small
 * setGhostVisible() toggle it already exposes for exactly this purpose -
 * arm/disarm/click-confirmation/Escape/ghost-sizing all remain entirely
 * its own.
 *
 * This module:
 *
 * - learns which tool is armed via placementController.subscribe() (the
 *   same mechanism the ribbon's and asset library's own active-state
 *   already use), recognizing an asset tool by the `asset:<id>` prefix
 *   main.ts's addAsset() already establishes;
 * - tracks the live cursor's ground point itself, via its own pointermove
 *   listener on the same canvas and the exact same infinite Y=0 plane
 *   raycast PlacementController's own (private) groundPointFor() uses - a
 *   deliberate, small, independent duplication rather than a change to
 *   PlacementController just to expose that value, so the real preview
 *   and the generic ghost always agree on where "here" is;
 * - loads the real GLTF through its own AssetLoader instance, reusing the
 *   exact loading/scaling architecture AssetLayer.ts already established
 *   for a placed asset (never a second representation of any model), and
 *   shows a translucent instance of it, swapping in for the box ghost
 *   only once that load actually resolves;
 * - owns pre-placement rotation entirely locally, as a plain 0-3 step
 *   counter - never sent anywhere until the moment of a confirmed click.
 *
 * Never touches AssetStore, CommandExecutor, HistoryManager, or any
 * selection/manipulation layer: the preview's THREE.Group is added
 * straight to the scene and nowhere else, so it can never be selected,
 * saved, or undone, and moving it never writes to the project document.
 */
export function createAssetPlacementPreview(options: AssetPlacementPreviewOptions): AssetPlacementPreview {
  const loader = new AssetLoader();
  const raycaster = new THREE.Raycaster();

  let armedDefinition: AssetDefinition | null = null;
  let previewGroup: THREE.Group | null = null;
  let rotationSteps = 0;
  /** Bumped on every arm/disarm/tool-switch so a load that resolves after the tool moved on is discarded - the same pattern AssetLayer.ts's own requestId already uses. */
  let generation = 0;
  /** The raw (unsnapped) cursor ground point - what a fresh rotation re-snaps from. */
  let lastPoint: THREE.Vector3 | null = null;
  /** The last computed placement position (after snapping) - what positionPreview()/getCurrentPosition() actually use. */
  let lastSnapped: AssetPlacementSnapResult | null = null;

  function groundPointFor(event: PointerEvent): THREE.Vector3 | null {
    const rect = options.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(ndc, options.camera);
    const out = new THREE.Vector3();
    return raycaster.ray.intersectPlane(GROUND_PLANE, out) ? out : null;
  }

  /** Projects a world ground point to viewport (client) pixels, for the HUD to anchor near - the standard NDC-to-screen inverse of groundPointFor()'s own conversion. */
  function screenAnchorFor(point: THREE.Vector3): { x: number; y: number } {
    const projected = point.clone().project(options.camera);
    const rect = options.canvas.getBoundingClientRect();
    return {
      x: rect.left + (projected.x * 0.5 + 0.5) * rect.width,
      y: rect.top + (-projected.y * 0.5 + 0.5) * rect.height
    };
  }

  function emitHud(): void {
    if (!armedDefinition || !lastPoint) {
      options.onHudChange(null);
      return;
    }
    options.onHudChange({
      label: armedDefinition.label,
      dimensions: armedDefinition.defaultDimensions,
      rotationDegrees: rotationSteps * 90,
      anchor: screenAnchorFor(lastPoint),
      snapped: lastSnapped?.snapped ?? false
    });
  }

  /** Same floor-anchor convention as the eventual real asset (createAsset.ts's own position.y = dimensions.height/2), so there is no visual "pop" the instant a confirmed placement becomes the real object. */
  function positionPreview(x: number, z: number): void {
    if (!previewGroup || !armedDefinition) {
      return;
    }
    previewGroup.position.set(x, armedDefinition.defaultDimensions.height / 2, z);
  }

  function applyRotation(): void {
    if (previewGroup) {
      previewGroup.rotation.y = rotationSteps * ROTATION_STEP;
    }
  }

  /** Re-snaps `lastPoint` against the armed asset's current rotation, positions the preview at the result, and refreshes the HUD - the one place placement position ever changes, so cursor movement and in-place rotation always agree on where "here" is. */
  function updatePlacement(): void {
    if (!armedDefinition || !lastPoint) {
      lastSnapped = null;
      emitHud();
      return;
    }
    lastSnapped = options.snapper.snap({ x: lastPoint.x, z: lastPoint.z }, armedDefinition.defaultDimensions, rotationSteps * ROTATION_STEP);
    positionPreview(lastSnapped.position.x, lastSnapped.position.z);
    emitHud();
  }

  function clearPreviewGroup(): void {
    if (previewGroup) {
      options.scene.remove(previewGroup);
      disposePreviewGroup(previewGroup);
      previewGroup = null;
    }
  }

  function resetForNewTool(definition: AssetDefinition | null): void {
    generation += 1; // invalidates any load already in flight for the tool this is replacing
    clearPreviewGroup();
    options.placementController.setGhostVisible(true); // the box ghost is the fallback until (and unless) a real preview loads
    armedDefinition = definition;
    rotationSteps = 0; // every new placement session starts at 0 degrees
    lastPoint = null;
    lastSnapped = null;
    emitHud();

    if (!definition) {
      return;
    }

    const myGeneration = generation;
    loader
      .load(definition)
      .then((loaded) => {
        if (myGeneration !== generation) {
          return; // a different tool was armed, or this one was disarmed, since this load started
        }
        const { group, naturalSize } = loaded;
        const safeScale = (target: number, natural: number): number => (natural > 1e-6 ? target / natural : 1);
        group.scale.set(
          safeScale(definition.defaultDimensions.width, naturalSize.x),
          safeScale(definition.defaultDimensions.height, naturalSize.y),
          safeScale(definition.defaultDimensions.depth, naturalSize.z)
        );
        group.traverse((object) => {
          if (object instanceof THREE.Mesh) {
            object.castShadow = false;
            object.receiveShadow = false;
            object.renderOrder = PREVIEW_RENDER_ORDER;
            const materials = Array.isArray(object.material) ? object.material : [object.material];
            for (const material of materials) {
              material.transparent = true;
              material.opacity = PREVIEW_OPACITY;
              material.depthWrite = false;
            }
          }
        });

        previewGroup = group;
        options.scene.add(group);
        applyRotation();
        if (lastSnapped) {
          positionPreview(lastSnapped.position.x, lastSnapped.position.z);
        }
        options.placementController.setGhostVisible(false);
      })
      .catch(() => {
        // Loading failed - the box ghost (left visible above) stays exactly as it already is; placement itself is unaffected.
      });
  }

  const unsubscribe = options.placementController.subscribe((tool: PlacementTool | null) => {
    const assetId = tool && tool.id.startsWith(ASSET_TOOL_PREFIX) ? tool.id.slice(ASSET_TOOL_PREFIX.length) : null;
    resetForNewTool(assetId ? (getAssetDefinition(assetId) ?? null) : null);
  });

  const handlePointerMove = (event: PointerEvent): void => {
    if (!armedDefinition) {
      return;
    }
    const point = groundPointFor(event);
    if (!point) {
      return;
    }
    lastPoint = point;
    updatePlacement();
  };
  options.canvas.addEventListener("pointermove", handlePointerMove);

  const handleKeyDown = (event: KeyboardEvent): void => {
    if (!armedDefinition || event.key.toLowerCase() !== "r" || isTypingTarget(event.target)) {
      return;
    }
    event.preventDefault();
    rotationSteps = (rotationSteps + (event.shiftKey ? 3 : 1)) % 4;
    applyRotation();
    updatePlacement(); // rotating changes the asset's own footprint corners, so re-snap at the same cursor point
  };
  window.addEventListener("keydown", handleKeyDown);

  return {
    getCurrentRotation: () => rotationSteps * ROTATION_STEP,
    getCurrentPosition: () => (lastSnapped ? { x: lastSnapped.position.x, z: lastSnapped.position.z } : null),
    dispose: () => {
      unsubscribe();
      options.canvas.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("keydown", handleKeyDown);
      clearPreviewGroup();
      options.placementController.setGhostVisible(true);
      options.onHudChange(null);
    }
  };
}
