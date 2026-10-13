import * as THREE from "three";
import type { ArchitectViewState } from "../engine/architect/ArchitectSession";

/**
 * The architect's planning marks in the viewport - never construction
 * objects, never saved, never selectable (SelectionRaycaster only tests
 * the construction layers' own meshes):
 *
 * - the site boundary, as a gold outline with corner ticks (the site
 *   itself is a real landscape element, drawn by the element layer);
 * - the chosen location, as a pin;
 * - the planned house footprint, as a dashed outline, until construction
 *   starts and the real slab takes its place.
 *
 * Driven entirely by ArchitectSession's view state - see main.ts.
 */
export interface SiteOverlay {
  update(state: ArchitectViewState): void;
}

const SITE_COLOR = 0xc9a769;
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

function disposeChildren(group: THREE.Group): void {
  for (const child of [...group.children]) {
    group.remove(child);
    child.traverse((object) => {
      const mesh = object as THREE.Mesh;
      mesh.geometry?.dispose();
      const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(material)) material.forEach((entry) => entry.dispose());
      else material?.dispose();
    });
  }
}

/** Overlay marks draw over the ground and slab but stay out of picking and shadows. */
function overlayObject<T extends THREE.Object3D>(object: T): T {
  object.renderOrder = 998;
  object.raycast = () => undefined;
  object.castShadow = false;
  object.receiveShadow = false;
  return object;
}

function buildSite(site: NonNullable<ArchitectViewState["site"]>): THREE.Object3D {
  const group = new THREE.Group();
  const outline = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(rectanglePoints(site.center, site.length, site.width)),
    new THREE.LineBasicMaterial({ color: SITE_COLOR, transparent: true, opacity: 0.9, depthTest: false })
  );
  group.add(overlayObject(outline));
  // Corner pegs - small posts so the boundary reads in perspective, not only from above.
  const pegGeometry = new THREE.CylinderGeometry(0.06, 0.06, 0.6, 8);
  const pegMaterial = new THREE.MeshStandardMaterial({ color: SITE_COLOR, roughness: 0.6 });
  for (const point of rectanglePoints(site.center, site.length, site.width).slice(0, 4)) {
    const peg = new THREE.Mesh(pegGeometry, pegMaterial);
    peg.position.set(point.x, 0.3, point.z);
    group.add(overlayObject(peg));
  }
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

export function createSiteOverlay(scene: THREE.Scene): SiteOverlay {
  const root = new THREE.Group();
  root.name = "architect-site-overlay";
  scene.add(root);

  return {
    update(state) {
      disposeChildren(root);
      if (state.site) {
        root.add(buildSite(state.site));
      }
      const building = state.plan?.started ?? false;
      if (state.location && !building) {
        root.add(buildMarker(state.location));
      }
      if (state.plan && state.plan.center && !building) {
        root.add(buildPlan(state.plan.center, state.plan.footprint));
      }
    }
  };
}
