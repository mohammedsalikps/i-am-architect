import type { WallData, WallId } from "../wall/types";
import type { WallStore } from "../wall/WallStore";
import type { SelectionStore } from "../selection/SelectionStore";
import { HistoryManager } from "./HistoryManager";

/**
 * The only place that knows how to turn a wall mutation into an
 * undoable Command. Callers (main.ts, rightSidebar.ts) use these
 * methods instead of calling WallStore directly, so every wall
 * mutation is automatically recorded. WallStore itself stays a plain
 * data store with no knowledge of history.
 *
 * WallStore validates every write (see validateWall.ts) and returns a
 * WallValidationResult instead of throwing. add() and update() check
 * that result: a rejected write is left exactly as WallStore left it
 * (nothing stored/changed, no subscriber notification) and, to match,
 * no undo/redo Command is recorded for it either - there would be
 * nothing meaningful to undo.
 */
export class WallHistoryController {
  constructor(
    private readonly wallStore: WallStore,
    private readonly selectionStore: SelectionStore,
    private readonly history: HistoryManager
  ) {}

  /** Adds a brand-new wall (covers both "Add Wall" and "Duplicate Wall" - a duplicate is just a new wall). */
  add(wall: WallData): void {
    const result = this.wallStore.add(wall);
    if (!result.valid) {
      return; // rejected by validation - nothing was stored, don't record undo history
    }

    this.history.record({
      undo: () => {
        this.wallStore.remove(wall.id);
        this.selectionStore.clear();
      },
      redo: () => {
        this.wallStore.add(wall);
        this.selectionStore.select(wall.id);
      }
    });
  }

  /** Removes a wall, snapshotting it first so undo can restore it exactly. */
  remove(id: WallId): void {
    const snapshot = this.wallStore.get(id);
    if (!snapshot) {
      return;
    }

    this.wallStore.remove(id);
    this.selectionStore.clear();

    this.history.record({
      undo: () => {
        this.wallStore.set(snapshot.id, snapshot);
        this.selectionStore.select(snapshot.id);
      },
      redo: () => {
        this.wallStore.remove(snapshot.id);
        this.selectionStore.clear();
      }
    });
  }

  /** Applies a property edit, snapshotting before/after so undo/redo restore exactly. */
  update(id: WallId, changes: Partial<Omit<WallData, "id" | "type">>): void {
    const before = this.wallStore.get(id);
    if (!before) {
      return;
    }

    const result = this.wallStore.update(id, changes);
    if (!result.valid) {
      return; // rejected by validation - the wall is unchanged, don't record undo history
    }

    const after = this.wallStore.get(id);
    if (!after) {
      return; // shouldn't happen - stay defensive
    }

    this.history.record({
      undo: () => {
        this.wallStore.set(id, before);
        this.selectionStore.select(id);
      },
      redo: () => {
        this.wallStore.set(id, after);
        this.selectionStore.select(id);
      }
    });
  }
}
