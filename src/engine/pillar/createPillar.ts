import type { Vector3Data } from "../objects/types";
import type { PillarData } from "./types";

export interface CreatePillarOptions {
  position?: Partial<Vector3Data>;
  rotation?: number;
  width?: number;
  depth?: number;
  height?: number;
  material?: string;
  color?: string;
}

const DEFAULTS = {
  width: 0.4,
  depth: 0.4,
  height: 2.7, // matches the default wall height, so a pillar reads as the same story-height by default
  material: "generic",
  color: "#a8a8a8" // distinct from a wall's default #c9c9c9 so the two are visually distinguishable at a glance
} as const;

let nextId = 1;

/**
 * Creates a new pillar with sensible defaults - mirrors
 * wall/createWall.ts's createWallData() exactly. The base always rests
 * on the ground (y = height / 2) unless a full position is supplied.
 * Options stay flat (width/depth/height) for a simple call site - only
 * the stored PillarData nests them under `dimensions`.
 */
export function createPillarData(options: CreatePillarOptions = {}): PillarData {
  const height = options.height ?? DEFAULTS.height;
  const position: Vector3Data = { x: 0, y: height / 2, z: 0, ...options.position };

  const pillar: PillarData = {
    id: `pillar-${nextId++}`,
    type: "pillar",
    position,
    rotation: options.rotation ?? 0,
    dimensions: {
      width: options.width ?? DEFAULTS.width,
      depth: options.depth ?? DEFAULTS.depth,
      height
    },
    material: options.material ?? DEFAULTS.material,
    color: options.color ?? DEFAULTS.color,
    assemblyId: null
  };

  return pillar;
}

/** World-space offset applied to a duplicate so it never sits exactly on top of the original - same value wall's duplicateWallData() uses. */
const DUPLICATE_OFFSET = 0.75;

/**
 * Creates an independent copy of a pillar: same dimensions, material,
 * color and rotation, a fresh unique id (via createPillarData's own
 * counter), and a small position offset so the two don't overlap.
 */
export function duplicatePillarData(pillar: PillarData): PillarData {
  return createPillarData({
    position: {
      x: pillar.position.x + DUPLICATE_OFFSET,
      y: pillar.position.y,
      z: pillar.position.z + DUPLICATE_OFFSET
    },
    rotation: pillar.rotation,
    width: pillar.dimensions.width,
    depth: pillar.dimensions.depth,
    height: pillar.dimensions.height,
    material: pillar.material,
    color: pillar.color
  });
}
