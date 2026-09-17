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
    // Viewport-correction: a dark studio-floor/concrete tone, restoring
    // the professional dark CAD workspace (task: "dark concrete/studio
    // floor") - still distinct in both hue and lightness from the
    // background's own darkest tones (environment.ts), so the ground
    // plane still reads as a real surface a building rests on, not part
    // of an undifferentiated black void.
    color: 0x35363b,
    // A real site surface - concrete, packed ground, paving - still has
    // a faint sheen under direct sun; nowhere near glossy or reflective.
    roughness: 0.9
  });
  const ground = new THREE.Mesh(groundGeometry, groundMaterial);
  ground.rotation.x = -Math.PI / 2; // lay flat on the XZ plane
  ground.receiveShadow = true;
  scene.add(ground);

  // Lighter lines than the now-dark ground (the inverse of the previous
  // dark-line/light-ground pairing) so the grid stays visible without
  // dominating the model - still a quiet reference plane (moderate
  // opacity), not a competing grid.
  const grid = new THREE.GridHelper(GROUND_SIZE, GRID_DIVISIONS, 0x6b6d72, 0x4a4c50);
  const gridMaterial = grid.material as THREE.Material;
  gridMaterial.transparent = true;
  gridMaterial.opacity = 0.5;
  grid.position.y = 0.001; // avoid z-fighting with the ground plane
  scene.add(grid);
}
