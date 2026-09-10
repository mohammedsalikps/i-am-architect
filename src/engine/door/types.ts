import type { ConstructionObjectBase, ObjectId } from "../objects/types";
import type { HostPlacement } from "../openings/hostOpening";

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
 * A door is an independent, editable construction object. It can be
 * hosted by a wall: `hostId` is then that wall's id and `hostPlacement`
 * says where in the wall it sits. Its position and rotation are then
 * derived from the wall (see engine/openings/hostOpening.ts), so it moves
 * and turns with the wall, and the wall is drawn with a hole for it.
 */
export type DoorData = ConstructionObjectBase<"door", DoorDimensions> & {
  /** The wall this door belongs to, or null for a free-standing door. */
  hostId: string | null;
  /** Where the door sits in its wall - null exactly when hostId is. */
  hostPlacement: HostPlacement | null;
};
