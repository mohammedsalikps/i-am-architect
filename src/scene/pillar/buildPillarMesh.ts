import * as THREE from "three";
import type { PillarData } from "../../engine/pillar/types";
import { resolveSurfaceAppearance } from "../materials/surfaceAppearance";

function buildPillarGeometry(pillar: PillarData): THREE.BoxGeometry {
  return new THREE.BoxGeometry(pillar.dimensions.width, pillar.dimensions.height, pillar.dimensions.depth);
}

/** Converts pillar data into a real, rectangular-prism Three.js mesh - mirrors buildWallMesh.ts exactly. */
export function buildPillarMesh(pillar: PillarData): THREE.Mesh {
  const geometry = buildPillarGeometry(pillar);
  const appearance = resolveSurfaceAppearance(pillar.material, { roughness: 0.9 });
  const material = new THREE.MeshStandardMaterial({
    color: pillar.color,
    roughness: appearance.roughness,
    metalness: appearance.metalness,
    transparent: appearance.opacity < 1,
    opacity: appearance.opacity,
    depthWrite: appearance.opacity >= 1
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(pillar.position.x, pillar.position.y, pillar.position.z);
  mesh.rotation.y = pillar.rotation;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
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
  const appearance = resolveSurfaceAppearance(pillar.material, { roughness: 0.9 });
  material.roughness = appearance.roughness;
  material.metalness = appearance.metalness;
  material.opacity = appearance.opacity;
  material.transparent = appearance.opacity < 1;
  material.depthWrite = appearance.opacity >= 1;

  return { dimensionsChanged };
}
