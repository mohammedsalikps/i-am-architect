import type { Vector3Data } from "../objects/types";
import type { BeamData } from "./types";

export interface CreateBeamOptions {
  position?: Partial<Vector3Data>;
  rotation?: number;
  length?: number;
  width?: number;
  height?: number;
  material?: string;
  color?: string;
}

const DEFAULTS = {
  length: 3,
  width: 0.3,
  height: 0.4,
  material: "generic",
  color: "#8a8a8a" // distinct from wall's #c9c9c9 and pillar's #a8a8a8 so all three are visually distinguishable at a glance
} as const;

let nextId = 1;

/**
 * Creates a new beam with sensible defaults - mirrors
 * wall/createWall.ts's createWallData() and pillar/createPillar.ts's
 * createPillarData() exactly. The base always rests on the ground
 * (y = height / 2) unless a full position is supplied. Options stay
 * flat (length/width/height) for a simple call site - only the stored
 * BeamData nests them under `dimensions`.
 */
export function createBeamData(options: CreateBeamOptions = {}): BeamData {
  const height = options.height ?? DEFAULTS.height;
  const position: Vector3Data = { x: 0, y: height / 2, z: 0, ...options.position };

  const beam: BeamData = {
    id: `beam-${nextId++}`,
    type: "beam",
    position,
    rotation: options.rotation ?? 0,
    dimensions: {
      length: options.length ?? DEFAULTS.length,
      width: options.width ?? DEFAULTS.width,
      height
    },
    material: options.material ?? DEFAULTS.material,
    color: options.color ?? DEFAULTS.color,
    assemblyId: null
  };

  return beam;
}

/** World-space offset applied to a duplicate so it never sits exactly on top of the original - same value wall's/pillar's duplicate functions use. */
const DUPLICATE_OFFSET = 0.75;

/**
 * Creates an independent copy of a beam: same dimensions, material,
 * color and rotation, a fresh unique id (via createBeamData's own
 * counter), and a small position offset so the two don't overlap.
 */
export function duplicateBeamData(beam: BeamData): BeamData {
  return createBeamData({
    position: {
      x: beam.position.x + DUPLICATE_OFFSET,
      y: beam.position.y,
      z: beam.position.z + DUPLICATE_OFFSET
    },
    rotation: beam.rotation,
    length: beam.dimensions.length,
    width: beam.dimensions.width,
    height: beam.dimensions.height,
    material: beam.material,
    color: beam.color
  });
}
