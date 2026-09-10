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
 * A door is an independent, editable construction object. It can be
 * hosted by a wall: `hostId` is then that wall's id, and the door sits
 * flush on the wall's face (see engine/openings/hostOpening.ts). It isn't
 * cut into the wall as an opening yet.
 */
export type DoorData = ConstructionObjectBase<"door", DoorDimensions> & {
  /** The wall this door belongs to, or null for a free-standing door. */
  hostId: string | null;
};
