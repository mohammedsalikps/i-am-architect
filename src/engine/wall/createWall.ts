import type { Vector3Data, WallData } from "./types";

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
 * Creates a new wall with sensible defaults. The base always rests on
 * the ground (y = height / 2) unless a full position is supplied.
 */
export function createWallData(options: CreateWallOptions = {}): WallData {
  const height = options.height ?? DEFAULTS.height;
  const position: Vector3Data = { x: 0, y: height / 2, z: 0, ...options.position };

  const wall: WallData = {
    id: `wall-${nextId++}`,
    type: "wall",
    position,
    rotation: options.rotation ?? 0,
    length: options.length ?? DEFAULTS.length,
    height,
    thickness: options.thickness ?? DEFAULTS.thickness,
    material: options.material ?? DEFAULTS.material,
    color: options.color ?? DEFAULTS.color
  };

  return wall;
}
