import * as THREE from "three";
import type { PillarData } from "../../engine/pillar/types";
import type { PillarStore } from "../../engine/pillar/PillarStore";
import type { SelectionStore } from "../../engine/selection/SelectionStore";
import type { VisibilityStore } from "../visibility/VisibilityStore";
import { buildPillarMesh, applyPillarDataToMesh } from "./buildPillarMesh";
import { buildSelectionOutline, refreshSelectionOutline } from "../selectionOutline";

interface PillarEntry {
  mesh: THREE.Mesh;
  outline: THREE.LineSegments;
}

/**
 * Bridges pillar/selection engine state to the Three.js scene - mirrors
 * WallLayer.ts exactly (see its docs for the full reasoning). Creates,
 * updates and removes pillar meshes as PillarStore changes, and shows/
 * hides a selection outline as SelectionStore changes. Contains no
 * pillar *data* logic itself.
 *
 * Does not raycast clicks itself - it exposes getMeshes() so the
 * shared SelectionRaycaster can combine pillar meshes with every other
 * selectable layer's meshes into one click handler.
 */
export class PillarLayer {
  private readonly entries = new Map<string, PillarEntry>();

  constructor(
    private readonly scene: THREE.Scene,
    private readonly pillarStore: PillarStore,
    private readonly selectionStore: SelectionStore,
    private readonly visibilityStore: VisibilityStore
  ) {
    this.pillarStore.subscribe((pillars) => this.syncPillars(pillars));
    this.selectionStore.subscribe((selectedId) => this.syncSelection(selectedId));
    this.visibilityStore.subscribe((hidden) => this.syncVisibility(hidden));
  }

  /**
   * Current pillar meshes, for the shared SelectionRaycaster/
   * ManipulationController to raycast against - hidden pillars excluded.
   * See WallLayer.getMeshes()'s own comment for why this filtering has
   * to happen here: THREE.Raycaster doesn't consult `.visible` itself.
   */
  getMeshes(): THREE.Object3D[] {
    return Array.from(this.entries.values())
      .filter((entry) => entry.mesh.visible)
      .map((entry) => entry.mesh);
  }

  private syncPillars(pillars: PillarData[]): void {
    const seenIds = new Set<string>();

    for (const pillar of pillars) {
      seenIds.add(pillar.id);
      const entry = this.entries.get(pillar.id);

      if (entry) {
        const { dimensionsChanged } = applyPillarDataToMesh(entry.mesh, pillar);
        if (dimensionsChanged) {
          refreshSelectionOutline(entry.outline, entry.mesh);
        }
      } else {
        const mesh = buildPillarMesh(pillar);
        const outline = buildSelectionOutline(mesh);
        mesh.add(outline);
        this.scene.add(mesh);
        this.entries.set(pillar.id, { mesh, outline });
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

  /** Hiding a pillar never deletes it - only its mesh's own .visible flag changes; the store and undo history are untouched. */
  private syncVisibility(hidden: ReadonlySet<string>): void {
    for (const [id, entry] of this.entries) {
      entry.mesh.visible = !hidden.has(id);
    }
  }

  private disposeEntry(entry: PillarEntry): void {
    this.scene.remove(entry.mesh);
    entry.mesh.geometry.dispose();
    (entry.mesh.material as THREE.Material).dispose();
    entry.outline.geometry.dispose();
    (entry.outline.material as THREE.Material).dispose();
  }
}
