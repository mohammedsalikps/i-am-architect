import * as THREE from "three";

/**
 * Generic selection-outline helper, shared by every mesh-based
 * construction object layer (WallLayer, PillarLayer, ...) - this logic
 * was originally wall/wallOutline.ts, but nothing about it is actually
 * wall-specific (it just wraps a mesh's edges), so it lives here now
 * that a second object type (pillar) needs the exact same thing.
 */

export const OUTLINE_COLOR = 0xffb020; // amber - distinct from any construction object's own material color
export const OUTLINE_SCALE = 1.02; // slightly larger than the mesh so it reads clearly at any angle

/** Builds a hidden-by-default edge outline as a selection indicator for a mesh. */
export function buildSelectionOutline(mesh: THREE.Mesh): THREE.LineSegments {
  const edges = new THREE.EdgesGeometry(mesh.geometry);
  const material = new THREE.LineBasicMaterial({ color: OUTLINE_COLOR });
  const outline = new THREE.LineSegments(edges, material);
  outline.scale.setScalar(OUTLINE_SCALE);
  outline.visible = false;
  return outline;
}

/** Re-derives the outline geometry after the parent mesh's geometry has been rebuilt. */
export function refreshSelectionOutline(outline: THREE.LineSegments, mesh: THREE.Mesh): void {
  outline.geometry.dispose();
  outline.geometry = new THREE.EdgesGeometry(mesh.geometry);
}
