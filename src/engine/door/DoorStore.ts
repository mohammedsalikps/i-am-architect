import type { DoorData, DoorId } from "./types";
// Explicit .ts extensions on these two value imports (unlike the pure
// type-only import above) are required so Node can run this file
// directly, e.g. from src/engine/door/verify.ts - see
// allowImportingTsExtensions in tsconfig.json. Harmless for Vite too.
import { ObjectRegistry, type RegistryListener } from "../objects/ObjectRegistry.ts";
import { validateDoor, type DoorValidationResult } from "./validateDoor.ts";
import { keepBaseY } from "../objects/grounding.ts";

export type DoorStoreListener = RegistryListener<DoorData>;

function notFound(id: DoorId): DoorValidationResult {
  return { valid: false, errors: [{ field: "id", message: `No door found with id "${id}".` }] };
}

/**
 * Domain-specific facade over the generic ObjectRegistry - mirrors
 * WallStore.ts/PillarStore.ts/BeamStore.ts/SlabStore.ts exactly (see
 * any of their docs and objects/README.md for the full "compose
 * ObjectRegistry, add only your own rules" reasoning). DoorStore adds
 * two door-specific rules a generic registry deliberately doesn't
 * know about:
 *
 * - Keeping a door's base where it is (on the ground, or on a slab)
 *   when its height changes (the same rule as a wall's/pillar's/beam's
 *   height).
 * - Rejecting a duplicate door id on add() - like the sibling stores'
 *   add() methods, a generic registry has no "this id must not
 *   already exist" concept, only "add replaces whatever's there."
 *
 * Validates (see validateDoor.ts) before every write, rejecting
 * invalid data without touching the registry - an invalid write never
 * stores anything, never notifies subscribers, and never corrupts the
 * previous state.
 */
export class DoorStore {
  private readonly registry = new ObjectRegistry<DoorData>();

  /** Validates `door`, rejects a duplicate id, and only stores it (and notifies subscribers) if both pass. */
  add(door: DoorData): DoorValidationResult {
    const result = validateDoor(door);
    if (!result.valid) {
      return result;
    }

    if (this.registry.has(door.id)) {
      return {
        valid: false,
        errors: [{ field: "id", message: `A door with id "${door.id}" already exists.` }]
      };
    }

    this.registry.add(door);
    return result;
  }

  /**
   * Merges `changes` into the existing door and validates the
   * resulting *complete* door before applying it - not just the
   * incoming partial changes. `changes.dimensions`, like
   * `changes.position`, must be a complete replacement object when
   * provided (not a partial merge) - callers spread the current value
   * and override one field, e.g. `{ ...door.dimensions, height: 2.4 }`.
   *
   * If dimensions.height changes without an explicit `position`, the
   * door's base is kept where it was (on the ground, or on the slab it
   * stands on) by recomputing position.y before validating/delegating -
   * the same rule the sibling stores' update() methods apply (see
   * objects/grounding.ts).
   *
   * Returns an invalid result (and leaves the store untouched) if `id`
   * doesn't exist, or if the merged door would fail validation.
   */
  update(id: DoorId, changes: Partial<Omit<DoorData, "id" | "type">>): DoorValidationResult {
    const existing = this.registry.get(id);
    if (!existing) {
      return notFound(id);
    }

    let effectiveChanges = changes;
    const height = changes.dimensions?.height;
    if (height !== undefined && height !== existing.dimensions.height && changes.position === undefined) {
      effectiveChanges = {
        ...changes,
        position: { ...existing.position, y: keepBaseY(existing.position.y, existing.dimensions.height, height) }
      };
    }

    const merged: DoorData = { ...existing, ...effectiveChanges };
    const result = validateDoor(merged);
    if (!result.valid) {
      return result;
    }

    this.registry.update(id, effectiveChanges);
    return result;
  }

  /**
   * Overwrites a door's data exactly - no partial merge, no
   * derived-field side effects (unlike update()). Used to restore an
   * exact historical snapshot for undo/redo. Still validated: a
   * corrupted or hand-built snapshot is rejected rather than stored.
   */
  set(id: DoorId, door: DoorData): DoorValidationResult {
    const result = validateDoor(door);
    if (!result.valid) {
      return result;
    }
    this.registry.set(id, door);
    return result;
  }

  remove(id: DoorId): void {
    this.registry.remove(id);
  }

  get(id: DoorId): DoorData | undefined {
    return this.registry.get(id);
  }

  getAll(): DoorData[] {
    return this.registry.getAll();
  }

  /** Returns an unsubscribe function. Calls the listener once immediately with the current state. */
  subscribe(listener: DoorStoreListener): () => void {
    return this.registry.subscribe(listener);
  }
}
