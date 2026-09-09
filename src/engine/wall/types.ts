import type { ConstructionObjectBase, ObjectId } from "../objects/types";

export type WallId = ObjectId;

/** A wall's type-specific size fields, in meters. */
export interface WallDimensions {
  length: number;
  height: number;
  thickness: number;
}

/**
 * A wall is a ConstructionObjectBase specialized with wall-shaped
 * dimensions. See src/engine/objects/types.ts for the shared envelope
 * (id/type/position/rotation/material/color/assemblyId) this builds on,
 * and src/engine/objects/README.md for how future object types follow
 * the same pattern.
 */
export type WallData = ConstructionObjectBase<"wall", WallDimensions>;
