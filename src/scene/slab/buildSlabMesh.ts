import * as THREE from "three";
import type { SlabData } from "../../engine/slab/types";

// length -> local X, thickness -> local Y, width -> local Z, matching
// THREE.BoxGeometry's own (width, height, depth) parameter order.
function buildSlabGeometry(slab: SlabData): THREE.BoxGeometry {
  return new THREE.BoxGeometry(slab.dimensions.length, slab.dimensions.thickness, slab.dimensions.width);
}

/** Converts slab data into a real, rectangular-prism Three.js mesh - mirrors buildWallMesh.ts/buildPillarMesh.ts/buildBeamMesh.ts exactly. */
export function buildSlabMesh(slab: SlabData): THREE.Mesh {
  const geometry = buildSlabGeometry(slab);
  const material = new THREE.MeshStandardMaterial({ color: slab.color, roughness: 0.9 });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(slab.position.x, slab.position.y, slab.position.z);
  mesh.rotation.y = slab.rotation;
  // objectId (not slabId): SelectionRaycaster reads this same field on
  // every selectable mesh regardless of construction-object type.
  mesh.userData.objectId = slab.id;

  return mesh;
}

/**
 * Syncs an existing slab mesh with its current data. Rebuilds geometry
 * only when dimensions actually changed, and reports whether it did so
 * the caller can refresh anything derived from the geometry (e.g. a
 * selection outline).
 */
export function applySlabDataToMesh(mesh: THREE.Mesh, slab: SlabData): { dimensionsChanged: boolean } {
  const geometry = mesh.geometry as THREE.BoxGeometry;
  const dimensionsChanged =
    geometry.parameters.width !== slab.dimensions.length ||
    geometry.parameters.height !== slab.dimensions.thickness ||
    geometry.parameters.depth !== slab.dimensions.width;

  if (dimensionsChanged) {
    geometry.dispose();
    mesh.geometry = buildSlabGeometry(slab);
  }

  mesh.position.set(slab.position.x, slab.position.y, slab.position.z);
  mesh.rotation.y = slab.rotation;

  const material = mesh.material as THREE.MeshStandardMaterial;
  material.color.set(slab.color);

  return { dimensionsChanged };
}
