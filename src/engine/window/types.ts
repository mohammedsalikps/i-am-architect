import type { ConstructionObjectBase, ObjectId } from "../objects/types";

export type WindowId = ObjectId;

/** A window's type-specific size fields, in meters. */
export interface WindowDimensions {
  width: number;
  height: number;
  thickness: number;
}

/**
 * A window is a ConstructionObjectBase specialized with window-shaped
 * dimensions. See src/engine/objects/types.ts for the shared envelope
 * (id/type/position/rotation/material/color/assemblyId) this builds on,
 * and src/engine/door/types.ts for the sibling object type this was
 * built to mirror exactly.
 *
 * A window exists today as an independent, editable construction
 * object - not yet hosted by a wall or cut as an opening into one (see
 * README.md's "Not yet implemented" section).
 */
export type WindowData = ConstructionObjectBase<"window", WindowDimensions>;
