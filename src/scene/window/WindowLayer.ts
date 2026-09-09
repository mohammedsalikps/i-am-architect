import * as THREE from "three";
import type { WindowData } from "../../engine/window/types";
import type { WindowStore } from "../../engine/window/WindowStore";
import type { SelectionStore } from "../../engine/selection/SelectionStore";
import { buildWindowMesh, applyWindowDataToMesh } from "./buildWindowMesh";
import { buildSelectionOutline, refreshSelectionOutline } from "../selectionOutline";

interface WindowEntry {
  mesh: THREE.Mesh;
  outline: THREE.LineSegments;
}

/**
 * Bridges window/selection engine state to the Three.js scene -
 * mirrors DoorLayer.ts and every sibling *Layer exactly (see any of
 * their docs for the full reasoning). Creates, updates and removes
 * window meshes as WindowStore changes, and shows/hides a selection
 * outline (the shared selectionOutline.ts helper - no window-specific
 * outline file needed) as SelectionStore changes. Contains no window
 * *data* logic itself.
 *
 * Does not raycast clicks itself - it exposes getMeshes() so the
 * shared SelectionRaycaster can combine window meshes with every other
 * selectable layer's meshes into one click handler.
 */
export class WindowLayer {
  private readonly entries = new Map<string, WindowEntry>();

  constructor(
    private readonly scene: THREE.Scene,
    private readonly windowStore: WindowStore,
    private readonly selectionStore: SelectionStore
  ) {
    this.windowStore.subscribe((windows) => this.syncWindows(windows));
    this.selectionStore.subscribe((selectedId) => this.syncSelection(selectedId));
  }

  /** Current window meshes, for the shared SelectionRaycaster to raycast against. */
  getMeshes(): THREE.Object3D[] {
    return Array.from(this.entries.values(), (entry) => entry.mesh);
  }

  private syncWindows(windows: WindowData[]): void {
    const seenIds = new Set<string>();

    for (const windowData of windows) {
      seenIds.add(windowData.id);
      const entry = this.entries.get(windowData.id);

      if (entry) {
        const { dimensionsChanged } = applyWindowDataToMesh(entry.mesh, windowData);
        if (dimensionsChanged) {
          refreshSelectionOutline(entry.outline, entry.mesh);
        }
      } else {
        const mesh = buildWindowMesh(windowData);
        const outline = buildSelectionOutline(mesh);
        mesh.add(outline);
        this.scene.add(mesh);
        this.entries.set(windowData.id, { mesh, outline });
      }
    }

    for (const [id, entry] of this.entries) {
      if (!seenIds.has(id)) {
        this.disposeEntry(entry);
        this.entries.delete(id);
      }
    }

    this.syncSelection(this.selectionStore.get());
  }

  private syncSelection(selectedId: string | null): void {
    for (const [id, entry] of this.entries) {
      entry.outline.visible = id === selectedId;
    }
  }

  private disposeEntry(entry: WindowEntry): void {
    this.scene.remove(entry.mesh);
    entry.mesh.geometry.dispose();
    (entry.mesh.material as THREE.Material).dispose();
    entry.outline.geometry.dispose();
    (entry.outline.material as THREE.Material).dispose();
  }
}
