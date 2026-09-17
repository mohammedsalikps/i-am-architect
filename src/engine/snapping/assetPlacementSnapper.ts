// Explicit .ts extension on this value import lets Node run this file
// directly (a future verify.ts could), harmless for Vite.
import { snapMove } from "./snapping.ts";
import type { SnapObject } from "./snapping";
import type { SnapSourceStores } from "./storeSnapper";

export interface AssetPlacementSnapResult {
  position: { x: number; z: number };
  /**
   * Whether the position snapped to something MEANINGFUL - a real
   * object's key point, or an alignment with one. Deliberately EXCLUDES
   * a plain grid snap: snapMove() always lands on the 0.1m grid as its
   * last resort, so treating that as "snapped" would make the indicator
   * true almost all the time, which stops being informative (task: "a
   * CLEAR indication when an object is snapped" - clear implies
   * distinguishing a real snap from the fine grid's constant background
   * rounding).
   */
  snapped: boolean;
}

/** A synthetic id for the not-yet-placed preview - never a real stored object, so it can never collide with (or need excluding from) a real one. */
const PREVIEW_ID = "__asset-placement-preview__";

/** The plain fields snapMove()/keyPointsOf() need from a stored construction record - a small, deliberate duplicate of storeSnapper.ts's own private toSnapObject(), minus the hostId/connections handling that only matters for dragging an EXISTING object's own joints/hosted children, which a not-yet-placed preview has none of. */
function toSnapObject(record: { id: string; type: string; kind?: string; position: { x: number; y: number; z: number }; rotation: number; dimensions: object }): SnapObject {
  return {
    id: record.id,
    type: record.type,
    ...(record.kind !== undefined ? { kind: record.kind } : {}),
    position: { ...record.position },
    rotation: record.rotation,
    dimensions: { ...(record.dimensions as Record<string, number>) }
  };
}

/**
 * Initial-placement snapping for the asset placement preview (Phase 6) -
 * grid, key points (endpoints/corners/centers), and alignment against
 * the REAL construction elements already in the project, using the
 * exact same pure `snapMove()` rules as post-placement manipulation
 * (see snapping.ts's own module docs). Deliberately NOT a change to
 * `createStoreSnapper`/`storeSnapper.ts`: that adapter's `move()` is
 * shaped around moving an object that already exists in a store (it
 * looks the object up by id to find what's dragging) - a placement
 * preview has no such id yet, so this is a second, narrower adapter
 * over the same underlying pure functions, not a rewrite of the first.
 *
 * Only construction elements (walls, pillars, beams, slabs, doors,
 * windows, catalog elements) are snap targets - not other assets, and
 * not the asset being placed itself. Respects the same `SnapSettings`
 * toggle as every other snap in the app.
 */
export function createAssetPlacementSnapper(stores: SnapSourceStores, settings: { isEnabled(): boolean }) {
  return {
    snap(candidate: { x: number; z: number }, dimensions: { width: number; height: number; depth: number }, rotationRadians: number): AssetPlacementSnapResult {
      if (!settings.isEnabled()) {
        return { position: candidate, snapped: false };
      }
      const others: SnapObject[] = [
        ...stores.wallStore.getAll(),
        ...stores.pillarStore.getAll(),
        ...stores.beamStore.getAll(),
        ...stores.slabStore.getAll(),
        ...stores.doorStore.getAll(),
        ...stores.windowStore.getAll(),
        ...stores.elementStore.getAll()
      ].map(toSnapObject);

      const moving: SnapObject = {
        id: PREVIEW_ID,
        type: "asset",
        position: { x: candidate.x, y: 0, z: candidate.z },
        rotation: rotationRadians,
        dimensions: { width: dimensions.width, height: dimensions.height, depth: dimensions.depth }
      };
      const result = snapMove(moving, moving.position, others);
      return { position: { x: result.position.x, z: result.position.z }, snapped: result.mode === "point" || result.mode === "align" };
    }
  };
}
