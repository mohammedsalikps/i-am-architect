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
    // Phase 3A: lightened one step further from the horizon gradient's
    // own darkest tone (see environment.ts) than before, so the plane
    // reads as a distinct site surface at the default "Fit House"
    // distance instead of blending into the background - still the same
    // dark, neutral family, just a clearer step above it rather than
    // nearly matching it.
    color: 0x34363f,
    // Was 0.96 (almost perfectly matte). A real site surface - concrete,
    // packed ground, paving - still has a faint sheen under direct sun;
    // this is a small, deliberate step toward that, not a floor finish.
    // Nowhere near glossy: still far above any value that would produce
    // a visible reflection or a "wet floor" look.
    roughness: 0.85
  });
  const ground = new THREE.Mesh(groundGeometry, groundMaterial);
  ground.rotation.x = -Math.PI / 2; // lay flat on the XZ plane
  ground.receiveShadow = true;
  scene.add(ground);

  const grid = new THREE.GridHelper(GROUND_SIZE, GRID_DIVISIONS, 0x4a4f58, 0x2d2f34);
  const gridMaterial = grid.material as THREE.Material;
  gridMaterial.transparent = true;
  // Was 0.5 - a touch more present now that the ground itself is a
  // little lighter, so the grid doesn't lose the contrast that made it
  // readable before this change.
  gridMaterial.opacity = 0.58;
  grid.position.y = 0.001; // avoid z-fighting with the ground plane
  scene.add(grid);
}
