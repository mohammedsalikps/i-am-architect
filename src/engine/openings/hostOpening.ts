import type { Vector3Data } from "../objects/types";

/**
 * Wall-hosted doors and windows. A hosted opening records its wall in
 * `hostId` and WHERE it sits in that wall in `hostPlacement` - an offset
 * along the wall from its center and a sill height above the wall's base.
 * That relative placement is the source of truth: the opening's world
 * position and rotation are always derived from its wall's transform
 * (hostedTransform), which is how an opening moves and turns with its
 * wall, and how a saved project restores it exactly.
 *
 * A hosted opening sits centered in the wall's thickness, turned with the
 * wall, and the wall is drawn with a matching hole (see
 * src/scene/wall/buildWallMesh.ts). Everything here is pure math in the
 * engine's convention: meters, +Y up, rotation in radians around Y, a
 * wall's length along its local X = world (cos t, 0, -sin t).
 */

/** Default sill height for a window, above the wall's base, in meters. */
export const WINDOW_SILL_HEIGHT = 0.9;

/** How far beyond half its thickness a wall reaches when picking the wall an opening sits in (findHostWall), in meters. */
export const HOST_REACH = 0.35;

/** Slack for floating-point noise in the fit checks, in meters. */
const EPSILON = 1e-6;

/** Step used when looking for a free spot along a wall, in meters. */
const OFFSET_STEP = 0.05;

export interface HostWall {
  id?: string;
  position: Vector3Data;
  rotation: number;
  dimensions: { length: number; height: number; thickness: number };
}

export interface OpeningSize {
  width: number;
  height: number;
  thickness: number;
}

/** Where a hosted opening sits in its wall. */
export interface HostPlacement {
  /** Along the wall from its center, in meters: positive toward the wall's local +X end. */
  offset: number;
  /** Height of the opening's bottom above the wall's base, in meters. */
  sill: number;
}

/** An opening already in a wall, as the fit checks see it. */
export interface HostedOpening {
  id: string;
  size: OpeningSize;
  placement: HostPlacement;
}

function round(value: number): number {
  const rounded = Math.round(value * 1e9) / 1e9;
  return rounded === 0 ? 0 : rounded;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** The wall's length direction and face normal in plan. */
export function wallAxes(rotation: number): { along: { x: number; z: number }; normal: { x: number; z: number } } {
  return {
    along: { x: Math.cos(rotation), z: -Math.sin(rotation) },
    normal: { x: Math.sin(rotation), z: Math.cos(rotation) }
  };
}

/** The height of the wall's bottom face. */
export function wallBase(wall: HostWall): number {
  return wall.position.y - wall.dimensions.height / 2;
}

/** How far an opening's center can move either way from the wall's center and still lie entirely on the wall. */
export function halfTravel(wall: HostWall, opening: OpeningSize): number {
  return Math.max(0, (wall.dimensions.length - opening.width) / 2);
}

/** An opening's world position and rotation, from its wall and its placement in that wall. */
export function hostedTransform(wall: HostWall, opening: OpeningSize, placement: HostPlacement): { position: Vector3Data; rotation: number } {
  const { along } = wallAxes(wall.rotation);
  return {
    position: {
      x: round(wall.position.x + along.x * placement.offset),
      y: round(wallBase(wall) + placement.sill + opening.height / 2),
      z: round(wall.position.z + along.z * placement.offset)
    },
    rotation: wall.rotation
  };
}

/**
 * The placement in `wall` nearest a world point: the point projected onto
 * the wall's length (clamped so the opening stays on the wall) and - when
 * the point has a height - the sill that puts the opening's center there,
 * clamped to the wall. Without a height, `sill` is kept.
 */
export function placementNear(wall: HostWall, opening: OpeningSize, point: { x: number; y?: number; z: number }, sill: number): HostPlacement {
  const { along } = wallAxes(wall.rotation);
  const travel = halfTravel(wall, opening);
  const projected = (point.x - wall.position.x) * along.x + (point.z - wall.position.z) * along.z;
  const maxSill = Math.max(0, wall.dimensions.height - opening.height);
  const wantedSill = point.y === undefined ? sill : point.y - opening.height / 2 - wallBase(wall);
  return { offset: round(clamp(projected, -travel, travel)), sill: round(clamp(wantedSill, 0, maxSill)) };
}

/** A placement after its wall changed: the same sill, and the offset pulled back onto the wall if the wall got shorter. */
export function clampPlacement(wall: HostWall, opening: OpeningSize, placement: HostPlacement): HostPlacement {
  const travel = halfTravel(wall, opening);
  return { offset: round(clamp(placement.offset, -travel, travel)), sill: placement.sill };
}

/** The placement that reproduces an opening's current world position in `wall` - for openings saved before placements were stored. */
export function placementFromWorld(wall: HostWall, opening: OpeningSize, position: Vector3Data): HostPlacement {
  const { along } = wallAxes(wall.rotation);
  return {
    offset: round((position.x - wall.position.x) * along.x + (position.z - wall.position.z) * along.z),
    sill: round(position.y - opening.height / 2 - wallBase(wall))
  };
}

/**
 * Why `opening` can't sit at `placement` in `wall` - empty when it can.
 * It must fit within the wall's length and height, and must not overlap
 * another opening in the same wall (openings go through the whole wall,
 * so its two faces share them).
 */
export function hostingProblems(
  wall: HostWall,
  opening: { id: string; size: OpeningSize },
  placement: HostPlacement,
  others: readonly HostedOpening[]
): string[] {
  const wallName = wall.id ?? "the wall";
  if (!Number.isFinite(placement.offset) || !Number.isFinite(placement.sill)) {
    return [`${opening.id} needs a finite offset and sill in ${wallName}.`];
  }

  const problems: string[] = [];
  const { width, height } = opening.size;
  if (width > wall.dimensions.length + EPSILON) {
    problems.push(`${opening.id} (${width} m wide) is wider than ${wallName} (${wall.dimensions.length} m long).`);
  } else if (Math.abs(placement.offset) > halfTravel(wall, opening.size) + EPSILON) {
    problems.push(`${opening.id} runs past the end of ${wallName}.`);
  }
  if (placement.sill < -EPSILON) {
    problems.push(`${opening.id} starts below the base of ${wallName}.`);
  }
  if (placement.sill + height > wall.dimensions.height + EPSILON) {
    problems.push(`${opening.id} is taller than ${wallName} allows (sill ${placement.sill} m + ${height} m > ${wall.dimensions.height} m).`);
  }

  for (const other of others) {
    if (other.id === opening.id) {
      continue;
    }
    const alongOverlap = Math.abs(placement.offset - other.placement.offset) < (width + other.size.width) / 2 - EPSILON;
    const heightOverlap =
      placement.sill < other.placement.sill + other.size.height - EPSILON && other.placement.sill < placement.sill + height - EPSILON;
    if (alongOverlap && heightOverlap) {
      problems.push(`${opening.id} overlaps ${other.id} in ${wallName}.`);
    }
  }
  return problems;
}

/**
 * A free offset in `wall` for an opening at `sill`: the wall's center when
 * that's free, otherwise the nearest free spot, searching outward in 5 cm
 * steps (positive side first) - or null when the wall has no room left.
 */
export function findFreeOffset(
  wall: HostWall,
  opening: { id: string; size: OpeningSize },
  sill: number,
  others: readonly HostedOpening[]
): number | null {
  const travel = halfTravel(wall, opening.size);
  const candidates: number[] = [0];
  for (let step = 1; step * OFFSET_STEP <= travel + EPSILON; step += 1) {
    candidates.push(round(step * OFFSET_STEP), round(-step * OFFSET_STEP));
  }
  candidates.push(round(travel), round(-travel));
  for (const offset of candidates) {
    if (Math.abs(offset) <= travel + EPSILON && hostingProblems(wall, opening, { offset, sill }, others).length === 0) {
      return offset;
    }
  }
  return null;
}

/** A hole to leave in a wall, in the wall's own frame: x along its length (-length/2 .. length/2), y up (-height/2 .. height/2). */
export interface WallOpeningRect {
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
}

/** The holes a wall's hosted openings make in it, each clamped to the wall; degenerate ones are dropped. */
export function wallOpeningRects(wall: HostWall, openings: readonly { size: OpeningSize; placement: HostPlacement }[]): WallOpeningRect[] {
  const halfLength = wall.dimensions.length / 2;
  const halfHeight = wall.dimensions.height / 2;
  return openings
    .map(({ size, placement }) => ({
      xMin: round(clamp(placement.offset - size.width / 2, -halfLength, halfLength)),
      xMax: round(clamp(placement.offset + size.width / 2, -halfLength, halfLength)),
      yMin: round(clamp(-halfHeight + placement.sill, -halfHeight, halfHeight)),
      yMax: round(clamp(-halfHeight + placement.sill + size.height, -halfHeight, halfHeight))
    }))
    .filter((rect) => rect.xMax - rect.xMin > EPSILON && rect.yMax - rect.yMin > EPSILON);
}

/**
 * The wall an opening centered at `point` would sit in: a wall whose center
 * plane is within half its thickness plus `reach` of the point, with the
 * point within its length - the nearest such wall, ties broken by id.
 */
export function findHostWall<T extends HostWall & { id: string }>(walls: readonly T[], point: { x: number; z: number }, reach = HOST_REACH): T | undefined {
  let best: { wall: T; distance: number } | undefined;
  for (const wall of walls) {
    const { along, normal } = wallAxes(wall.rotation);
    const dx = point.x - wall.position.x;
    const dz = point.z - wall.position.z;
    const alongDistance = Math.abs(dx * along.x + dz * along.z);
    const planeDistance = Math.abs(dx * normal.x + dz * normal.z);
    if (alongDistance > wall.dimensions.length / 2 + EPSILON || planeDistance > wall.dimensions.thickness / 2 + reach) {
      continue;
    }
    if (!best || planeDistance < best.distance - EPSILON || (Math.abs(planeDistance - best.distance) <= EPSILON && wall.id < best.wall.id)) {
      best = { wall, distance: planeDistance };
    }
  }
  return best?.wall;
}
