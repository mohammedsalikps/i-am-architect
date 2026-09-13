import * as THREE from "three";
import type { DoorData } from "../../engine/door/types";
import type { DoorStore } from "../../engine/door/DoorStore";
import type { SelectionStore } from "../../engine/selection/SelectionStore";
import type { VisibilityStore } from "../visibility/VisibilityStore";
import { buildDoorMesh, applyDoorDataToMesh } from "./buildDoorMesh";
import { buildSelectionOutline, refreshSelectionOutline } from "../selectionOutline";

interface DoorEntry {
  mesh: THREE.Mesh;
  outline: THREE.LineSegments;
}

/**
 * Bridges door/selection engine state to the Three.js scene - mirrors
 * WallLayer.ts/PillarLayer.ts/BeamLayer.ts/SlabLayer.ts exactly (see
 * any of their docs for the full reasoning). Creates, updates and
 * removes door meshes as DoorStore changes, and shows/hides a
 * selection outline (the shared selectionOutline.ts helper - no
 * door-specific outline file needed) as SelectionStore changes.
 * Contains no door *data* logic itself.
 *
 * Does not raycast clicks itself - it exposes getMeshes() so the
 * shared SelectionRaycaster can combine door meshes with every other
 * selectable layer's meshes into one click handler.
 */
export class DoorLayer {
  private readonly entries = new Map<string, DoorEntry>();

  constructor(
    private readonly scene: THREE.Scene,
    private readonly doorStore: DoorStore,
    private readonly selectionStore: SelectionStore,
    private readonly visibilityStore: VisibilityStore
  ) {
    this.doorStore.subscribe((doors) => this.syncDoors(doors));
    this.selectionStore.subscribe((selectedId) => this.syncSelection(selectedId));
    this.visibilityStore.subscribe((hidden) => this.syncVisibility(hidden));
  }

  /**
   * Current door meshes, for the shared SelectionRaycaster/
   * ManipulationController to raycast against - hidden doors excluded.
   * See WallLayer.getMeshes()'s own comment for why this filtering has
   * to happen here: THREE.Raycaster doesn't consult `.visible` itself.
   */
  getMeshes(): THREE.Object3D[] {
    return Array.from(this.entries.values())
      .filter((entry) => entry.mesh.visible)
      .map((entry) => entry.mesh);
  }

  private syncDoors(doors: DoorData[]): void {
    const seenIds = new Set<string>();

    for (const door of doors) {
      seenIds.add(door.id);
      const entry = this.entries.get(door.id);

      if (entry) {
        const { dimensionsChanged } = applyDoorDataToMesh(entry.mesh, door);
        if (dimensionsChanged) {
          refreshSelectionOutline(entry.outline, entry.mesh);
        }
      } else {
        const mesh = buildDoorMesh(door);
        const outline = buildSelectionOutline(mesh);
        mesh.add(outline);
        this.scene.add(mesh);
        this.entries.set(door.id, { mesh, outline });
      }
    }

    for (const [id, entry] of this.entries) {
      if (!seenIds.has(id)) {
        this.disposeEntry(entry);
        this.entries.delete(id);
      }
    }

    this.syncSelection(this.selectionStore.get());
    this.syncVisibility(this.visibilityStore.getHidden());
  }

  private syncSelection(selectedId: string | null): void {
    for (const [id, entry] of this.entries) {
      entry.outline.visible = id === selectedId;
    }
  }

  /** Hiding a door never deletes it - only its mesh's own .visible flag changes; the store and undo history are untouched. */
  private syncVisibility(hidden: ReadonlySet<string>): void {
    for (const [id, entry] of this.entries) {
      entry.mesh.visible = !hidden.has(id);
    }
  }

  private disposeEntry(entry: DoorEntry): void {
    this.scene.remove(entry.mesh);
    entry.mesh.geometry.dispose();
    (entry.mesh.material as THREE.Material).dispose();
    entry.outline.geometry.dispose();
    (entry.outline.material as THREE.Material).dispose();
  }
}
