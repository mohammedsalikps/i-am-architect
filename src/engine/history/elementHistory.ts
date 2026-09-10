import type { ElementData, ElementId } from "../elements/types";
import type { ElementChanges, ElementStore } from "../elements/ElementStore";
import type { ElementValidationResult } from "../elements/validateElement";
import type { SelectionStore } from "../selection/SelectionStore";
// Explicit .ts extension on this value import lets Node run this file
// directly - needed by the suites that drive the real ProjectContext.
// Harmless for Vite.
import { HistoryManager } from "./HistoryManager.ts";

/**
 * Turns element mutations into undoable Commands - the same controller
 * every object type has (see wallHistory.ts for the full reasoning),
 * written once for every element kind. Shares the one HistoryManager
 * (see ProjectContext), so element edits interleave with wall, pillar,
 * and every other edit in a single undo stack. A write ElementStore
 * rejects records nothing.
 */
export class ElementHistoryController {
  constructor(
    private readonly elementStore: ElementStore,
    private readonly selectionStore: SelectionStore,
    private readonly history: HistoryManager
  ) {}

  /** Adds a new element (covers add and duplicate - a duplicate is just a new element). */
  add(element: ElementData): ElementValidationResult {
    const result = this.elementStore.add(element);
    if (!result.valid) {
      return result;
    }

    this.history.record({
      undo: () => {
        this.elementStore.remove(element.id);
        this.selectionStore.clear();
      },
      redo: () => {
        this.elementStore.add(element);
        this.selectionStore.select(element.id);
      }
    });

    return result;
  }

  /** Removes an element, snapshotting it first so undo restores it exactly. */
  remove(id: ElementId): void {
    const snapshot = this.elementStore.get(id);
    if (!snapshot) {
      return;
    }

    this.elementStore.remove(id);
    this.selectionStore.clear();

    this.history.record({
      undo: () => {
        this.elementStore.set(snapshot.id, snapshot);
        this.selectionStore.select(snapshot.id);
      },
      redo: () => {
        this.elementStore.remove(snapshot.id);
        this.selectionStore.clear();
      }
    });
  }

  /** Applies a property edit, snapshotting before/after so undo/redo restore exactly. */
  update(id: ElementId, changes: ElementChanges): ElementValidationResult {
    const before = this.elementStore.get(id);

    const result = this.elementStore.update(id, changes);
    if (!result.valid) {
      return result;
    }

    const after = this.elementStore.get(id);
    if (!before || !after) {
      return result;
    }

    this.history.record({
      undo: () => {
        this.elementStore.set(id, before);
        this.selectionStore.select(id);
      },
      redo: () => {
        this.elementStore.set(id, after);
        this.selectionStore.select(id);
      }
    });

    return result;
  }
}
