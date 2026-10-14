import * as THREE from "three";
import { SCENE_PALETTES } from "./sceneTheme.ts";
import type { ScenePalette } from "./sceneTheme.ts";

/** The ground plane's side, metres - the extended workspace, well beyond any plot (a 30 m × 40 m plot sits inside it with room to spare). */
export const GROUND_SIZE = 200;
/** Major grid lines, every this many metres - landmarks at any spacing. */
export const MAJOR_GRID_SPACING = 5;
/** The minor grid's default spacing, metres (WorkspaceSettings can change it). */
export const DEFAULT_GRID_SPACING = 1;

/**
 * How far the minor grid reaches from the origin, metres: finer grids are
 * drawn over a smaller area, so a 0.1 m grid isn't a grey blur at the
 * horizon (and isn't thousands of lines the GPU draws for nothing).
 */
export function minorGridExtent(spacing: number): number {
  return Math.max(20, Math.min(100, spacing * 400));
}

/**
 * The minor grid for a spacing: an even number of whole cells, each
 * exactly `spacing` wide, centred on the origin - so a line lies on every
 * multiple of the spacing, (0, 0) included, whatever spacing was chosen.
 */
export function minorGrid(spacing: number): { size: number; divisions: number } {
  const half = Math.max(1, Math.round(minorGridExtent(spacing) / spacing / 2));
  return { size: 2 * half * spacing, divisions: 2 * half };
}

export interface GroundHandle {
  /** Recolours the ground and grid for a theme (scene/sceneTheme.ts). */
  setPalette(palette: ScenePalette): void;
  /** The minor grid's spacing, metres. The ground and every object stay exactly where they are. */
  setSpacing(spacing: number): void;
}

/**
 * Adds a flat ground plane plus the workspace grid - the spatial reference
 * for placing construction elements. Two grids, both centred on the
 * origin so a line runs through (0, 0) and every multiple of the spacing:
 * a minor grid at the chosen spacing (1 m by default), and a major grid
 * every 5 m across the whole ground. The plot (the site) is NOT this grid
 * - it is a real element of the model, drawn by the element layer and
 * outlined by siteOverlay.ts.
 *
 * The ground receives the sun's shadow (see lights.ts); the grids are
 * drawn just above it, partly transparent, so they read as a quiet
 * reference plane. GridHelper bakes its colours into the geometry, so a
 * theme or spacing change rebuilds the grids.
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

  let colors = palette;
  let spacing = DEFAULT_GRID_SPACING;
  let grids: THREE.GridHelper[] = [];
  const buildGrids = (): void => {
    for (const grid of grids) {
      scene.remove(grid);
      grid.geometry.dispose();
      (grid.material as THREE.Material).dispose();
    }
    const cells = minorGrid(spacing);
    const minor = new THREE.GridHelper(cells.size, cells.divisions, colors.gridMinor, colors.gridMinor);
    const major = new THREE.GridHelper(GROUND_SIZE, Math.round(GROUND_SIZE / MAJOR_GRID_SPACING), colors.gridMajor, colors.gridMajor);
    grids = [minor, major];
    minor.name = "workspace-grid-minor";
    major.name = "workspace-grid-major";
    minor.userData.spacing = spacing;
    major.userData.spacing = MAJOR_GRID_SPACING;
    for (const [index, grid] of grids.entries()) {
      const material = grid.material as THREE.Material;
      material.transparent = true;
      material.opacity = index === 0 ? colors.gridOpacity * 0.8 : colors.gridOpacity;
      material.depthWrite = false;
      grid.position.y = 0.001 + index * 0.001; // avoid z-fighting with the ground plane and each other
      grid.userData.excludeFromAO = true;
      scene.add(grid);
    }
  };
  buildGrids();

  return {
    setPalette(next) {
      colors = next;
      groundMaterial.color.setHex(next.ground);
      buildGrids();
    },
    setSpacing(next) {
      if (!(next > 0) || next === spacing) return;
      spacing = next;
      buildGrids();
    }
  };
}
