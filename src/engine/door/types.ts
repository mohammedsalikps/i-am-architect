import type { ConstructionObjectBase, ObjectId } from "../objects/types";

export type DoorId = ObjectId;

/** A door's type-specific size fields, in meters. */
export interface DoorDimensions {
  width: number;
  height: number;
  thickness: number;
}

/**
 * A door is a ConstructionObjectBase specialized with door-shaped
 * dimensions. See src/engine/objects/types.ts for the shared envelope
 * (id/type/position/rotation/material/color/assemblyId) this builds on,
 * and src/engine/wall/types.ts / src/engine/pillar/types.ts /
 * src/engine/beam/types.ts / src/engine/slab/types.ts for the sibling
 * object types this was built to mirror exactly.
 *
 * A door exists today as an independent, editable construction object -
 * not yet hosted by a wall or cut as an opening into one (see
 * README.md's "Not yet implemented" section).
 */
export type DoorData = ConstructionObjectBase<"door", DoorDimensions>;
