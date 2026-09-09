import type { WindowData, WindowId } from "../window/types";
import type { WindowStore } from "../window/WindowStore";
import type { WindowValidationResult } from "../window/validateWindow";
import type { SelectionStore } from "../selection/SelectionStore";
// Explicit .ts extension on this value import lets Node run this file
// directly (see allowImportingTsExtensions in tsconfig.json) - needed by
// the end-to-end suite, which drives the real ProjectContext. Harmless
// for Vite.
import { HistoryManager } from "./HistoryManager.ts";

/**
 * The only place that knows how to turn a window mutation into an
 * undoable Command. Mirrors doorHistory.ts's DoorHistoryController and
 * every sibling *HistoryController exactly - see any of their docs for
 * the full reasoning. Callers (main.ts, rightSidebar.ts, via
 * CommandExecutor) use these methods instead of calling WindowStore
 * directly, so every window mutation is automatically recorded.
 * WindowStore itself stays a plain data store with no knowledge of
 * history.
 *
 * Shares the same HistoryManager instance every other object type's
 * history controller uses (see ProjectContext) - undo/redo for every
 * object type interleaves into one global undo stack.
 *
 * WindowStore validates every write (see validateWindow.ts) and
 * returns a WindowValidationResult instead of throwing. add() and
 * update() check that result: a rejected write is left exactly as
 * WindowStore left it (nothing stored/changed, no subscriber
 * notification) and, to match, no undo/redo Command is recorded for it
 * either - there would be nothing meaningful to undo.
 */
export class WindowHistoryController {
  constructor(
    private readonly windowStore: WindowStore,
    private readonly selectionStore: SelectionStore,
    private readonly history: HistoryManager
  ) {}

  /** Adds a brand-new window (covers both "Add Window" and "Duplicate Window" - a duplicate is just a new window). */
  add(windowData: WindowData): WindowValidationResult {
    const result = this.windowStore.add(windowData);
    if (!result.valid) {
      return result; // rejected by validation - nothing was stored, don't record undo history
    }

    this.history.record({
      undo: () => {
        this.windowStore.remove(windowData.id);
        this.selectionStore.clear();
      },
      redo: () => {
        this.windowStore.add(windowData);
        this.selectionStore.select(windowData.id);
      }
    });

    return result;
  }

  /** Removes a window, snapshotting it first so undo can restore it exactly. */
  remove(id: WindowId): void {
    const snapshot = this.windowStore.get(id);
    if (!snapshot) {
      return;
    }

    this.windowStore.remove(id);
    this.selectionStore.clear();

    this.history.record({
      undo: () => {
        this.windowStore.set(snapshot.id, snapshot);
        this.selectionStore.select(snapshot.id);
      },
      redo: () => {
        this.windowStore.remove(snapshot.id);
        this.selectionStore.clear();
      }
    });
  }

  /** Applies a property edit, snapshotting before/after so undo/redo restore exactly. */
  update(id: WindowId, changes: Partial<Omit<WindowData, "id" | "type">>): WindowValidationResult {
    const before = this.windowStore.get(id);

    const result = this.windowStore.update(id, changes);
    if (!result.valid) {
      return result; // missing id, or rejected by validation - the window is unchanged either way
    }

    // result.valid implies `before` was found (WindowStore.update() only succeeds when the id exists).
    const after = this.windowStore.get(id);
    if (!before || !after) {
      return result; // shouldn't happen - stay defensive
    }

    this.history.record({
      undo: () => {
        this.windowStore.set(id, before);
        this.selectionStore.select(id);
      },
      redo: () => {
        this.windowStore.set(id, after);
        this.selectionStore.select(id);
      }
    });

    return result;
  }
}
