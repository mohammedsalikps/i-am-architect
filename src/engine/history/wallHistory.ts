import type { WallData, WallId } from "../wall/types";
import type { WallStore } from "../wall/WallStore";
import type { WallValidationResult } from "../wall/validateWall";
import type { SelectionStore } from "../selection/SelectionStore";
// Explicit .ts extension on this value import lets Node run this file
// directly (see allowImportingTsExtensions in tsconfig.json) - needed by
// the end-to-end suite, which drives the real ProjectContext. Harmless
// for Vite.
import { HistoryManager } from "./HistoryManager.ts";

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
 * nothing meaningful to undo. add() and update() pass the same
 * WallValidationResult back to their own caller too, so a caller like
 * CommandExecutor (src/engine/commands/) can report success/failure
 * without duplicating WallStore's validation logic.
 */
export class WallHistoryController {
  constructor(
    private readonly wallStore: WallStore,
    private readonly selectionStore: SelectionStore,
    private readonly history: HistoryManager
  ) {}

  /** Adds a brand-new wall (covers both "Add Wall" and "Duplicate Wall" - a duplicate is just a new wall). */
  add(wall: WallData): WallValidationResult {
    const result = this.wallStore.add(wall);
    if (!result.valid) {
      return result; // rejected by validation - nothing was stored, don't record undo history
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

    return result;
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
  update(id: WallId, changes: Partial<Omit<WallData, "id" | "type">>): WallValidationResult {
    const before = this.wallStore.get(id);

    const result = this.wallStore.update(id, changes);
    if (!result.valid) {
      return result; // missing id, or rejected by validation - the wall is unchanged either way
    }

    // result.valid implies `before` was found (WallStore.update() only succeeds when the id exists).
    const after = this.wallStore.get(id);
    if (!before || !after) {
      return result; // shouldn't happen - stay defensive
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

    return result;
  }
}
