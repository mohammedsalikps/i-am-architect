import type { Vector3Data } from "../objects/types";
import type { DoorData } from "./types";

export interface CreateDoorOptions {
  position?: Partial<Vector3Data>;
  rotation?: number;
  width?: number;
  height?: number;
  thickness?: number;
  material?: string;
  color?: string;
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
 */
export function createDoorData(options: CreateDoorOptions = {}): DoorData {
  const height = options.height ?? DEFAULTS.height;
  const position: Vector3Data = { x: 0, y: height / 2, z: 0, ...options.position };

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
    assemblyId: null
  };

  return door;
}

/** World-space offset applied to a duplicate so it never sits exactly on top of the original - same value the sibling object types use. */
const DUPLICATE_OFFSET = 0.75;

/**
 * Creates an independent copy of a door: same dimensions, material,
 * color and rotation, a fresh unique id (via createDoorData's own
 * counter), and a small position offset so the two don't overlap.
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
