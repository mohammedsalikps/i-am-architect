import type { SlabData, SlabId } from "./types";
// Explicit .ts extensions on these two value imports (unlike the pure
// type-only import above) are required so Node can run this file
// directly, e.g. from src/engine/slab/verify.ts - see
// allowImportingTsExtensions in tsconfig.json. Harmless for Vite too.
import { ObjectRegistry, type RegistryListener } from "../objects/ObjectRegistry.ts";
import { validateSlab, type SlabValidationResult } from "./validateSlab.ts";
import { keepBaseY } from "../objects/grounding.ts";

export type SlabStoreListener = RegistryListener<SlabData>;

function notFound(id: SlabId): SlabValidationResult {
  return { valid: false, errors: [{ field: "id", message: `No slab found with id "${id}".` }] };
}

/**
 * Domain-specific facade over the generic ObjectRegistry - mirrors
 * WallStore.ts/PillarStore.ts/BeamStore.ts exactly (see any of their
 * docs and objects/README.md for the full "compose ObjectRegistry, add
 * only your own rules" reasoning). SlabStore adds two slab-specific
 * rules a generic registry deliberately doesn't know about:
 *
 * - Keeping a slab's base where it is when its thickness changes (the
 *   same rule as a wall's height, a pillar's height, or a beam's height -
 *   here it's `thickness` that plays that role, since a slab is a flat
 *   horizontal element).
 * - Rejecting a duplicate slab id on add() - like PillarStore.add()/
 *   BeamStore.add(), a generic registry has no "this id must not
 *   already exist" concept, only "add replaces whatever's there."
 *
 * Validates (see validateSlab.ts) before every write, rejecting
 * invalid data without touching the registry - an invalid write never
 * stores anything, never notifies subscribers, and never corrupts the
 * previous state.
 */
export class SlabStore {
  private readonly registry = new ObjectRegistry<SlabData>();

  /** Validates `slab`, rejects a duplicate id, and only stores it (and notifies subscribers) if both pass. */
  add(slab: SlabData): SlabValidationResult {
    const result = validateSlab(slab);
    if (!result.valid) {
      return result;
    }

    if (this.registry.has(slab.id)) {
      return {
        valid: false,
        errors: [{ field: "id", message: `A slab with id "${slab.id}" already exists.` }]
      };
    }

    this.registry.add(slab);
    return result;
  }

  /**
   * Merges `changes` into the existing slab and validates the
   * resulting *complete* slab before applying it - not just the
   * incoming partial changes. `changes.dimensions`, like
   * `changes.position`, must be a complete replacement object when
   * provided (not a partial merge) - callers spread the current value
   * and override one field, e.g. `{ ...slab.dimensions, thickness: 0.3 }`.
   *
   * If dimensions.thickness changes without an explicit `position`,
   * the slab's base is kept where it was (on the ground, or wherever it
   * was raised to) by recomputing position.y before
   * validating/delegating - the same rule
   * WallStore.update()/PillarStore.update()/BeamStore.update() apply
   * to their own height field (see objects/grounding.ts).
   *
   * Returns an invalid result (and leaves the store untouched) if `id`
   * doesn't exist, or if the merged slab would fail validation.
   */
  update(id: SlabId, changes: Partial<Omit<SlabData, "id" | "type">>): SlabValidationResult {
    const existing = this.registry.get(id);
    if (!existing) {
      return notFound(id);
    }

    let effectiveChanges = changes;
    const thickness = changes.dimensions?.thickness;
    if (thickness !== undefined && thickness !== existing.dimensions.thickness && changes.position === undefined) {
      effectiveChanges = {
        ...changes,
        position: { ...existing.position, y: keepBaseY(existing.position.y, existing.dimensions.thickness, thickness) }
      };
    }

    const merged: SlabData = { ...existing, ...effectiveChanges };
    const result = validateSlab(merged);
    if (!result.valid) {
      return result;
    }

    this.registry.update(id, effectiveChanges);
    return result;
  }

  /**
   * Overwrites a slab's data exactly - no partial merge, no
   * derived-field side effects (unlike update()). Used to restore an
   * exact historical snapshot for undo/redo. Still validated: a
   * corrupted or hand-built snapshot is rejected rather than stored.
   */
  set(id: SlabId, slab: SlabData): SlabValidationResult {
    const result = validateSlab(slab);
    if (!result.valid) {
      return result;
    }
    this.registry.set(id, slab);
    return result;
  }

  remove(id: SlabId): void {
    this.registry.remove(id);
  }

  get(id: SlabId): SlabData | undefined {
    return this.registry.get(id);
  }

  getAll(): SlabData[] {
    return this.registry.getAll();
  }

  /** Returns an unsubscribe function. Calls the listener once immediately with the current state. */
  subscribe(listener: SlabStoreListener): () => void {
    return this.registry.subscribe(listener);
  }
}
