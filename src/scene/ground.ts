import * as THREE from "three";

// Exported so other UI (e.g. the status bar's "Grid size" readout) can
// derive the real grid spacing instead of hardcoding a value that could
// drift out of sync with the actual GridHelper.
export const GROUND_SIZE = 50;
export const GRID_DIVISIONS = 50;

/**
 * Adds a flat ground plane plus a grid overlay, used as the spatial
 * reference for placing construction elements in later milestones.
 */
export function addGround(scene: THREE.Scene): void {
  const groundGeometry = new THREE.PlaneGeometry(GROUND_SIZE, GROUND_SIZE);
  const groundMaterial = new THREE.MeshStandardMaterial({
    color: 0x2b2b2b,
    roughness: 1
  });
  const ground = new THREE.Mesh(groundGeometry, groundMaterial);
  ground.rotation.x = -Math.PI / 2; // lay flat on the XZ plane
  scene.add(ground);

  const grid = new THREE.GridHelper(GROUND_SIZE, GRID_DIVISIONS, 0x666666, 0x3a3a3a);
  scene.add(grid);
}
