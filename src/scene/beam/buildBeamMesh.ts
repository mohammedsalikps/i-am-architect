import * as THREE from "three";
import type { BeamData } from "../../engine/beam/types";

// length -> local X, height -> local Y, width -> local Z, matching
// THREE.BoxGeometry's own (width, height, depth) parameter order.
function buildBeamGeometry(beam: BeamData): THREE.BoxGeometry {
  return new THREE.BoxGeometry(beam.dimensions.length, beam.dimensions.height, beam.dimensions.width);
}

/** Converts beam data into a real, rectangular-prism Three.js mesh - mirrors buildWallMesh.ts/buildPillarMesh.ts exactly. */
export function buildBeamMesh(beam: BeamData): THREE.Mesh {
  const geometry = buildBeamGeometry(beam);
  const material = new THREE.MeshStandardMaterial({ color: beam.color, roughness: 0.9 });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(beam.position.x, beam.position.y, beam.position.z);
  mesh.rotation.y = beam.rotation;
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

  return { dimensionsChanged };
}
