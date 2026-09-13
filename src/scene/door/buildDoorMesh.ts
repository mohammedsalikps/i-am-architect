import * as THREE from "three";
import type { DoorData } from "../../engine/door/types";
import { resolveSurfaceAppearance } from "../materials/surfaceAppearance";

// width -> local X, height -> local Y, thickness -> local Z, matching
// THREE.BoxGeometry's own (width, height, depth) parameter order.
function buildDoorGeometry(door: DoorData): THREE.BoxGeometry {
  return new THREE.BoxGeometry(door.dimensions.width, door.dimensions.height, door.dimensions.thickness);
}

/** Converts door data into a real, rectangular-panel Three.js mesh - mirrors buildWallMesh.ts/buildBeamMesh.ts/buildSlabMesh.ts exactly. */
export function buildDoorMesh(door: DoorData): THREE.Mesh {
  const geometry = buildDoorGeometry(door);
  const appearance = resolveSurfaceAppearance(door.material, { roughness: 0.8 });
  const material = new THREE.MeshStandardMaterial({
    color: door.color,
    roughness: appearance.roughness,
    metalness: appearance.metalness,
    transparent: appearance.opacity < 1,
    opacity: appearance.opacity,
    depthWrite: appearance.opacity >= 1
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(door.position.x, door.position.y, door.position.z);
  mesh.rotation.y = door.rotation;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  // objectId (not doorId): SelectionRaycaster reads this same field on
  // every selectable mesh regardless of construction-object type.
  mesh.userData.objectId = door.id;

  return mesh;
}

/**
 * Syncs an existing door mesh with its current data. Rebuilds geometry
 * only when dimensions actually changed, and reports whether it did so
 * the caller can refresh anything derived from the geometry (e.g. a
 * selection outline).
 */
export function applyDoorDataToMesh(mesh: THREE.Mesh, door: DoorData): { dimensionsChanged: boolean } {
  const geometry = mesh.geometry as THREE.BoxGeometry;
  const dimensionsChanged =
    geometry.parameters.width !== door.dimensions.width ||
    geometry.parameters.height !== door.dimensions.height ||
    geometry.parameters.depth !== door.dimensions.thickness;

  if (dimensionsChanged) {
    geometry.dispose();
    mesh.geometry = buildDoorGeometry(door);
  }

  mesh.position.set(door.position.x, door.position.y, door.position.z);
  mesh.rotation.y = door.rotation;

  const material = mesh.material as THREE.MeshStandardMaterial;
  material.color.set(door.color);
  const appearance = resolveSurfaceAppearance(door.material, { roughness: 0.8 });
  material.roughness = appearance.roughness;
  material.metalness = appearance.metalness;
  material.opacity = appearance.opacity;
  material.transparent = appearance.opacity < 1;
  material.depthWrite = appearance.opacity >= 1;

  return { dimensionsChanged };
}
