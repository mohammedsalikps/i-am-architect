import type { ConstructionObjectBase, ObjectId } from "../objects/types";
import type { HostPlacement } from "../openings/hostOpening";

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
 * hosted by a wall: `hostId` is then that wall's id and `hostPlacement`
 * says where in the wall it sits (offset along it, sill height). Its
 * position and rotation are then derived from the wall (see
 * engine/openings/hostOpening.ts).
 */
export type WindowData = ConstructionObjectBase<"window", WindowDimensions> & {
  /** The wall this window belongs to, or null for a free-standing window. */
  hostId: string | null;
  /** Where the window sits in its wall - null exactly when hostId is. */
  hostPlacement: HostPlacement | null;
};
