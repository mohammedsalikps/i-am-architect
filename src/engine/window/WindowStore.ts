import type { WindowData, WindowId } from "./types";
// Explicit .ts extensions on these two value imports (unlike the pure
// type-only import above) are required so Node can run this file
// directly, e.g. from src/engine/window/verify.ts - see
// allowImportingTsExtensions in tsconfig.json. Harmless for Vite too.
import { ObjectRegistry, type RegistryListener } from "../objects/ObjectRegistry.ts";
import { validateWindow, type WindowValidationResult } from "./validateWindow.ts";
import { keepBaseY } from "../objects/grounding.ts";

export type WindowStoreListener = RegistryListener<WindowData>;

function notFound(id: WindowId): WindowValidationResult {
  return { valid: false, errors: [{ field: "id", message: `No window found with id "${id}".` }] };
}

/**
 * Domain-specific facade over the generic ObjectRegistry - mirrors
 * DoorStore.ts and every other sibling *Store exactly (see any of
 * their docs and objects/README.md for the full "compose
 * ObjectRegistry, add only your own rules" reasoning). WindowStore
 * adds two window-specific rules a generic registry deliberately
 * doesn't know about:
 *
 * - Keeping a window's base where it is - a window on its sill stays on
 *   its sill - when its height changes (the same rule as every sibling
 *   type's height).
 * - Rejecting a duplicate window id on add() - like the sibling
 *   stores' add() methods, a generic registry has no "this id must
 *   not already exist" concept, only "add replaces whatever's there."
 *
 * Validates (see validateWindow.ts) before every write, rejecting
 * invalid data without touching the registry - an invalid write never
 * stores anything, never notifies subscribers, and never corrupts the
 * previous state.
 */
export class WindowStore {
  private readonly registry = new ObjectRegistry<WindowData>();

  /** Validates `windowData`, rejects a duplicate id, and only stores it (and notifies subscribers) if both pass. */
  add(windowData: WindowData): WindowValidationResult {
    const result = validateWindow(windowData);
    if (!result.valid) {
      return result;
    }

    if (this.registry.has(windowData.id)) {
      return {
        valid: false,
        errors: [{ field: "id", message: `A window with id "${windowData.id}" already exists.` }]
      };
    }

    this.registry.add(windowData);
    return result;
  }

  /**
   * Merges `changes` into the existing window and validates the
   * resulting *complete* window before applying it - not just the
   * incoming partial changes. `changes.dimensions`, like
   * `changes.position`, must be a complete replacement object when
   * provided (not a partial merge) - callers spread the current value
   * and override one field, e.g. `{ ...windowData.dimensions, height: 1.5 }`.
   *
   * If dimensions.height changes without an explicit `position`, the
   * window's base is kept where it was - a window on its sill stays on
   * its sill - by recomputing position.y before validating/delegating,
   * the same rule the sibling stores' update() methods apply (see
   * objects/grounding.ts).
   *
   * Returns an invalid result (and leaves the store untouched) if `id`
   * doesn't exist, or if the merged window would fail validation.
   */
  update(id: WindowId, changes: Partial<Omit<WindowData, "id" | "type">>): WindowValidationResult {
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

    const merged: WindowData = { ...existing, ...effectiveChanges };
    const result = validateWindow(merged);
    if (!result.valid) {
      return result;
    }

    this.registry.update(id, effectiveChanges);
    return result;
  }

  /**
   * Overwrites a window's data exactly - no partial merge, no
   * derived-field side effects (unlike update()). Used to restore an
   * exact historical snapshot for undo/redo. Still validated: a
   * corrupted or hand-built snapshot is rejected rather than stored.
   */
  set(id: WindowId, windowData: WindowData): WindowValidationResult {
    const result = validateWindow(windowData);
    if (!result.valid) {
      return result;
    }
    this.registry.set(id, windowData);
    return result;
  }

  remove(id: WindowId): void {
    this.registry.remove(id);
  }

  get(id: WindowId): WindowData | undefined {
    return this.registry.get(id);
  }

  getAll(): WindowData[] {
    return this.registry.getAll();
  }

  /** Returns an unsubscribe function. Calls the listener once immediately with the current state. */
  subscribe(listener: WindowStoreListener): () => void {
    return this.registry.subscribe(listener);
  }
}
