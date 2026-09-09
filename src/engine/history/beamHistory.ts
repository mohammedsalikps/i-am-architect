import type { BeamData, BeamId } from "../beam/types";
import type { BeamStore } from "../beam/BeamStore";
import type { BeamValidationResult } from "../beam/validateBeam";
import type { SelectionStore } from "../selection/SelectionStore";
// Explicit .ts extension on this value import lets Node run this file
// directly (see allowImportingTsExtensions in tsconfig.json) - needed by
// the end-to-end suite, which drives the real ProjectContext. Harmless
// for Vite.
import { HistoryManager } from "./HistoryManager.ts";

/**
 * The only place that knows how to turn a beam mutation into an
 * undoable Command. Mirrors wallHistory.ts's WallHistoryController and
 * pillarHistory.ts's PillarHistoryController exactly - see either's
 * docs for the full reasoning. Callers (main.ts, rightSidebar.ts, via
 * CommandExecutor) use these methods instead of calling BeamStore
 * directly, so every beam mutation is automatically recorded. BeamStore
 * itself stays a plain data store with no knowledge of history.
 *
 * Shares the same HistoryManager instance WallHistoryController/
 * PillarHistoryController use (see ProjectContext) - wall, pillar, and
 * beam undo/redo interleave into one global undo stack, not three
 * separate ones.
 *
 * BeamStore validates every write (see validateBeam.ts) and returns a
 * BeamValidationResult instead of throwing. add() and update() check
 * that result: a rejected write is left exactly as BeamStore left it
 * (nothing stored/changed, no subscriber notification) and, to match,
 * no undo/redo Command is recorded for it either - there would be
 * nothing meaningful to undo.
 */
export class BeamHistoryController {
  constructor(
    private readonly beamStore: BeamStore,
    private readonly selectionStore: SelectionStore,
    private readonly history: HistoryManager
  ) {}

  /** Adds a brand-new beam (covers both "Add Beam" and "Duplicate Beam" - a duplicate is just a new beam). */
  add(beam: BeamData): BeamValidationResult {
    const result = this.beamStore.add(beam);
    if (!result.valid) {
      return result; // rejected by validation - nothing was stored, don't record undo history
    }

    this.history.record({
      undo: () => {
        this.beamStore.remove(beam.id);
        this.selectionStore.clear();
      },
      redo: () => {
        this.beamStore.add(beam);
        this.selectionStore.select(beam.id);
      }
    });

    return result;
  }

  /** Removes a beam, snapshotting it first so undo can restore it exactly. */
  remove(id: BeamId): void {
    const snapshot = this.beamStore.get(id);
    if (!snapshot) {
      return;
    }

    this.beamStore.remove(id);
    this.selectionStore.clear();

    this.history.record({
      undo: () => {
        this.beamStore.set(snapshot.id, snapshot);
        this.selectionStore.select(snapshot.id);
      },
      redo: () => {
        this.beamStore.remove(snapshot.id);
        this.selectionStore.clear();
      }
    });
  }

  /** Applies a property edit, snapshotting before/after so undo/redo restore exactly. */
  update(id: BeamId, changes: Partial<Omit<BeamData, "id" | "type">>): BeamValidationResult {
    const before = this.beamStore.get(id);

    const result = this.beamStore.update(id, changes);
    if (!result.valid) {
      return result; // missing id, or rejected by validation - the beam is unchanged either way
    }

    // result.valid implies `before` was found (BeamStore.update() only succeeds when the id exists).
    const after = this.beamStore.get(id);
    if (!before || !after) {
      return result; // shouldn't happen - stay defensive
    }

    this.history.record({
      undo: () => {
        this.beamStore.set(id, before);
        this.selectionStore.select(id);
      },
      redo: () => {
        this.beamStore.set(id, after);
        this.selectionStore.select(id);
      }
    });

    return result;
  }
}
