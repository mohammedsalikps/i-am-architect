import type { BeamData, BeamId } from "./types";
// Explicit .ts extensions on these two value imports (unlike the pure
// type-only import above) are required so Node can run this file
// directly, e.g. from src/engine/beam/verify.ts - see
// allowImportingTsExtensions in tsconfig.json. Harmless for Vite too.
import { ObjectRegistry, type RegistryListener } from "../objects/ObjectRegistry.ts";
import { validateBeam, type BeamValidationResult } from "./validateBeam.ts";

export type BeamStoreListener = RegistryListener<BeamData>;

function notFound(id: BeamId): BeamValidationResult {
  return { valid: false, errors: [{ field: "id", message: `No beam found with id "${id}".` }] };
}

/**
 * Domain-specific facade over the generic ObjectRegistry - mirrors
 * WallStore.ts/PillarStore.ts exactly (see either's docs and
 * objects/README.md for the full "compose ObjectRegistry, add only
 * your own rules" reasoning). BeamStore adds two beam-specific rules a
 * generic registry deliberately doesn't know about:
 *
 * - Keeping a beam's base resting on the ground when its height
 *   changes (same grounding rule as a wall's or pillar's).
 * - Rejecting a duplicate beam id on add() - like PillarStore.add(),
 *   a generic registry has no "this id must not already exist"
 *   concept, only "add replaces whatever's there."
 *
 * Validates (see validateBeam.ts) before every write, rejecting
 * invalid data without touching the registry - an invalid write never
 * stores anything, never notifies subscribers, and never corrupts the
 * previous state.
 */
export class BeamStore {
  private readonly registry = new ObjectRegistry<BeamData>();

  /** Validates `beam`, rejects a duplicate id, and only stores it (and notifies subscribers) if both pass. */
  add(beam: BeamData): BeamValidationResult {
    const result = validateBeam(beam);
    if (!result.valid) {
      return result;
    }

    if (this.registry.has(beam.id)) {
      return {
        valid: false,
        errors: [{ field: "id", message: `A beam with id "${beam.id}" already exists.` }]
      };
    }

    this.registry.add(beam);
    return result;
  }

  /**
   * Merges `changes` into the existing beam and validates the
   * resulting *complete* beam before applying it - not just the
   * incoming partial changes. `changes.dimensions`, like
   * `changes.position`, must be a complete replacement object when
   * provided (not a partial merge) - callers spread the current value
   * and override one field, e.g. `{ ...beam.dimensions, height: 3 }`.
   *
   * If dimensions.height changes without an explicit `position`, the
   * beam's base is kept resting on the ground by recomputing
   * position.y before validating/delegating - the same rule
   * WallStore.update()/PillarStore.update() apply.
   *
   * Returns an invalid result (and leaves the store untouched) if `id`
   * doesn't exist, or if the merged beam would fail validation.
   */
  update(id: BeamId, changes: Partial<Omit<BeamData, "id" | "type">>): BeamValidationResult {
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

    const merged: BeamData = { ...existing, ...effectiveChanges };
    const result = validateBeam(merged);
    if (!result.valid) {
      return result;
    }

    this.registry.update(id, effectiveChanges);
    return result;
  }

  /**
   * Overwrites a beam's data exactly - no partial merge, no
   * derived-field side effects (unlike update()). Used to restore an
   * exact historical snapshot for undo/redo. Still validated: a
   * corrupted or hand-built snapshot is rejected rather than stored.
   */
  set(id: BeamId, beam: BeamData): BeamValidationResult {
    const result = validateBeam(beam);
    if (!result.valid) {
      return result;
    }
    this.registry.set(id, beam);
    return result;
  }

  remove(id: BeamId): void {
    this.registry.remove(id);
  }

  get(id: BeamId): BeamData | undefined {
    return this.registry.get(id);
  }

  getAll(): BeamData[] {
    return this.registry.getAll();
  }

  /** Returns an unsubscribe function. Calls the listener once immediately with the current state. */
  subscribe(listener: BeamStoreListener): () => void {
    return this.registry.subscribe(listener);
  }
}
