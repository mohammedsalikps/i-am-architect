import type { ObjectId, ObjectType } from "./types";
import type { WallStore } from "../wall/WallStore";
import type { PillarStore } from "../pillar/PillarStore";
import type { BeamStore } from "../beam/BeamStore";

/** The stores this resolver knows how to check - extend alongside a new object type's store. */
export interface ConstructionObjectStores {
  wallStore: WallStore;
  pillarStore: PillarStore;
  beamStore: BeamStore;
}

export interface ResolvedConstructionObjectRef {
  type: ObjectType;
  id: ObjectId;
}

/**
 * Resolves an arbitrary object id to which store (if any) currently
 * holds it, without the caller needing to know or guess the type in
 * advance. Checks each store in a fixed order (wall, then pillar, then
 * beam) and returns as soon as one matches.
 *
 * This is the shared version of a "try wall, then pillar" pattern that
 * already existed independently in a few UI modules (assemblyPanel.ts's
 * member-label lookup, rightSidebar.ts's selection lookup, main.ts's
 * duplicate/delete handlers) - assemblyPanel.ts's copy was the one that
 * had actually gone stale (it never got a pillar branch), which is what
 * this file exists to fix. The others already do the equivalent check
 * inline and aren't broken, so they aren't required to switch to this
 * - but a future one safely could.
 *
 * Pure, side-effect-free, no Three.js/DOM/UI knowledge - consistent
 * with everything else under src/engine/. Extend the parameter list
 * (and this file's one comment above) the same way every time a new
 * object-type store is added, per objects/README.md.
 *
 * Returns undefined for an id that doesn't exist in any known store -
 * e.g. an assembly member whose underlying object was since deleted.
 */
export function resolveConstructionObject(
  id: ObjectId,
  stores: ConstructionObjectStores
): ResolvedConstructionObjectRef | undefined {
  if (stores.wallStore.get(id)) {
    return { type: "wall", id };
  }
  if (stores.pillarStore.get(id)) {
    return { type: "pillar", id };
  }
  if (stores.beamStore.get(id)) {
    return { type: "beam", id };
  }
  return undefined;
}
