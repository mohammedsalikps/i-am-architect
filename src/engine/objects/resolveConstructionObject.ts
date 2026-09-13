import type { ObjectId, ObjectType } from "./types";
import type { WallStore } from "../wall/WallStore";
import type { PillarStore } from "../pillar/PillarStore";
import type { BeamStore } from "../beam/BeamStore";
import type { SlabStore } from "../slab/SlabStore";
import type { DoorStore } from "../door/DoorStore";
import type { WindowStore } from "../window/WindowStore";
import type { ElementStore } from "../elements/ElementStore";
import type { AssetStore } from "../assets/AssetStore";

/** The stores this resolver knows how to check - extend alongside a new object type's store. */
export interface ConstructionObjectStores {
  wallStore: WallStore;
  pillarStore: PillarStore;
  beamStore: BeamStore;
  slabStore: SlabStore;
  doorStore: DoorStore;
  windowStore: WindowStore;
  /** Every catalog element kind - optional so callers built for the six original types keep working. */
  elementStore?: ElementStore;
  /** Every placed design asset - optional for the same reason elementStore is. */
  assetStore?: AssetStore;
}

export interface ResolvedConstructionObjectRef {
  type: ObjectType;
  id: ObjectId;
}

/**
 * Resolves an arbitrary object id to which store (if any) currently
 * holds it, without the caller needing to know or guess the type in
 * advance. Checks each store in a fixed order (wall, pillar, beam, slab,
 * door, window, then the element store) and returns as soon as one
 * matches.
 *
 * Pure, side-effect-free, no Three.js/DOM/UI knowledge - consistent
 * with everything else under src/engine/.
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
  if (stores.slabStore.get(id)) {
    return { type: "slab", id };
  }
  if (stores.doorStore.get(id)) {
    return { type: "door", id };
  }
  if (stores.windowStore.get(id)) {
    return { type: "window", id };
  }
  if (stores.elementStore?.get(id)) {
    return { type: "element", id };
  }
  if (stores.assetStore?.get(id)) {
    return { type: "asset", id };
  }
  return undefined;
}
