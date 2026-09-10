import type { Vector3Data } from "../objects/types";
import type { HostPlacement } from "../openings/hostOpening";
import type { DoorData } from "./types";

export interface CreateDoorOptions {
  position?: Partial<Vector3Data>;
  rotation?: number;
  width?: number;
  height?: number;
  thickness?: number;
  material?: string;
  color?: string;
  /** The wall hosting this door, if any - see engine/openings/hostOpening.ts. */
  hostId?: string | null;
  /** Where the door sits in its wall. CommandExecutor computes it; pass it only with a hostId. */
  hostPlacement?: HostPlacement | null;
  /** door.add only: along the host wall from its center, in meters. Omitted: the first free spot from the center. */
  offset?: number;
  /** door.add only: above the host wall's base, in meters. Omitted: 0. */
  sill?: number;
}

const DEFAULTS = {
  width: 0.9,
  height: 2.1,
  thickness: 0.05,
  material: "generic",
  color: "#6b4423" // a wood-like brown, distinct from every sibling type's grey/neutral default
} as const;

let nextId = 1;

/** Makes new door ids come after `ids` - the same rule as createWall.ts's reserveWallIds(). */
export function reserveDoorIds(ids: Iterable<string>): void {
  for (const id of ids) {
    const match = /^door-(\d+)$/.exec(id);
    if (match) {
      nextId = Math.max(nextId, Number(match[1]) + 1);
    }
  }
}

/**
 * Creates a new door with sensible defaults - mirrors
 * wall/createWall.ts's createWallData() and the sibling object types'
 * equivalents exactly. The base always rests on the ground
 * (y = height / 2) unless a full position is supplied. Options stay
 * flat (width/height/thickness) for a simple call site - only the
 * stored DoorData nests them under `dimensions`.
 *
 * A hosted door's position is derived from its wall - CommandExecutor
 * does that (door.add with a hostId), since it's the one that can see
 * the wall. This factory only copies what it's given.
 */
export function createDoorData(options: CreateDoorOptions = {}): DoorData {
  const height = options.height ?? DEFAULTS.height;
  const position: Vector3Data = { x: 0, y: height / 2, z: 0, ...options.position };
  const hostId = options.hostId ?? null;

  const door: DoorData = {
    id: `door-${nextId++}`,
    type: "door",
    position,
    rotation: options.rotation ?? 0,
    dimensions: {
      width: options.width ?? DEFAULTS.width,
      height,
      thickness: options.thickness ?? DEFAULTS.thickness
    },
    material: options.material ?? DEFAULTS.material,
    color: options.color ?? DEFAULTS.color,
    assemblyId: null,
    hostId,
    hostPlacement: hostId === null ? null : options.hostPlacement ?? null
  };

  return door;
}

/** World-space offset applied to a duplicate so it never sits exactly on top of the original - same value the sibling object types use. */
const DUPLICATE_OFFSET = 0.75;

/**
 * Creates an independent copy of a door: same dimensions, material,
 * color and rotation, a fresh unique id (via createDoorData's own
 * counter), and a small position offset so the two don't overlap. The
 * offset takes it out of its wall, so the copy is free-standing.
 */
export function duplicateDoorData(door: DoorData): DoorData {
  return createDoorData({
    position: {
      x: door.position.x + DUPLICATE_OFFSET,
      y: door.position.y,
      z: door.position.z + DUPLICATE_OFFSET
    },
    rotation: door.rotation,
    width: door.dimensions.width,
    height: door.dimensions.height,
    thickness: door.dimensions.thickness,
    material: door.material,
    color: door.color
  });
}
