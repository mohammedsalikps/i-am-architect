import type { Vector3Data } from "../objects/types";

/**
 * Hosting a door or window on a wall. Openings aren't cut into walls yet
 * (no boolean geometry); instead a hosted opening sits flush against one
 * face of its wall, turned with it, and records the wall's id in
 * `hostId`. That relationship is what future wall-hosting builds on - an
 * opening that knows its wall can later be cut into it, or follow it.
 */

/** Default sill height for a window, above the wall's base, in meters. */
export const WINDOW_SILL_HEIGHT = 0.9;

export interface HostWall {
  position: Vector3Data;
  rotation: number;
  dimensions: { length: number; height: number; thickness: number };
}

export interface OpeningSize {
  width: number;
  height: number;
  thickness: number;
}

export interface OpeningPlacementOptions {
  /** Along the wall's length from its center, in meters - clamped so the opening stays on the wall. */
  offset?: number;
  /** Height of the opening's bottom above the wall's base. */
  sill?: number;
  /** Which face: +1 the wall's local +Z face (the default), -1 the other one. */
  side?: 1 | -1;
}

function round(value: number): number {
  const rounded = Math.round(value * 1e9) / 1e9;
  return rounded === 0 ? 0 : rounded;
}

/**
 * Where an opening goes on a wall: centered on the wall (or at `offset`
 * along it), its bottom `sill` above the wall's base, touching the wall's
 * face - not inside it - and rotated with the wall. Pure math in the
 * engine's convention: local X runs along the wall, (cos t, 0, -sin t);
 * local Z is its face normal, (sin t, 0, cos t).
 */
export function placeOpeningOnWall(
  wall: HostWall,
  opening: OpeningSize,
  options: OpeningPlacementOptions = {}
): { position: Vector3Data; rotation: number } {
  const halfTravel = Math.max(0, (wall.dimensions.length - opening.width) / 2);
  const offset = Math.min(halfTravel, Math.max(-halfTravel, options.offset ?? 0));
  const side = options.side ?? 1;
  const rotation = wall.rotation;
  const along = { x: Math.cos(rotation), z: -Math.sin(rotation) };
  const normal = { x: Math.sin(rotation), z: Math.cos(rotation) };
  const push = side * (wall.dimensions.thickness / 2 + opening.thickness / 2);
  const base = wall.position.y - wall.dimensions.height / 2;

  return {
    position: {
      x: round(wall.position.x + along.x * offset + normal.x * push),
      y: round(base + (options.sill ?? 0) + opening.height / 2),
      z: round(wall.position.z + along.z * offset + normal.z * push)
    },
    rotation
  };
}
