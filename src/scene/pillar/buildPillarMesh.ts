import * as THREE from "three";
import type { PillarData } from "../../engine/pillar/types";

function buildPillarGeometry(pillar: PillarData): THREE.BoxGeometry {
  return new THREE.BoxGeometry(pillar.dimensions.width, pillar.dimensions.height, pillar.dimensions.depth);
}

/** Converts pillar data into a real, rectangular-prism Three.js mesh - mirrors buildWallMesh.ts exactly. */
export function buildPillarMesh(pillar: PillarData): THREE.Mesh {
  const geometry = buildPillarGeometry(pillar);
  const material = new THREE.MeshStandardMaterial({ color: pillar.color, roughness: 0.9 });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(pillar.position.x, pillar.position.y, pillar.position.z);
  mesh.rotation.y = pillar.rotation;
  // objectId (not pillarId): SelectionRaycaster reads this same field on
  // every selectable mesh regardless of construction-object type.
  mesh.userData.objectId = pillar.id;

  return mesh;
}

/**
 * Syncs an existing pillar mesh with its current data. Rebuilds
 * geometry only when dimensions actually changed, and reports whether
 * it did so the caller can refresh anything derived from the geometry
 * (e.g. a selection outline).
 */
export function applyPillarDataToMesh(mesh: THREE.Mesh, pillar: PillarData): { dimensionsChanged: boolean } {
  const geometry = mesh.geometry as THREE.BoxGeometry;
  const dimensionsChanged =
    geometry.parameters.width !== pillar.dimensions.width ||
    geometry.parameters.height !== pillar.dimensions.height ||
    geometry.parameters.depth !== pillar.dimensions.depth;

  if (dimensionsChanged) {
    geometry.dispose();
    mesh.geometry = buildPillarGeometry(pillar);
  }

  mesh.position.set(pillar.position.x, pillar.position.y, pillar.position.z);
  mesh.rotation.y = pillar.rotation;

  const material = mesh.material as THREE.MeshStandardMaterial;
  material.color.set(pillar.color);

  return { dimensionsChanged };
}
