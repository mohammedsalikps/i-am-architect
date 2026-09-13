import * as THREE from "three";

// Exported so other UI (e.g. the status bar's "Grid size" readout) can
// derive the real grid spacing instead of hardcoding a value that could
// drift out of sync with the actual GridHelper.
export const GROUND_SIZE = 50;
export const GRID_DIVISIONS = 50;

/**
 * Adds a flat ground plane plus a grid overlay - the spatial reference
 * for placing construction elements. The ground receives the sun's
 * shadow (see lights.ts); the grid is drawn with a slight upward offset
 * and reduced opacity so it reads as a quiet reference plane rather than
 * competing with the shadow it sits on top of.
 */
export function addGround(scene: THREE.Scene): void {
  const groundGeometry = new THREE.PlaneGeometry(GROUND_SIZE, GROUND_SIZE);
  const groundMaterial = new THREE.MeshStandardMaterial({
    // Tuned to sit in the same tonal family as the viewport's horizon
    // gradient (see scene/environment.ts) - a touch lighter than the
    // old flat near-black, so the ground reads as a real receiving
    // surface for the sun's shadow rather than a hole in the scene.
    color: 0x2a2c33,
    roughness: 0.96
  });
  const ground = new THREE.Mesh(groundGeometry, groundMaterial);
  ground.rotation.x = -Math.PI / 2; // lay flat on the XZ plane
  ground.receiveShadow = true;
  scene.add(ground);

  const grid = new THREE.GridHelper(GROUND_SIZE, GRID_DIVISIONS, 0x4a4f58, 0x2d2f34);
  const gridMaterial = grid.material as THREE.Material;
  gridMaterial.transparent = true;
  gridMaterial.opacity = 0.5;
  grid.position.y = 0.001; // avoid z-fighting with the ground plane
  scene.add(grid);
}
