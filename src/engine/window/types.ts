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
 * A window is an independent, editable construction object. It can be
 * hosted by a wall: `hostId` is then that wall's id, and the window sits
 * flush on the wall's face at sill height (see
 * engine/openings/hostOpening.ts). It isn't cut into the wall yet.
 */
export type WindowData = ConstructionObjectBase<"window", WindowDimensions> & {
  /** The wall this window belongs to, or null for a free-standing window. */
  hostId: string | null;
};
