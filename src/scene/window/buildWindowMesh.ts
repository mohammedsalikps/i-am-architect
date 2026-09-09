import * as THREE from "three";
import type { WindowData } from "../../engine/window/types";

// width -> local X, height -> local Y, thickness -> local Z, matching
// THREE.BoxGeometry's own (width, height, depth) parameter order.
function buildWindowGeometry(windowData: WindowData): THREE.BoxGeometry {
  return new THREE.BoxGeometry(windowData.dimensions.width, windowData.dimensions.height, windowData.dimensions.thickness);
}

/** Converts window data into a real, rectangular-panel Three.js mesh - mirrors buildDoorMesh.ts/buildWallMesh.ts exactly. */
export function buildWindowMesh(windowData: WindowData): THREE.Mesh {
  const geometry = buildWindowGeometry(windowData);
  const material = new THREE.MeshStandardMaterial({ color: windowData.color, roughness: 0.3, metalness: 0.1 });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(windowData.position.x, windowData.position.y, windowData.position.z);
  mesh.rotation.y = windowData.rotation;
  // objectId (not windowId): SelectionRaycaster reads this same field
  // on every selectable mesh regardless of construction-object type.
  mesh.userData.objectId = windowData.id;

  return mesh;
}

/**
 * Syncs an existing window mesh with its current data. Rebuilds
 * geometry only when dimensions actually changed, and reports whether
 * it did so the caller can refresh anything derived from the geometry
 * (e.g. a selection outline).
 */
export function applyWindowDataToMesh(mesh: THREE.Mesh, windowData: WindowData): { dimensionsChanged: boolean } {
  const geometry = mesh.geometry as THREE.BoxGeometry;
  const dimensionsChanged =
    geometry.parameters.width !== windowData.dimensions.width ||
    geometry.parameters.height !== windowData.dimensions.height ||
    geometry.parameters.depth !== windowData.dimensions.thickness;

  if (dimensionsChanged) {
    geometry.dispose();
    mesh.geometry = buildWindowGeometry(windowData);
  }

  mesh.position.set(windowData.position.x, windowData.position.y, windowData.position.z);
  mesh.rotation.y = windowData.rotation;

  const material = mesh.material as THREE.MeshStandardMaterial;
  material.color.set(windowData.color);

  return { dimensionsChanged };
}
