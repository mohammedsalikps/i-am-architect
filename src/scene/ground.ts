import * as THREE from "three";
import { SCENE_PALETTES } from "./sceneTheme";
import type { ScenePalette } from "./sceneTheme";

// Exported so other UI (e.g. the status bar's "Grid size" readout) can
// derive the real grid spacing instead of hardcoding a value that could
// drift out of sync with the actual GridHelper.
export const GROUND_SIZE = 50;
export const GRID_DIVISIONS = 50;

export interface GroundHandle {
  /** Recolours the ground and grid for a theme (scene/sceneTheme.ts). */
  setPalette(palette: ScenePalette): void;
}

/**
 * Adds a flat ground plane plus a grid overlay - the spatial reference
 * for placing construction elements. The ground receives the sun's
 * shadow (see lights.ts); the grid is drawn with a slight upward offset
 * and reduced opacity so it reads as a quiet reference plane rather than
 * competing with the shadow it sits on top of. Both take their colours
 * from the theme's palette; GridHelper bakes its colours into the
 * geometry, so a theme change rebuilds the grid.
 */
export function addGround(scene: THREE.Scene, palette: ScenePalette = SCENE_PALETTES.light): GroundHandle {
  const groundGeometry = new THREE.PlaneGeometry(GROUND_SIZE, GROUND_SIZE);
  const groundMaterial = new THREE.MeshStandardMaterial({
    color: palette.ground,
    // A real site surface - concrete, packed ground, paving - still has
    // a faint sheen under direct sun; nowhere near glossy or reflective.
    roughness: 0.9
  });
  const ground = new THREE.Mesh(groundGeometry, groundMaterial);
  ground.rotation.x = -Math.PI / 2; // lay flat on the XZ plane
  ground.receiveShadow = true;
  scene.add(ground);

  let grid: THREE.GridHelper | null = null;
  const buildGrid = (colors: ScenePalette): void => {
    if (grid) {
      scene.remove(grid);
      grid.geometry.dispose();
      (grid.material as THREE.Material).dispose();
    }
    grid = new THREE.GridHelper(GROUND_SIZE, GRID_DIVISIONS, colors.gridMajor, colors.gridMinor);
    const gridMaterial = grid.material as THREE.Material;
    gridMaterial.transparent = true;
    gridMaterial.opacity = colors.gridOpacity;
    grid.position.y = 0.001; // avoid z-fighting with the ground plane
    scene.add(grid);
  };
  buildGrid(palette);

  return {
    setPalette(next) {
      groundMaterial.color.setHex(next.ground);
      buildGrid(next);
    }
  };
}
