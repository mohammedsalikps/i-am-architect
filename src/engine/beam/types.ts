import type { ConstructionObjectBase, ObjectId } from "../objects/types";

export type BeamId = ObjectId;

/** A beam's type-specific size fields, in meters. */
export interface BeamDimensions {
  length: number;
  width: number;
  height: number;
}

/**
 * A beam is a ConstructionObjectBase specialized with beam-shaped
 * dimensions. See src/engine/objects/types.ts for the shared envelope
 * (id/type/position/rotation/material/color/assemblyId) this builds on,
 * and src/engine/wall/types.ts / src/engine/pillar/types.ts for the
 * sibling object types this mirrors exactly.
 */
export type BeamData = ConstructionObjectBase<"beam", BeamDimensions>;
