import type { Vector3Data } from "../objects/types";
import type { WallData } from "./types";

export interface CreateWallOptions {
  position?: Partial<Vector3Data>;
  rotation?: number;
  length?: number;
  height?: number;
  thickness?: number;
  material?: string;
  color?: string;
}

const DEFAULTS = {
  length: 4,
  height: 2.7,
  thickness: 0.2,
  material: "generic",
  color: "#c9c9c9"
} as const;

let nextId = 1;

/**
 * Makes every id createWallData() hands out from now on come after
 * `ids` - called when a saved project is loaded, since its walls keep
 * their ids (see project/projectPersistence.ts). Never moves the counter
 * backwards, so no id is ever reused within a session.
 */
export function reserveWallIds(ids: Iterable<string>): void {
  for (const id of ids) {
    const match = /^wall-(\d+)$/.exec(id);
    if (match) {
      nextId = Math.max(nextId, Number(match[1]) + 1);
    }
  }
}

/**
 * Creates a new wall with sensible defaults. The base always rests on
 * the ground (y = height / 2) unless a full position is supplied.
 * Options stay flat (length/height/thickness) for a simple call site -
 * only the stored WallData nests them under `dimensions`.
 */
export function createWallData(options: CreateWallOptions = {}): WallData {
  const height = options.height ?? DEFAULTS.height;
  const position: Vector3Data = { x: 0, y: height / 2, z: 0, ...options.position };

  const wall: WallData = {
    id: `wall-${nextId++}`,
    type: "wall",
    position,
    rotation: options.rotation ?? 0,
    dimensions: {
      length: options.length ?? DEFAULTS.length,
      height,
      thickness: options.thickness ?? DEFAULTS.thickness
    },
    material: options.material ?? DEFAULTS.material,
    color: options.color ?? DEFAULTS.color,
    assemblyId: null
  };

  return wall;
}

/** World-space offset applied to a duplicate so it never sits exactly on top of the original. */
const DUPLICATE_OFFSET = 0.75;

/**
 * Creates an independent copy of a wall: same dimensions, material,
 * color and rotation, a fresh unique id (via createWallData's own
 * counter), and a small position offset so the two don't overlap.
 */
export function duplicateWallData(wall: WallData): WallData {
  return createWallData({
    position: {
      x: wall.position.x + DUPLICATE_OFFSET,
      y: wall.position.y,
      z: wall.position.z + DUPLICATE_OFFSET
    },
    rotation: wall.rotation,
    length: wall.dimensions.length,
    height: wall.dimensions.height,
    thickness: wall.dimensions.thickness,
    material: wall.material,
    color: wall.color
  });
}
