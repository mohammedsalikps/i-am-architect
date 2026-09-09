import type { WallData, WallId } from "./types";
import { ObjectRegistry, type RegistryListener } from "../objects/ObjectRegistry";

export type WallStoreListener = RegistryListener<WallData>;

/**
 * Domain-specific facade over the generic ObjectRegistry: storage,
 * CRUD, cloning at the boundary, and subscriptions are all delegated to
 * a private ObjectRegistry<WallData>. WallStore adds exactly one thing
 * that's actually wall-specific - keeping a wall's base resting on the
 * ground when its height changes - because that rule requires knowing
 * what "height" and "grounded" mean for a wall, which a generic
 * registry deliberately does not.
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

  add(wall: WallData): void {
    this.registry.add(wall);
  }

  /**
   * Merges `changes` into the existing wall. `changes.dimensions`, like
   * `changes.position`, must be a complete replacement object when
   * provided (not a partial merge) - callers spread the current value
   * and override one field, e.g. `{ ...wall.dimensions, height: 3 }`.
   *
   * If dimensions.height changes without an explicit `position`, the
   * wall's base is kept resting on the ground by recomputing
   * position.y before delegating to the registry - this is the one
   * wall-specific rule that lives here rather than in ObjectRegistry.
   */
  update(id: WallId, changes: Partial<Omit<WallData, "id" | "type">>): void {
    const existing = this.registry.get(id);
    if (!existing) {
      return;
    }

    let effectiveChanges = changes;
    if (changes.dimensions?.height !== undefined && changes.position === undefined) {
      effectiveChanges = {
        ...changes,
        position: { ...existing.position, y: changes.dimensions.height / 2 }
      };
    }

    this.registry.update(id, effectiveChanges);
  }

  /**
   * Overwrites a wall's data exactly - no partial merge, no derived-field
   * side effects (unlike update()). Used to restore an exact historical
   * snapshot for undo/redo, where the snapshot already has whatever
   * position.y etc. was correct at that point in time.
   */
  set(id: WallId, wall: WallData): void {
    this.registry.set(id, wall);
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
