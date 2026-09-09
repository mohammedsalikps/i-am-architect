import type { ConstructionObjectBase, ObjectId } from "../objects/types";

export type PillarId = ObjectId;

/** A pillar's type-specific size fields, in meters. */
export interface PillarDimensions {
  width: number;
  depth: number;
  height: number;
}

/**
 * A pillar is a ConstructionObjectBase specialized with pillar-shaped
 * dimensions. See src/engine/objects/types.ts for the shared envelope
 * (id/type/position/rotation/material/color/assemblyId) this builds on,
 * and src/engine/objects/README.md for how object types follow the
 * same pattern - this file mirrors src/engine/wall/types.ts exactly.
 */
export type PillarData = ConstructionObjectBase<"pillar", PillarDimensions>;
