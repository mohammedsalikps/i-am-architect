import type { PillarData, PillarId } from "./types";
// Explicit .ts extensions on these two value imports (unlike the pure
// type-only import above) are required so Node can run this file
// directly, e.g. from src/engine/pillar/verify.ts - see
// allowImportingTsExtensions in tsconfig.json. Harmless for Vite too.
import { ObjectRegistry, type RegistryListener } from "../objects/ObjectRegistry.ts";
import { validatePillar, type PillarValidationResult } from "./validatePillar.ts";

export type PillarStoreListener = RegistryListener<PillarData>;

function notFound(id: PillarId): PillarValidationResult {
  return { valid: false, errors: [{ field: "id", message: `No pillar found with id "${id}".` }] };
}

/**
 * Domain-specific facade over the generic ObjectRegistry - mirrors
 * WallStore.ts exactly (see its docs and objects/README.md for the
 * full "compose ObjectRegistry, add only your own rules" reasoning).
 * PillarStore adds two pillar-specific rules a generic registry
 * deliberately doesn't know about:
 *
 * - Keeping a pillar's base resting on the ground when its height
 *   changes (same grounding rule as a wall's).
 * - Rejecting a duplicate pillar id on add() - like AssemblyStore.add(),
 *   a generic registry has no "this id must not already exist" concept,
 *   only "add replaces whatever's there." (Wall ids never needed this
 *   check because createWallData()'s counter guarantees uniqueness and
 *   nothing else ever calls WallStore.add() with a caller-supplied id;
 *   the same is true for pillars via createPillarData(), but the
 *   milestone spec calls for the check explicitly, so it's here too.)
 *
 * Validates (see validatePillar.ts) before every write, rejecting
 * invalid data without touching the registry - an invalid write never
 * stores anything, never notifies subscribers, and never corrupts the
 * previous state.
 */
export class PillarStore {
  private readonly registry = new ObjectRegistry<PillarData>();

  /** Validates `pillar`, rejects a duplicate id, and only stores it (and notifies subscribers) if both pass. */
  add(pillar: PillarData): PillarValidationResult {
    const result = validatePillar(pillar);
    if (!result.valid) {
      return result;
    }

    if (this.registry.has(pillar.id)) {
      return {
        valid: false,
        errors: [{ field: "id", message: `A pillar with id "${pillar.id}" already exists.` }]
      };
    }

    this.registry.add(pillar);
    return result;
  }

  /**
   * Merges `changes` into the existing pillar and validates the
   * resulting *complete* pillar before applying it - not just the
   * incoming partial changes. `changes.dimensions`, like
   * `changes.position`, must be a complete replacement object when
   * provided (not a partial merge) - callers spread the current value
   * and override one field, e.g. `{ ...pillar.dimensions, height: 3 }`.
   *
   * If dimensions.height changes without an explicit `position`, the
   * pillar's base is kept resting on the ground by recomputing
   * position.y before validating/delegating - the same rule
   * WallStore.update() applies.
   *
   * Returns an invalid result (and leaves the store untouched) if `id`
   * doesn't exist, or if the merged pillar would fail validation.
   */
  update(id: PillarId, changes: Partial<Omit<PillarData, "id" | "type">>): PillarValidationResult {
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

    const merged: PillarData = { ...existing, ...effectiveChanges };
    const result = validatePillar(merged);
    if (!result.valid) {
      return result;
    }

    this.registry.update(id, effectiveChanges);
    return result;
  }

  /**
   * Overwrites a pillar's data exactly - no partial merge, no
   * derived-field side effects (unlike update()). Used to restore an
   * exact historical snapshot for undo/redo. Still validated: a
   * corrupted or hand-built snapshot is rejected rather than stored.
   */
  set(id: PillarId, pillar: PillarData): PillarValidationResult {
    const result = validatePillar(pillar);
    if (!result.valid) {
      return result;
    }
    this.registry.set(id, pillar);
    return result;
  }

  remove(id: PillarId): void {
    this.registry.remove(id);
  }

  get(id: PillarId): PillarData | undefined {
    return this.registry.get(id);
  }

  getAll(): PillarData[] {
    return this.registry.getAll();
  }

  /** Returns an unsubscribe function. Calls the listener once immediately with the current state. */
  subscribe(listener: PillarStoreListener): () => void {
    return this.registry.subscribe(listener);
  }
}
