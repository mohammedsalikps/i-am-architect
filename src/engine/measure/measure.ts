// Explicit .ts extensions on these value imports let Node run this file
// directly (measure/verify.ts does). Harmless for Vite.
import { keyPointsOf, snapPoint, toGrid } from "../snapping/snapping.ts";
import type { SnapObject, SnapPointKind } from "../snapping/snapping";

/**
 * The viewport's Measure tool, as plain data: two clicked points on the
 * ground plane and the plan distance between them. Nothing here touches
 * the model - measuring never creates, changes or records anything.
 *
 * A click snaps the same way a dragged object does (snapping.ts): onto an
 * object's endpoint, corner or centre within SNAP_TOLERANCE, otherwise
 * onto the snap-step grid (0.1 m unless the workspace changed it) - or,
 * with Snap off, stays exactly where clicked.
 * Distances are horizontal (plan) distances only; heights aren't
 * measured.
 */

/** What a measured point landed on: an object's key point, the grid, or nothing (Snap off). */
export type MeasureSnap = SnapPointKind | "grid" | "free";

export interface MeasurePoint {
  x: number;
  z: number;
  snap: MeasureSnap;
  /** The object whose key point it snapped to. */
  objectId?: string;
}

export interface Measurement {
  /** Plan distance, metres. */
  distance: number;
  /** Signed run along X (east positive) and Z (south positive), metres. */
  dx: number;
  dz: number;
}

/** Where a measuring click at `raw` lands among `objects`. */
export function snapMeasurePoint(raw: { x: number; z: number }, objects: readonly SnapObject[], snapping: boolean, step?: number): MeasurePoint {
  if (!snapping) {
    return { x: raw.x, z: raw.z, snap: "free" };
  }
  const target = snapPoint(raw, objects.flatMap(keyPointsOf));
  if (target) {
    return { x: target.x, z: target.z, snap: target.kind, objectId: target.objectId };
  }
  // The workspace's snap step (0.1 m unless it was changed).
  return { x: toGrid(raw.x, step), z: toGrid(raw.z, step), snap: "grid" };
}

export function measureBetween(a: { x: number; z: number }, b: { x: number; z: number }): Measurement {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  return { distance: Math.hypot(dx, dz), dx, dz };
}

/** "4.23 m", to the centimetre. */
export function formatMetres(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  return `${rounded === 0 ? 0 : rounded} m`;
}

/**
 * "4.23 m (4 m east, 1.38 m south)" - the distance, then its run along
 * each compass axis (east is +X, south is +Z, as everywhere else in the
 * app). A run under half a centimetre is left out.
 */
export function describeMeasurement(measurement: Measurement): string {
  const runs: { length: number; direction: string }[] = [];
  if (Math.abs(measurement.dx) >= 0.005) runs.push({ length: Math.abs(measurement.dx), direction: measurement.dx > 0 ? "east" : "west" });
  if (Math.abs(measurement.dz) >= 0.005) runs.push({ length: Math.abs(measurement.dz), direction: measurement.dz > 0 ? "south" : "north" });
  const total = formatMetres(measurement.distance);
  if (runs.length === 2) return `${total} (${runs.map((run) => `${formatMetres(run.length)} ${run.direction}`).join(", ")})`;
  return runs.length === 1 ? `${total} ${runs[0].direction}` : total;
}

const SNAP_WORDS: Readonly<Record<MeasureSnap, string>> = {
  endpoint: "the end",
  corner: "the corner",
  center: "the centre",
  grid: "the grid",
  free: "a free point"
};

/** "the corner of wall-3", "the grid" - what a point snapped to, for the readout. */
export function describeSnap(point: MeasurePoint): string {
  return point.objectId ? `${SNAP_WORDS[point.snap]} of ${point.objectId}` : SNAP_WORDS[point.snap];
}
