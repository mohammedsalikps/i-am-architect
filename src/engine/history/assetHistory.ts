import type { AssetData, AssetId } from "../assets/types";
import type { AssetChanges, AssetStore } from "../assets/AssetStore";
import type { AssetValidationResult } from "../assets/validateAsset";
import type { SelectionStore } from "../selection/SelectionStore";
// Explicit .ts extension on this value import lets Node run this file
// directly - needed by the suites that drive the real ProjectContext.
// Harmless for Vite.
import { HistoryManager } from "./HistoryManager.ts";

/**
 * Turns asset mutations into undoable Commands - the same controller
 * every object type has (see wallHistory.ts/elementHistory.ts for the
 * full reasoning), written once for every design asset. Shares the one
 * HistoryManager (see ProjectContext), so placing/moving/deleting a sofa
 * interleaves with every other edit in a single undo stack - manually
 * placed or AI-placed alike (task section 17). A write AssetStore
 * rejects records nothing.
 */
export class AssetHistoryController {
  constructor(
    private readonly assetStore: AssetStore,
    private readonly selectionStore: SelectionStore,
    private readonly history: HistoryManager
  ) {}

  /** Adds a new asset instance (covers placement and duplicate - a duplicate is just a new instance). */
  add(asset: AssetData): AssetValidationResult {
    const result = this.assetStore.add(asset);
    if (!result.valid) {
      return result;
    }

    this.history.record({
      undo: () => {
        this.assetStore.remove(asset.id);
        this.selectionStore.clear();
      },
      redo: () => {
        this.assetStore.add(asset);
        this.selectionStore.select(asset.id);
      }
    });

    return result;
  }

  /** Removes an asset instance, snapshotting it first so undo restores it exactly. */
  remove(id: AssetId): void {
    const snapshot = this.assetStore.get(id);
    if (!snapshot) {
      return;
    }

    this.assetStore.remove(id);
    this.selectionStore.clear();

    this.history.record({
      undo: () => {
        this.assetStore.set(snapshot.id, snapshot);
        this.selectionStore.select(snapshot.id);
      },
      redo: () => {
        this.assetStore.remove(snapshot.id);
        this.selectionStore.clear();
      }
    });
  }

  /** Applies a property edit (move/rotate/resize/material/color), snapshotting before/after so undo/redo restore exactly. */
  update(id: AssetId, changes: AssetChanges): AssetValidationResult {
    const before = this.assetStore.get(id);

    const result = this.assetStore.update(id, changes);
    if (!result.valid) {
      return result;
    }

    const after = this.assetStore.get(id);
    if (!before || !after) {
      return result;
    }

    this.history.record({
      undo: () => {
        this.assetStore.set(id, before);
        this.selectionStore.select(id);
      },
      redo: () => {
        this.assetStore.set(id, after);
        this.selectionStore.select(id);
      }
    });

    return result;
  }
}
