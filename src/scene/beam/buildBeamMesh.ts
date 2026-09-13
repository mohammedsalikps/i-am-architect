import * as THREE from "three";
import type { BeamData } from "../../engine/beam/types";
import { resolveSurfaceAppearance } from "../materials/surfaceAppearance";

// length -> local X, height -> local Y, width -> local Z, matching
// THREE.BoxGeometry's own (width, height, depth) parameter order.
function buildBeamGeometry(beam: BeamData): THREE.BoxGeometry {
  return new THREE.BoxGeometry(beam.dimensions.length, beam.dimensions.height, beam.dimensions.width);
}

/** Converts beam data into a real, rectangular-prism Three.js mesh - mirrors buildWallMesh.ts/buildPillarMesh.ts exactly. */
export function buildBeamMesh(beam: BeamData): THREE.Mesh {
  const geometry = buildBeamGeometry(beam);
  const appearance = resolveSurfaceAppearance(beam.material, { roughness: 0.9 });
  const material = new THREE.MeshStandardMaterial({
    color: beam.color,
    roughness: appearance.roughness,
    metalness: appearance.metalness,
    transparent: appearance.opacity < 1,
    opacity: appearance.opacity,
    depthWrite: appearance.opacity >= 1
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(beam.position.x, beam.position.y, beam.position.z);
  mesh.rotation.y = beam.rotation;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  // objectId (not beamId): SelectionRaycaster reads this same field on
  // every selectable mesh regardless of construction-object type.
  mesh.userData.objectId = beam.id;

  return mesh;
}

/**
 * Syncs an existing beam mesh with its current data. Rebuilds geometry
 * only when dimensions actually changed, and reports whether it did so
 * the caller can refresh anything derived from the geometry (e.g. a
 * selection outline).
 */
export function applyBeamDataToMesh(mesh: THREE.Mesh, beam: BeamData): { dimensionsChanged: boolean } {
  const geometry = mesh.geometry as THREE.BoxGeometry;
  const dimensionsChanged =
    geometry.parameters.width !== beam.dimensions.length ||
    geometry.parameters.height !== beam.dimensions.height ||
    geometry.parameters.depth !== beam.dimensions.width;

  if (dimensionsChanged) {
    geometry.dispose();
    mesh.geometry = buildBeamGeometry(beam);
  }

  mesh.position.set(beam.position.x, beam.position.y, beam.position.z);
  mesh.rotation.y = beam.rotation;

  const material = mesh.material as THREE.MeshStandardMaterial;
  material.color.set(beam.color);
  const appearance = resolveSurfaceAppearance(beam.material, { roughness: 0.9 });
  material.roughness = appearance.roughness;
  material.metalness = appearance.metalness;
  material.opacity = appearance.opacity;
  material.transparent = appearance.opacity < 1;
  material.depthWrite = appearance.opacity >= 1;

  return { dimensionsChanged };
}
