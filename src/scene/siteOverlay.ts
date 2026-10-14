import * as THREE from "three";
import type { ArchitectViewState } from "../engine/architect/ArchitectSession";
import { plotEdgeText } from "../engine/workspace/dimensions";
import { fitLabels, labelSprite, type ViewportSize } from "./labelSprite";
import { SCENE_PALETTES, type ScenePalette } from "./sceneTheme";

/**
 * The architect's planning marks in the viewport - never construction
 * objects, never saved, never selectable (SelectionRaycaster only tests
 * the construction layers' own meshes):
 *
 * - the site (plot) boundary, as a gold outline with corner pegs and
 *   its edge lengths labelled - the plot is separate from the workspace
 *   grid, which extends well past it (the site itself is a real landscape
 *   element, drawn by the element layer);
 * - the chosen location, as a pin;
 * - the planned house footprint, as a dashed outline, until construction
 *   starts and the real slab takes its place;
 * - a room or wall waiting for "build it": a translucent volume, ghost
 *   walls exactly where they would be built, and its dimensions labelled.
 *
 * Driven entirely by ArchitectSession's view state - see main.ts.
 */
export interface SiteOverlay {
  update(state: ArchitectViewState): void;
  /** The workspace theme's plot and label colours; redraws the current marks. */
  setPalette(palette: ScenePalette): void;
  /** Keeps the plot's edge labels readable at this frame's zoom (see fitLabels). */
  fitLabels(camera: THREE.PerspectiveCamera, viewport: ViewportSize): void;
  /** Hides the marks (they draw over walls) - Interior Explore, from inside a room. */
  setVisible(visible: boolean): void;
}

const MARKER_COLOR = 0x4fa8ff;
const PLAN_COLOR = 0x8fc1ff;
/** Just above the site's own surface (its top is at y = 0), so the marks never z-fight with it. */
const MARK_Y = 0.03;

function rectanglePoints(center: { x: number; z: number }, length: number, width: number): THREE.Vector3[] {
  const x0 = center.x - length / 2;
  const x1 = center.x + length / 2;
  const z0 = center.z - width / 2;
  const z1 = center.z + width / 2;
  return [new THREE.Vector3(x0, MARK_Y, z0), new THREE.Vector3(x1, MARK_Y, z0), new THREE.Vector3(x1, MARK_Y, z1), new THREE.Vector3(x0, MARK_Y, z1), new THREE.Vector3(x0, MARK_Y, z0)];
}

export function disposeChildren(group: THREE.Group): void {
  for (const child of [...group.children]) {
    group.remove(child);
    child.traverse((object) => {
      const mesh = object as THREE.Mesh;
      mesh.geometry?.dispose();
      const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
      const materials = Array.isArray(material) ? material : material ? [material] : [];
      for (const entry of materials) {
        (entry as THREE.SpriteMaterial).map?.dispose();
        entry.dispose();
      }
    });
  }
}

/** Overlay marks draw over the ground and slab but stay out of picking and shadows. */
export function overlayObject<T extends THREE.Object3D>(object: T): T {
  object.renderOrder = 998;
  object.raycast = () => undefined;
  object.castShadow = false;
  object.receiveShadow = false;
  // Not geometry: kept out of the ambient-occlusion pass (see SceneManager).
  object.userData.excludeFromAO = true;
  return object;
}

function buildSite(site: NonNullable<ArchitectViewState["site"]>, palette: ScenePalette): THREE.Object3D {
  const group = new THREE.Group();
  const outline = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(rectanglePoints(site.center, site.length, site.width)),
    // Unfogged: the boundary must read even with the whole plot in view.
    new THREE.LineBasicMaterial({ color: palette.plot, transparent: true, opacity: 0.9, depthTest: false, fog: false })
  );
  group.add(overlayObject(outline));
  // Corner pegs - small posts so the boundary reads in perspective, not only from above.
  const pegGeometry = new THREE.CylinderGeometry(0.06, 0.06, 0.6, 8);
  const pegMaterial = new THREE.MeshStandardMaterial({ color: palette.plot, roughness: 0.6, fog: false });
  for (const point of rectanglePoints(site.center, site.length, site.width).slice(0, 4)) {
    const peg = new THREE.Mesh(pegGeometry, pegMaterial);
    peg.position.set(point.x, 0.3, point.z);
    group.add(overlayObject(peg));
  }
  // Edge lengths: the length (X, east-west) outside the south edge, the width (Z, north-south) outside the east edge.
  const accent = `#${palette.plot.toString(16).padStart(6, "0")}`;
  const along = labelSprite(plotEdgeText(site.length), palette, { height: 0.55, accent, minPixels: 15 });
  along.position.set(site.center.x, 0.35, site.center.z + site.width / 2 + 1);
  const across = labelSprite(plotEdgeText(site.width), palette, { height: 0.55, accent, minPixels: 15 });
  across.position.set(site.center.x + site.length / 2 + 1.4, 0.35, site.center.z);
  const name = labelSprite(`Plot ${Number(site.length.toFixed(2))} × ${Number(site.width.toFixed(2))} m`, palette, { height: 0.5, accent, minPixels: 15 });
  name.position.set(site.center.x - site.length / 2 + 2.2, 0.35, site.center.z - site.width / 2 - 1);
  group.add(overlayObject(along), overlayObject(across), overlayObject(name));
  return group;
}

function buildMarker(point: { x: number; z: number }): THREE.Object3D {
  const group = new THREE.Group();
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.35, 0.5, 40),
    new THREE.MeshBasicMaterial({ color: MARKER_COLOR, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthTest: false })
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = MARK_Y;
  group.add(overlayObject(ring));
  const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 1.4, 8), new THREE.MeshBasicMaterial({ color: MARKER_COLOR }));
  stem.position.y = 0.7;
  group.add(overlayObject(stem));
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.14, 16, 12), new THREE.MeshBasicMaterial({ color: MARKER_COLOR }));
  head.position.y = 1.45;
  group.add(overlayObject(head));
  group.position.set(point.x, 0, point.z);
  return group;
}

function buildPlan(center: { x: number; z: number }, footprint: { length: number; width: number }): THREE.Object3D {
  const line = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(rectanglePoints(center, footprint.length, footprint.width)),
    new THREE.LineDashedMaterial({ color: PLAN_COLOR, dashSize: 0.4, gapSize: 0.25, depthTest: false })
  );
  line.computeLineDistances();
  const fill = new THREE.Mesh(
    new THREE.PlaneGeometry(footprint.length, footprint.width),
    new THREE.MeshBasicMaterial({ color: PLAN_COLOR, transparent: true, opacity: 0.12, depthWrite: false, depthTest: false })
  );
  fill.rotation.x = -Math.PI / 2;
  fill.position.set(center.x, MARK_Y, center.z);
  const group = new THREE.Group();
  group.add(overlayObject(line), overlayObject(fill));
  return group;
}

const PREVIEW_COLOR = 0x1f5fbf;

/** A camera-facing label, `height` metres tall - a dimension or a name. */
export function textSprite(text: string, height = 0.42): THREE.Sprite {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  const fontSize = 44;
  const font = `600 ${fontSize}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  let width = 200;
  if (context) {
    context.font = font;
    width = Math.ceil(context.measureText(text).width) + 36;
  }
  canvas.width = width;
  canvas.height = 72;
  if (context) {
    context.font = font;
    context.fillStyle = "rgba(255, 255, 255, 0.94)";
    context.strokeStyle = "#1f5fbf";
    context.lineWidth = 4;
    context.beginPath();
    context.roundRect(2, 2, width - 4, 68, 14);
    context.fill();
    context.stroke();
    context.fillStyle = "#17233a";
    context.textBaseline = "middle";
    context.fillText(text, 18, 38);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false, transparent: true }));
  sprite.scale.set((height * canvas.width) / canvas.height, height, 1);
  return overlayObject(sprite);
}

function buildPreview(preview: NonNullable<ArchitectViewState["preview"]>): THREE.Object3D {
  const group = new THREE.Group();
  const { center, sizeX, sizeZ, height } = preview;
  const volume = new THREE.BoxGeometry(sizeX, height, sizeZ);
  const box = new THREE.Mesh(volume, new THREE.MeshBasicMaterial({ color: PREVIEW_COLOR, transparent: true, opacity: 0.07, depthWrite: false }));
  box.position.set(center.x, height / 2, center.z);
  const edges = new THREE.LineSegments(new THREE.EdgesGeometry(volume), new THREE.LineBasicMaterial({ color: PREVIEW_COLOR, transparent: true, opacity: 0.75 }));
  edges.position.copy(box.position);
  group.add(overlayObject(box), overlayObject(edges));
  for (const wall of preview.walls) {
    const ghost = new THREE.Mesh(new THREE.BoxGeometry(wall.length, height, wall.thickness), new THREE.MeshBasicMaterial({ color: PREVIEW_COLOR, transparent: true, opacity: 0.22, depthWrite: false }));
    ghost.position.set(wall.center.x, height / 2, wall.center.z);
    ghost.rotation.y = wall.rotation;
    group.add(overlayObject(ghost));
  }
  const fmtM = (value: number) => `${Number(value.toFixed(2))} m`;
  // The length along the south (+Z) edge, the width along the east (+X) edge, the height at a corner.
  const along = textSprite(fmtM(sizeX));
  along.position.set(center.x, 0.25, center.z + sizeZ / 2 + 0.55);
  const across = textSprite(fmtM(sizeZ));
  across.position.set(center.x + sizeX / 2 + 0.75, 0.25, center.z);
  const up = textSprite(`↕ ${fmtM(height)}`);
  up.position.set(center.x + sizeX / 2 + 0.75, height, center.z + sizeZ / 2);
  const name = textSprite(preview.label, 0.48);
  name.position.set(center.x, height + 0.6, center.z);
  group.add(along, across, up, name);
  return group;
}

export function createSiteOverlay(scene: THREE.Scene, initialPalette: ScenePalette = SCENE_PALETTES.light): SiteOverlay {
  const root = new THREE.Group();
  root.name = "architect-site-overlay";
  scene.add(root);
  let palette = initialPalette;
  let last: ArchitectViewState | null = null;

  const overlay: SiteOverlay = {
    setVisible(visible) {
      root.visible = visible;
    },
    fitLabels(camera, viewport) {
      fitLabels(root, camera, viewport);
    },
    setPalette(next) {
      palette = next;
      if (last) overlay.update(last);
    },
    update(state) {
      last = state;
      disposeChildren(root);
      if (state.site) {
        root.add(buildSite(state.site, palette));
      }
      const building = state.plan?.started ?? false;
      if (state.location && !building) {
        root.add(buildMarker(state.location));
      }
      if (state.plan && state.plan.center && !building) {
        root.add(buildPlan(state.plan.center, state.plan.footprint));
      }
      if (state.preview) {
        root.add(buildPreview(state.preview));
      }
    }
  };
  return overlay;
}
