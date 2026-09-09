import type { ConstructionObjectBase, ObjectId } from "../objects/types";

export type SlabId = ObjectId;

/** A slab's type-specific size fields, in meters. */
export interface SlabDimensions {
  length: number;
  width: number;
  thickness: number;
}

/**
 * A slab is a ConstructionObjectBase specialized with slab-shaped
 * dimensions. See src/engine/objects/types.ts for the shared envelope
 * (id/type/position/rotation/material/color/assemblyId) this builds on,
 * and src/engine/wall/types.ts / src/engine/pillar/types.ts /
 * src/engine/beam/types.ts for the sibling object types this was built
 * to mirror exactly.
 */
export type SlabData = ConstructionObjectBase<"slab", SlabDimensions>;
