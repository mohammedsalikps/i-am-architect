import * as THREE from "three";

const OUTLINE_COLOR = 0xffb020; // amber - distinct from the wall's own material color
const OUTLINE_SCALE = 1.02; // slightly larger than the mesh so it reads clearly at any angle

/** Builds a hidden-by-default edge outline as a selection indicator for a wall mesh. */
export function buildWallOutline(mesh: THREE.Mesh): THREE.LineSegments {
  const edges = new THREE.EdgesGeometry(mesh.geometry);
  const material = new THREE.LineBasicMaterial({ color: OUTLINE_COLOR });
  const outline = new THREE.LineSegments(edges, material);
  outline.scale.setScalar(OUTLINE_SCALE);
  outline.visible = false;
  return outline;
}

/** Re-derives the outline geometry after the parent mesh's geometry has been rebuilt. */
export function refreshWallOutline(outline: THREE.LineSegments, mesh: THREE.Mesh): void {
  outline.geometry.dispose();
  outline.geometry = new THREE.EdgesGeometry(mesh.geometry);
}
