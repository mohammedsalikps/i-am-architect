import type { PillarData, PillarId } from "../pillar/types";
import type { PillarStore } from "../pillar/PillarStore";
import type { PillarValidationResult } from "../pillar/validatePillar";
import type { SelectionStore } from "../selection/SelectionStore";
import { HistoryManager } from "./HistoryManager";

/**
 * The only place that knows how to turn a pillar mutation into an
 * undoable Command. Mirrors wallHistory.ts's WallHistoryController
 * exactly - see its docs for the full reasoning. Callers (main.ts,
 * rightSidebar.ts, via CommandExecutor) use these methods instead of
 * calling PillarStore directly, so every pillar mutation is
 * automatically recorded. PillarStore itself stays a plain data store
 * with no knowledge of history.
 *
 * Shares the same HistoryManager instance WallHistoryController uses
 * (see ProjectContext) - wall and pillar undo/redo interleave into one
 * global undo stack, not two separate ones.
 *
 * PillarStore validates every write (see validatePillar.ts) and
 * returns a PillarValidationResult instead of throwing. add() and
 * update() check that result: a rejected write is left exactly as
 * PillarStore left it (nothing stored/changed, no subscriber
 * notification) and, to match, no undo/redo Command is recorded for it
 * either - there would be nothing meaningful to undo.
 */
export class PillarHistoryController {
  constructor(
    private readonly pillarStore: PillarStore,
    private readonly selectionStore: SelectionStore,
    private readonly history: HistoryManager
  ) {}

  /** Adds a brand-new pillar (covers both "Add Pillar" and "Duplicate Pillar" - a duplicate is just a new pillar). */
  add(pillar: PillarData): PillarValidationResult {
    const result = this.pillarStore.add(pillar);
    if (!result.valid) {
      return result; // rejected by validation - nothing was stored, don't record undo history
    }

    this.history.record({
      undo: () => {
        this.pillarStore.remove(pillar.id);
        this.selectionStore.clear();
      },
      redo: () => {
        this.pillarStore.add(pillar);
        this.selectionStore.select(pillar.id);
      }
    });

    return result;
  }

  /** Removes a pillar, snapshotting it first so undo can restore it exactly. */
  remove(id: PillarId): void {
    const snapshot = this.pillarStore.get(id);
    if (!snapshot) {
      return;
    }

    this.pillarStore.remove(id);
    this.selectionStore.clear();

    this.history.record({
      undo: () => {
        this.pillarStore.set(snapshot.id, snapshot);
        this.selectionStore.select(snapshot.id);
      },
      redo: () => {
        this.pillarStore.remove(snapshot.id);
        this.selectionStore.clear();
      }
    });
  }

  /** Applies a property edit, snapshotting before/after so undo/redo restore exactly. */
  update(id: PillarId, changes: Partial<Omit<PillarData, "id" | "type">>): PillarValidationResult {
    const before = this.pillarStore.get(id);

    const result = this.pillarStore.update(id, changes);
    if (!result.valid) {
      return result; // missing id, or rejected by validation - the pillar is unchanged either way
    }

    // result.valid implies `before` was found (PillarStore.update() only succeeds when the id exists).
    const after = this.pillarStore.get(id);
    if (!before || !after) {
      return result; // shouldn't happen - stay defensive
    }

    this.history.record({
      undo: () => {
        this.pillarStore.set(id, before);
        this.selectionStore.select(id);
      },
      redo: () => {
        this.pillarStore.set(id, after);
        this.selectionStore.select(id);
      }
    });

    return result;
  }
}
