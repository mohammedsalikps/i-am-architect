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
 */
export class WallHistoryController {
  constructor(
    private readonly wallStore: WallStore,
    private readonly selectionStore: SelectionStore,
    private readonly history: HistoryManager
  ) {}

  /** Adds a brand-new wall (covers both "Add Wall" and "Duplicate Wall" - a duplicate is just a new wall). */
  add(wall: WallData): void {
    this.wallStore.add(wall);

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

    this.wallStore.update(id, changes);

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
