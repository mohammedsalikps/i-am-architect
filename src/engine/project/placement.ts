/**
 * Default placement for newly added objects: each object type has a row
 * of fixed "slots" (see main.ts), and a new object takes the first slot
 * no existing object of that type is sitting on. Deterministic and
 * deliberately simple - no collision detection, no inference - it only
 * guarantees that adding after a delete never lands a new object
 * exactly on top of one that's still there (which slot-by-count did).
 */

export interface PlanPoint {
  x: number;
  z: number;
}

/** How close (in meters, on the X/Z plane) an existing object must be to a slot to count as occupying it. */
export const SLOT_CLEARANCE = 0.5;

/** The index of the first slot with no existing object within SLOT_CLEARANCE of it. */
export function firstFreeSlot(occupied: readonly PlanPoint[], slot: (index: number) => PlanPoint): number {
  for (let index = 0; ; index += 1) {
    const candidate = slot(index);
    const taken = occupied.some((point) => Math.hypot(point.x - candidate.x, point.z - candidate.z) < SLOT_CLEARANCE);
    if (!taken) {
      return index;
    }
  }
}
