import type { DoorData, DoorId } from "../door/types";
import type { DoorStore } from "../door/DoorStore";
import type { DoorValidationResult } from "../door/validateDoor";
import type { SelectionStore } from "../selection/SelectionStore";
// Explicit .ts extension on this value import lets Node run this file
// directly (see allowImportingTsExtensions in tsconfig.json) - needed by
// the end-to-end suite, which drives the real ProjectContext. Harmless
// for Vite.
import { HistoryManager } from "./HistoryManager.ts";

/**
 * The only place that knows how to turn a door mutation into an
 * undoable Command. Mirrors wallHistory.ts's WallHistoryController and
 * every sibling *HistoryController exactly - see any of their docs for
 * the full reasoning. Callers (main.ts, rightSidebar.ts, via
 * CommandExecutor) use these methods instead of calling DoorStore
 * directly, so every door mutation is automatically recorded. DoorStore
 * itself stays a plain data store with no knowledge of history.
 *
 * Shares the same HistoryManager instance every other object type's
 * history controller uses (see ProjectContext) - undo/redo for every
 * object type interleaves into one global undo stack.
 *
 * DoorStore validates every write (see validateDoor.ts) and returns a
 * DoorValidationResult instead of throwing. add() and update() check
 * that result: a rejected write is left exactly as DoorStore left it
 * (nothing stored/changed, no subscriber notification) and, to match,
 * no undo/redo Command is recorded for it either - there would be
 * nothing meaningful to undo.
 */
export class DoorHistoryController {
  constructor(
    private readonly doorStore: DoorStore,
    private readonly selectionStore: SelectionStore,
    private readonly history: HistoryManager
  ) {}

  /** Adds a brand-new door (covers both "Add Door" and "Duplicate Door" - a duplicate is just a new door). */
  add(door: DoorData): DoorValidationResult {
    const result = this.doorStore.add(door);
    if (!result.valid) {
      return result; // rejected by validation - nothing was stored, don't record undo history
    }

    this.history.record({
      undo: () => {
        this.doorStore.remove(door.id);
        this.selectionStore.clear();
      },
      redo: () => {
        this.doorStore.add(door);
        this.selectionStore.select(door.id);
      }
    });

    return result;
  }

  /** Removes a door, snapshotting it first so undo can restore it exactly. */
  remove(id: DoorId): void {
    const snapshot = this.doorStore.get(id);
    if (!snapshot) {
      return;
    }

    this.doorStore.remove(id);
    this.selectionStore.clear();

    this.history.record({
      undo: () => {
        this.doorStore.set(snapshot.id, snapshot);
        this.selectionStore.select(snapshot.id);
      },
      redo: () => {
        this.doorStore.remove(snapshot.id);
        this.selectionStore.clear();
      }
    });
  }

  /** Applies a property edit, snapshotting before/after so undo/redo restore exactly. */
  update(id: DoorId, changes: Partial<Omit<DoorData, "id" | "type">>): DoorValidationResult {
    const before = this.doorStore.get(id);

    const result = this.doorStore.update(id, changes);
    if (!result.valid) {
      return result; // missing id, or rejected by validation - the door is unchanged either way
    }

    // result.valid implies `before` was found (DoorStore.update() only succeeds when the id exists).
    const after = this.doorStore.get(id);
    if (!before || !after) {
      return result; // shouldn't happen - stay defensive
    }

    this.history.record({
      undo: () => {
        this.doorStore.set(id, before);
        this.selectionStore.select(id);
      },
      redo: () => {
        this.doorStore.set(id, after);
        this.selectionStore.select(id);
      }
    });

    return result;
  }
}
