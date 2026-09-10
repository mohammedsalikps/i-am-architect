// Explicit .ts extensions on these value imports let Node run this file
// directly (the verify suites do). Harmless for Vite.
import { localAxesFor } from "../ai/geometry/analyzeConstructionGeometry.ts";
import { getElementKind } from "../elements/catalog.ts";
import type { Endpoint } from "../elements/types";

/**
 * Object snapping on the horizontal plane - deterministic, and no
 * constraint solver. Every object offers key points: its center, its
 * footprint's corners, and - for a wall or a linear element - its two
 * endpoints (a wall's are the ends of its center line). A moving object
 * snaps, in order of preference:
 *
 * 1. point to point: one of its key points onto another object's, when
 *    they are within SNAP_TOLERANCE - a wall's end onto another wall's
 *    end, a pillar's center onto a wall's corner, a pipe's end onto
 *    another pipe's end
 * 2. alignment: its key points' X and/or Z lined up with another object's
 *    (edges and centers), each axis independently, within the tolerance
 * 3. the grid: its center onto the SNAP_GRID
 *
 * Ties are broken by distance, then point kind (endpoint, corner,
 * center), then object id - so the same drag always snaps the same way.
 * Heights never change: snapping is a plan-view aid.
 */

export const SNAP_TOLERANCE = 0.3;
export const SNAP_GRID = 0.1;

export type SnapPointKind = "endpoint" | "corner" | "center";

export interface SnapObject {
  id: string;
  type: string;
  kind?: string;
  position: { x: number; y: number; z: number };
  rotation: number;
  dimensions: Record<string, number>;
}

export interface SnapPoint {
  x: number;
  z: number;
  objectId: string;
  kind: SnapPointKind;
  /** For an endpoint: which one. */
  endpoint?: Endpoint;
}

export interface SnapResult {
  position: { x: number; y: number; z: number };
  mode: "point" | "align" | "grid" | "none";
  /** What it snapped to, for point snapping (and the X target for alignment). */
  target: SnapPoint | null;
}

const KIND_RANK: Record<SnapPointKind, number> = { endpoint: 0, corner: 1, center: 2 };

function round(value: number): number {
  const rounded = Math.round(value * 1e9) / 1e9;
  return rounded === 0 ? 0 : rounded;
}

/** An object's key points in world X/Z: endpoints first (walls and linear elements), then corners, then its center. */
export function keyPointsOf(object: SnapObject): SnapPoint[] {
  const center: SnapPoint = { x: object.position.x, z: object.position.z, objectId: object.id, kind: "center" };
  const axes = localAxesFor(object.type, object.kind);
  if (!axes) {
    return [center];
  }
  const halfX = (object.dimensions[axes.x] ?? 0) / 2;
  const halfZ = (object.dimensions[axes.z] ?? 0) / 2;
  const cos = Math.cos(object.rotation);
  const sin = Math.sin(object.rotation);
  // Local X is world (cos, -sin); local Z is world (sin, cos).
  const at = (localX: number, localZ: number) => ({
    x: round(object.position.x + localX * cos + localZ * sin),
    z: round(object.position.z - localX * sin + localZ * cos)
  });

  const points: SnapPoint[] = [];
  const linear = object.type === "element" && !!object.kind && !!getElementKind(object.kind)?.linear;
  if (linear || object.type === "wall") {
    points.push({ ...at(-halfX, 0), objectId: object.id, kind: "endpoint", endpoint: "start" });
    points.push({ ...at(halfX, 0), objectId: object.id, kind: "endpoint", endpoint: "end" });
  }
  if (!linear) {
    for (const [signX, signZ] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      points.push({ ...at(signX * halfX, signZ * halfZ), objectId: object.id, kind: "corner" });
    }
  }
  points.push(center);
  return points;
}

/** Whether `a` beats `b` as a snap target at distances `da` and `db`. */
function better(da: number, a: SnapPoint, db: number, b: SnapPoint): boolean {
  if (Math.abs(da - db) > 1e-9) {
    return da < db;
  }
  if (KIND_RANK[a.kind] !== KIND_RANK[b.kind]) {
    return KIND_RANK[a.kind] < KIND_RANK[b.kind];
  }
  return a.objectId < b.objectId;
}

/** The target point nearest `point`, within `tolerance` - or null. */
export function snapPoint(point: { x: number; z: number }, targets: readonly SnapPoint[], tolerance = SNAP_TOLERANCE): SnapPoint | null {
  let best: { target: SnapPoint; distance: number } | null = null;
  for (const target of targets) {
    const distance = Math.hypot(target.x - point.x, target.z - point.z);
    if (distance <= tolerance && (!best || better(distance, target, best.distance, best.target))) {
      best = { target, distance };
    }
  }
  return best?.target ?? null;
}

/** Rounds a coordinate onto the grid. */
export function toGrid(value: number, grid = SNAP_GRID): number {
  return grid > 0 ? round(Math.round(value / grid) * grid) : value;
}

/**
 * Where a moving object at `candidate` snaps among `others` - see the
 * module doc for the order. Only X and Z ever change.
 */
export function snapMove(
  moving: SnapObject,
  candidate: { x: number; y: number; z: number },
  others: readonly SnapObject[],
  options: { tolerance?: number; grid?: number } = {}
): SnapResult {
  const tolerance = options.tolerance ?? SNAP_TOLERANCE;
  const grid = options.grid ?? SNAP_GRID;
  const own = keyPointsOf({ ...moving, position: candidate });
  const targets = others.filter((other) => other.id !== moving.id).flatMap(keyPointsOf);

  // 1. Point to point.
  let best: { ownPoint: SnapPoint; target: SnapPoint; distance: number } | null = null;
  for (const ownPoint of own) {
    for (const target of targets) {
      const distance = Math.hypot(target.x - ownPoint.x, target.z - ownPoint.z);
      if (distance <= tolerance && (!best || better(distance, target, best.distance, best.target))) {
        best = { ownPoint, target, distance };
      }
    }
  }
  if (best) {
    return {
      position: {
        x: round(candidate.x + best.target.x - best.ownPoint.x),
        y: candidate.y,
        z: round(candidate.z + best.target.z - best.ownPoint.z)
      },
      mode: "point",
      target: best.target
    };
  }

  // 2. Alignment, each axis on its own.
  let alignX: { delta: number; target: SnapPoint } | null = null;
  let alignZ: { delta: number; target: SnapPoint } | null = null;
  for (const ownPoint of own) {
    for (const target of targets) {
      const dx = target.x - ownPoint.x;
      const dz = target.z - ownPoint.z;
      if (Math.abs(dx) <= tolerance && (!alignX || better(Math.abs(dx), target, Math.abs(alignX.delta), alignX.target))) {
        alignX = { delta: dx, target };
      }
      if (Math.abs(dz) <= tolerance && (!alignZ || better(Math.abs(dz), target, Math.abs(alignZ.delta), alignZ.target))) {
        alignZ = { delta: dz, target };
      }
    }
  }
  if (alignX || alignZ) {
    return {
      position: {
        x: alignX ? round(candidate.x + alignX.delta) : toGrid(candidate.x, grid),
        y: candidate.y,
        z: alignZ ? round(candidate.z + alignZ.delta) : toGrid(candidate.z, grid)
      },
      mode: "align",
      target: (alignX ?? alignZ)?.target ?? null
    };
  }

  // 3. The grid.
  if (grid > 0) {
    return { position: { x: toGrid(candidate.x, grid), y: candidate.y, z: toGrid(candidate.z, grid) }, mode: "grid", target: null };
  }
  return { position: { ...candidate }, mode: "none", target: null };
}
