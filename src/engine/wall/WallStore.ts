import type { WallData, WallId } from "./types";
// Explicit .ts extensions on these two value imports (unlike the pure
// type-only import above) are required so Node can run this file
// directly, e.g. from src/engine/wall/verify.ts - see
// allowImportingTsExtensions in tsconfig.json. Harmless for Vite too.
import { ObjectRegistry, type RegistryListener } from "../objects/ObjectRegistry.ts";
import { validateWall, type WallValidationResult } from "./validateWall.ts";

export type WallStoreListener = RegistryListener<WallData>;

function notFound(id: WallId): WallValidationResult {
  return { valid: false, errors: [{ field: "id", message: `No wall found with id "${id}".` }] };
}

/**
 * Domain-specific facade over the generic ObjectRegistry: storage,
 * CRUD, cloning at the boundary, and subscriptions are all delegated to
 * a private ObjectRegistry<WallData>. WallStore adds the wall-specific
 * behavior a generic registry deliberately doesn't know about:
 *
 * - Keeping a wall's base resting on the ground when its height changes.
 * - Validating (see validateWall.ts) before every write, rejecting
 *   invalid data without touching the registry - so an invalid write
 *   never stores anything, never notifies subscribers, and never
 *   corrupts the previous state. WallHistoryController checks the
 *   returned result and skips recording undo history for a rejected
 *   write. See src/engine/wall/README.md for the full constraint list.
 *
 * Rendering (Three.js) and UI both subscribe to this instead of
 * talking to each other directly, so either side can be swapped out
 * without touching wall logic.
 *
 * See src/engine/objects/README.md for the reasoning behind this
 * "compose ObjectRegistry, add only your own derived-field rules"
 * pattern - future object-type stores (PillarStore, BeamStore, ...)
 * should follow the same shape.
 */
export class WallStore {
  private readonly registry = new ObjectRegistry<WallData>();

  /** Validates `wall`; only stores it (and notifies subscribers) if valid. */
  add(wall: WallData): WallValidationResult {
    const result = validateWall(wall);
    if (!result.valid) {
      return result;
    }
    this.registry.add(wall);
    return result;
  }

  /**
   * Merges `changes` into the existing wall and validates the resulting
   * *complete* wall before applying it - not just the incoming partial
   * changes. `changes.dimensions`, like `changes.position`, must be a
   * complete replacement object when provided (not a partial merge) -
   * callers spread the current value and override one field, e.g.
   * `{ ...wall.dimensions, height: 3 }`.
   *
   * If dimensions.height changes without an explicit `position`, the
   * wall's base is kept resting on the ground by recomputing
   * position.y before validating/delegating - this is the one
   * wall-specific rule that lives here rather than in ObjectRegistry.
   *
   * Returns an invalid result (and leaves the store untouched) if `id`
   * doesn't exist, or if the merged wall would fail validation.
   */
  update(id: WallId, changes: Partial<Omit<WallData, "id" | "type">>): WallValidationResult {
    const existing = this.registry.get(id);
    if (!existing) {
      return notFound(id);
    }

    let effectiveChanges = changes;
    if (changes.dimensions?.height !== undefined && changes.position === undefined) {
      effectiveChanges = {
        ...changes,
        position: { ...existing.position, y: changes.dimensions.height / 2 }
      };
    }

    const merged: WallData = { ...existing, ...effectiveChanges };
    const result = validateWall(merged);
    if (!result.valid) {
      return result;
    }

    this.registry.update(id, effectiveChanges);
    return result;
  }

  /**
   * Overwrites a wall's data exactly - no partial merge, no derived-field
   * side effects (unlike update()). Used to restore an exact historical
   * snapshot for undo/redo, where the snapshot already has whatever
   * position.y etc. was correct at that point in time. Still validated:
   * a corrupted or hand-built snapshot is rejected rather than stored.
   */
  set(id: WallId, wall: WallData): WallValidationResult {
    const result = validateWall(wall);
    if (!result.valid) {
      return result;
    }
    this.registry.set(id, wall);
    return result;
  }

  remove(id: WallId): void {
    this.registry.remove(id);
  }

  get(id: WallId): WallData | undefined {
    return this.registry.get(id);
  }

  getAll(): WallData[] {
    return this.registry.getAll();
  }

  /** Returns an unsubscribe function. Calls the listener once immediately with the current state. */
  subscribe(listener: WallStoreListener): () => void {
    return this.registry.subscribe(listener);
  }
}
