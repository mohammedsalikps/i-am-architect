import type { Vector3Data } from "../objects/types";
import type { SlabData } from "./types";

export interface CreateSlabOptions {
  position?: Partial<Vector3Data>;
  rotation?: number;
  length?: number;
  width?: number;
  thickness?: number;
  material?: string;
  color?: string;
}

const DEFAULTS = {
  length: 4,
  width: 4,
  thickness: 0.2,
  material: "generic",
  color: "#b0b0b0" // distinct from wall's #c9c9c9, pillar's #a8a8a8, and beam's #8a8a8a
} as const;

let nextId = 1;

/**
 * Creates a new slab with sensible defaults - mirrors
 * wall/createWall.ts's createWallData() and pillar/createPillar.ts's/
 * beam/createBeam.ts's equivalents exactly. The base always rests on
 * the ground (y = thickness / 2) unless a full position is supplied.
 * Options stay flat (length/width/thickness) for a simple call site -
 * only the stored SlabData nests them under `dimensions`.
 */
export function createSlabData(options: CreateSlabOptions = {}): SlabData {
  const thickness = options.thickness ?? DEFAULTS.thickness;
  const position: Vector3Data = { x: 0, y: thickness / 2, z: 0, ...options.position };

  const slab: SlabData = {
    id: `slab-${nextId++}`,
    type: "slab",
    position,
    rotation: options.rotation ?? 0,
    dimensions: {
      length: options.length ?? DEFAULTS.length,
      width: options.width ?? DEFAULTS.width,
      thickness
    },
    material: options.material ?? DEFAULTS.material,
    color: options.color ?? DEFAULTS.color,
    assemblyId: null
  };

  return slab;
}

/** World-space offset applied to a duplicate so it never sits exactly on top of the original - same value the sibling object types use. */
const DUPLICATE_OFFSET = 0.75;

/**
 * Creates an independent copy of a slab: same dimensions, material,
 * color and rotation, a fresh unique id (via createSlabData's own
 * counter), and a small position offset so the two don't overlap.
 */
export function duplicateSlabData(slab: SlabData): SlabData {
  return createSlabData({
    position: {
      x: slab.position.x + DUPLICATE_OFFSET,
      y: slab.position.y,
      z: slab.position.z + DUPLICATE_OFFSET
    },
    rotation: slab.rotation,
    length: slab.dimensions.length,
    width: slab.dimensions.width,
    thickness: slab.dimensions.thickness,
    material: slab.material,
    color: slab.color
  });
}
