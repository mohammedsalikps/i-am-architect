import * as THREE from "three";
import type { SlabData } from "../../engine/slab/types";
import type { SlabStore } from "../../engine/slab/SlabStore";
import type { SelectionStore } from "../../engine/selection/SelectionStore";
import type { VisibilityStore } from "../visibility/VisibilityStore";
import { buildSlabMesh, applySlabDataToMesh } from "./buildSlabMesh";
import { buildSelectionOutline, refreshSelectionOutline } from "../selectionOutline";

interface SlabEntry {
  mesh: THREE.Mesh;
  outline: THREE.LineSegments;
}

/**
 * Bridges slab/selection engine state to the Three.js scene - mirrors
 * WallLayer.ts/PillarLayer.ts/BeamLayer.ts exactly (see any of their
 * docs for the full reasoning). Creates, updates and removes slab
 * meshes as SlabStore changes, and shows/hides a selection outline
 * (the shared selectionOutline.ts helper - no slab-specific outline
 * file needed) as SelectionStore changes. Contains no slab *data*
 * logic itself.
 *
 * Does not raycast clicks itself - it exposes getMeshes() so the
 * shared SelectionRaycaster can combine slab meshes with every other
 * selectable layer's meshes into one click handler.
 */
export class SlabLayer {
  private readonly entries = new Map<string, SlabEntry>();

  constructor(
    private readonly scene: THREE.Scene,
    private readonly slabStore: SlabStore,
    private readonly selectionStore: SelectionStore,
    private readonly visibilityStore: VisibilityStore
  ) {
    this.slabStore.subscribe((slabs) => this.syncSlabs(slabs));
    this.selectionStore.subscribe((selectedId) => this.syncSelection(selectedId));
    this.visibilityStore.subscribe((hidden) => this.syncVisibility(hidden));
  }

  /** Current slab meshes, for the shared SelectionRaycaster to raycast against. */
  getMeshes(): THREE.Object3D[] {
    return Array.from(this.entries.values(), (entry) => entry.mesh);
  }

  private syncSlabs(slabs: SlabData[]): void {
    const seenIds = new Set<string>();

    for (const slab of slabs) {
      seenIds.add(slab.id);
      const entry = this.entries.get(slab.id);

      if (entry) {
        const { dimensionsChanged } = applySlabDataToMesh(entry.mesh, slab);
        if (dimensionsChanged) {
          refreshSelectionOutline(entry.outline, entry.mesh);
        }
      } else {
        const mesh = buildSlabMesh(slab);
        const outline = buildSelectionOutline(mesh);
        mesh.add(outline);
        this.scene.add(mesh);
        this.entries.set(slab.id, { mesh, outline });
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

  /** Hiding a slab never deletes it - only its mesh's own .visible flag changes; the store and undo history are untouched. */
  private syncVisibility(hidden: ReadonlySet<string>): void {
    for (const [id, entry] of this.entries) {
      entry.mesh.visible = !hidden.has(id);
    }
  }

  private disposeEntry(entry: SlabEntry): void {
    this.scene.remove(entry.mesh);
    entry.mesh.geometry.dispose();
    (entry.mesh.material as THREE.Material).dispose();
    entry.outline.geometry.dispose();
    (entry.outline.material as THREE.Material).dispose();
  }
}
