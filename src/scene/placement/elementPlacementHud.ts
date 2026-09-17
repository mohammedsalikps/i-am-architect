import * as THREE from "three";
import type { PlacementController, PlacementTool } from "./PlacementController";
import type { PlacementHudState } from "../../ui/placementHud";

export interface ElementPlacementHudOptions {
  camera: THREE.Camera;
  canvas: HTMLCanvasElement;
  placementController: PlacementController;
  onHudChange(state: PlacementHudState | null): void;
}

export interface ElementPlacementHud {
  dispose(): void;
}

/** Mirrors assetPlacementPreview.ts's own ASSET_TOOL_PREFIX convention - this module owns every OTHER tool (wall/pillar/beam/slab/door/window/roof/stair/room/...), so the two never both claim the same armed tool. */
const ASSET_TOOL_PREFIX = "asset:";
const GROUND_PLANE = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

/**
 * The same compact "Wall / 4.0 x 2.7 x 0.2 m" placement HUD Phase 5A
 * built for assets (see ui/placementHud.ts), extended to every OTHER
 * placement tool (task section 3: "for supported objects, the user
 * should understand what/where/dimensions..."). Deliberately a second,
 * small, ADDITIVE module rather than folding this into
 * assetPlacementPreview.ts: that module's job is a real GLTF preview
 * with pre-placement rotation, neither of which applies to a
 * construction element (no per-element 3D preview beyond the existing
 * box ghost, and no pre-placement rotation for any of them yet) - this
 * one only ever drives the HUD's dimension line, reusing `tool.ghostSize`
 * (the exact same footprint the box ghost is already sized to, from
 * main.ts's elementGhostSize()/ORIGINAL_GHOST_SIZES) so the numbers
 * shown always match what's actually on screen.
 *
 * Tracks the cursor itself, via its own pointermove listener and the
 * same infinite Y=0 ground-plane raycast PlacementController's own
 * (private) groundPointFor() and assetPlacementPreview.ts both already
 * use independently - never a change to PlacementController.
 */
export function createElementPlacementHud(options: ElementPlacementHudOptions): ElementPlacementHud {
  const raycaster = new THREE.Raycaster();
  let armedTool: PlacementTool | null = null;
  let lastPoint: THREE.Vector3 | null = null;

  function groundPointFor(event: PointerEvent): THREE.Vector3 | null {
    const rect = options.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(ndc, options.camera);
    const out = new THREE.Vector3();
    return raycaster.ray.intersectPlane(GROUND_PLANE, out) ? out : null;
  }

  function screenAnchorFor(point: THREE.Vector3): { x: number; y: number } {
    const projected = point.clone().project(options.camera);
    const rect = options.canvas.getBoundingClientRect();
    return {
      x: rect.left + (projected.x * 0.5 + 0.5) * rect.width,
      y: rect.top + (-projected.y * 0.5 + 0.5) * rect.height
    };
  }

  function emitHud(): void {
    if (!armedTool || !lastPoint) {
      options.onHudChange(null);
      return;
    }
    options.onHudChange({
      label: armedTool.label,
      dimensions: { width: armedTool.ghostSize.x, height: armedTool.ghostSize.y, depth: armedTool.ghostSize.z },
      anchor: screenAnchorFor(lastPoint)
    });
  }

  const unsubscribe = options.placementController.subscribe((tool: PlacementTool | null) => {
    armedTool = tool && !tool.id.startsWith(ASSET_TOOL_PREFIX) ? tool : null;
    lastPoint = null;
    emitHud();
  });

  const handlePointerMove = (event: PointerEvent): void => {
    if (!armedTool) {
      return;
    }
    const point = groundPointFor(event);
    if (!point) {
      return;
    }
    lastPoint = point;
    emitHud();
  };
  options.canvas.addEventListener("pointermove", handlePointerMove);

  return {
    dispose: () => {
      unsubscribe();
      options.canvas.removeEventListener("pointermove", handlePointerMove);
      options.onHudChange(null);
    }
  };
}
