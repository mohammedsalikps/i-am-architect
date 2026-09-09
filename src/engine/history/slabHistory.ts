import type { SlabData, SlabId } from "../slab/types";
import type { SlabStore } from "../slab/SlabStore";
import type { SlabValidationResult } from "../slab/validateSlab";
import type { SelectionStore } from "../selection/SelectionStore";
import { HistoryManager } from "./HistoryManager";

/**
 * The only place that knows how to turn a slab mutation into an
 * undoable Command. Mirrors wallHistory.ts's WallHistoryController,
 * pillarHistory.ts's PillarHistoryController, and beamHistory.ts's
 * BeamHistoryController exactly - see any of their docs for the full
 * reasoning. Callers (main.ts, rightSidebar.ts, via CommandExecutor)
 * use these methods instead of calling SlabStore directly, so every
 * slab mutation is automatically recorded. SlabStore itself stays a
 * plain data store with no knowledge of history.
 *
 * Shares the same HistoryManager instance every other object type's
 * history controller uses (see ProjectContext) - wall, pillar, beam,
 * and slab undo/redo interleave into one global undo stack, not four
 * separate ones.
 *
 * SlabStore validates every write (see validateSlab.ts) and returns a
 * SlabValidationResult instead of throwing. add() and update() check
 * that result: a rejected write is left exactly as SlabStore left it
 * (nothing stored/changed, no subscriber notification) and, to match,
 * no undo/redo Command is recorded for it either - there would be
 * nothing meaningful to undo.
 */
export class SlabHistoryController {
  constructor(
    private readonly slabStore: SlabStore,
    private readonly selectionStore: SelectionStore,
    private readonly history: HistoryManager
  ) {}

  /** Adds a brand-new slab (covers both "Add Slab" and "Duplicate Slab" - a duplicate is just a new slab). */
  add(slab: SlabData): SlabValidationResult {
    const result = this.slabStore.add(slab);
    if (!result.valid) {
      return result; // rejected by validation - nothing was stored, don't record undo history
    }

    this.history.record({
      undo: () => {
        this.slabStore.remove(slab.id);
        this.selectionStore.clear();
      },
      redo: () => {
        this.slabStore.add(slab);
        this.selectionStore.select(slab.id);
      }
    });

    return result;
  }

  /** Removes a slab, snapshotting it first so undo can restore it exactly. */
  remove(id: SlabId): void {
    const snapshot = this.slabStore.get(id);
    if (!snapshot) {
      return;
    }

    this.slabStore.remove(id);
    this.selectionStore.clear();

    this.history.record({
      undo: () => {
        this.slabStore.set(snapshot.id, snapshot);
        this.selectionStore.select(snapshot.id);
      },
      redo: () => {
        this.slabStore.remove(snapshot.id);
        this.selectionStore.clear();
      }
    });
  }

  /** Applies a property edit, snapshotting before/after so undo/redo restore exactly. */
  update(id: SlabId, changes: Partial<Omit<SlabData, "id" | "type">>): SlabValidationResult {
    const before = this.slabStore.get(id);

    const result = this.slabStore.update(id, changes);
    if (!result.valid) {
      return result; // missing id, or rejected by validation - the slab is unchanged either way
    }

    // result.valid implies `before` was found (SlabStore.update() only succeeds when the id exists).
    const after = this.slabStore.get(id);
    if (!before || !after) {
      return result; // shouldn't happen - stay defensive
    }

    this.history.record({
      undo: () => {
        this.slabStore.set(id, before);
        this.selectionStore.select(id);
      },
      redo: () => {
        this.slabStore.set(id, after);
        this.selectionStore.select(id);
      }
    });

    return result;
  }
}
