import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { WallData } from "../../engine/wall/types";
import type { WallOpeningRect } from "../../engine/openings/hostOpening";
import { resolveSurfaceAppearance } from "../materials/surfaceAppearance";

/**
 * A wall's geometry: a plain box - or, when doors or windows are hosted in
 * it, the same box with a real rectangular hole for each (see
 * wallOpeningRects() in engine/openings/hostOpening.ts). The holed wall is
 * built from solid boxes: the wall is split into columns at every
 * opening's sides, and each column keeps the parts no opening covers. No
 * boolean/CSG library, and the wall stays one mesh for picking.
 */
function buildWallGeometry(wall: WallData, openings: readonly WallOpeningRect[]): THREE.BufferGeometry {
  if (openings.length === 0) {
    return new THREE.BoxGeometry(wall.dimensions.length, wall.dimensions.height, wall.dimensions.thickness);
  }

  const { length, height, thickness } = wall.dimensions;
  const halfLength = length / 2;
  const halfHeight = height / 2;
  const edges = [...new Set([-halfLength, halfLength, ...openings.flatMap((rect) => [rect.xMin, rect.xMax])])].sort((a, b) => a - b);

  const pieces: THREE.BufferGeometry[] = [];
  const addPiece = (x0: number, x1: number, y0: number, y1: number): void => {
    if (x1 - x0 <= 1e-6 || y1 - y0 <= 1e-6) {
      return;
    }
    const piece = new THREE.BoxGeometry(x1 - x0, y1 - y0, thickness);
    piece.translate((x0 + x1) / 2, (y0 + y1) / 2, 0);
    pieces.push(piece);
  };

  for (let index = 0; index < edges.length - 1; index += 1) {
    const x0 = edges[index];
    const x1 = edges[index + 1];
    const middle = (x0 + x1) / 2;
    const holes = openings.filter((rect) => rect.xMin < middle && rect.xMax > middle).sort((a, b) => a.yMin - b.yMin);
    let y = -halfHeight;
    for (const hole of holes) {
      addPiece(x0, x1, y, hole.yMin);
      y = Math.max(y, hole.yMax);
    }
    addPiece(x0, x1, y, halfHeight);
  }

  if (pieces.length === 0) {
    // Fully open - keep a sliver so the wall stays pickable.
    return new THREE.BoxGeometry(length, 0.001, thickness);
  }
  const merged = mergeGeometries(pieces);
  for (const piece of pieces) {
    piece.dispose();
  }
  return merged ?? new THREE.BoxGeometry(length, height, thickness);
}

function geometryKey(wall: WallData, openings: readonly WallOpeningRect[]): string {
  return JSON.stringify([wall.dimensions.length, wall.dimensions.height, wall.dimensions.thickness, openings]);
}

/** Converts wall data - and the openings hosted in it - into a real Three.js mesh. */
export function buildWallMesh(wall: WallData, openings: readonly WallOpeningRect[] = []): THREE.Mesh {
  const geometry = buildWallGeometry(wall, openings);
  const appearance = resolveSurfaceAppearance(wall.material, { roughness: 0.9 });
  const material = new THREE.MeshStandardMaterial({
    color: wall.color,
    roughness: appearance.roughness,
    metalness: appearance.metalness,
    transparent: appearance.opacity < 1,
    opacity: appearance.opacity,
    depthWrite: appearance.opacity >= 1
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(wall.position.x, wall.position.y, wall.position.z);
  mesh.rotation.y = wall.rotation;
  // A wall both casts a shadow (onto the floor and other walls) and
  // receives one (from a roof, a beam, another wall) - see lights.ts for
  // the shadow-casting sun.
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  // objectId (not wallId): SelectionRaycaster reads this same field on
  // every selectable mesh regardless of construction-object type, so it
  // can raycast walls and pillars together without type-specific cases.
  mesh.userData.objectId = wall.id;
  mesh.userData.geometryKey = geometryKey(wall, openings);

  return mesh;
}

/**
 * Syncs an existing wall mesh with its current data and openings.
 * Rebuilds geometry only when the size or the openings actually changed,
 * and reports whether the wall's size did, so the caller can refresh its
 * selection outline.
 */
export function applyWallDataToMesh(
  mesh: THREE.Mesh,
  wall: WallData,
  openings: readonly WallOpeningRect[] = []
): { dimensionsChanged: boolean } {
  const key = geometryKey(wall, openings);
  const previous = mesh.userData.geometryKey as string | undefined;
  const dimensionsChanged =
    !previous || JSON.stringify(JSON.parse(previous).slice(0, 3)) !== JSON.stringify([wall.dimensions.length, wall.dimensions.height, wall.dimensions.thickness]);

  if (key !== previous) {
    mesh.geometry.dispose();
    mesh.geometry = buildWallGeometry(wall, openings);
    mesh.userData.geometryKey = key;
  }

  mesh.position.set(wall.position.x, wall.position.y, wall.position.z);
  mesh.rotation.y = wall.rotation;

  const material = mesh.material as THREE.MeshStandardMaterial;
  material.color.set(wall.color);
  const appearance = resolveSurfaceAppearance(wall.material, { roughness: 0.9 });
  material.roughness = appearance.roughness;
  material.metalness = appearance.metalness;
  material.opacity = appearance.opacity;
  material.transparent = appearance.opacity < 1;
  material.depthWrite = appearance.opacity >= 1;

  return { dimensionsChanged };
}
