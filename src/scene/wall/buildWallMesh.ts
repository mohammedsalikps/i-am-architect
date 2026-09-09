import * as THREE from "three";
import type { WallData } from "../../engine/wall/types";

function buildWallGeometry(wall: WallData): THREE.BoxGeometry {
  return new THREE.BoxGeometry(wall.length, wall.height, wall.thickness);
}

/** Converts wall data into a real, rectangular Three.js mesh. */
export function buildWallMesh(wall: WallData): THREE.Mesh {
  const geometry = buildWallGeometry(wall);
  const material = new THREE.MeshStandardMaterial({ color: wall.color, roughness: 0.9 });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(wall.position.x, wall.position.y, wall.position.z);
  mesh.rotation.y = wall.rotation;
  mesh.userData.wallId = wall.id;

  return mesh;
}

/**
 * Syncs an existing wall mesh with its current data. Rebuilds geometry
 * only when dimensions actually changed, and reports whether it did so
 * the caller can refresh anything derived from the geometry (e.g. a
 * selection outline).
 */
export function applyWallDataToMesh(mesh: THREE.Mesh, wall: WallData): { dimensionsChanged: boolean } {
  const geometry = mesh.geometry as THREE.BoxGeometry;
  const dimensionsChanged =
    geometry.parameters.width !== wall.length ||
    geometry.parameters.height !== wall.height ||
    geometry.parameters.depth !== wall.thickness;

  if (dimensionsChanged) {
    geometry.dispose();
    mesh.geometry = buildWallGeometry(wall);
  }

  mesh.position.set(wall.position.x, wall.position.y, wall.position.z);
  mesh.rotation.y = wall.rotation;

  const material = mesh.material as THREE.MeshStandardMaterial;
  material.color.set(wall.color);

  return { dimensionsChanged };
}
