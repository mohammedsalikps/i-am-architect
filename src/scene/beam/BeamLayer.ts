import * as THREE from "three";
import type { BeamData } from "../../engine/beam/types";
import type { BeamStore } from "../../engine/beam/BeamStore";
import type { SelectionStore } from "../../engine/selection/SelectionStore";
import type { VisibilityStore } from "../visibility/VisibilityStore";
import { buildBeamMesh, applyBeamDataToMesh } from "./buildBeamMesh";
import { buildSelectionOutline, refreshSelectionOutline } from "../selectionOutline";

interface BeamEntry {
  mesh: THREE.Mesh;
  outline: THREE.LineSegments;
}

/**
 * Bridges beam/selection engine state to the Three.js scene - mirrors
 * WallLayer.ts/PillarLayer.ts exactly (see either's docs for the full
 * reasoning). Creates, updates and removes beam meshes as BeamStore
 * changes, and shows/hides a selection outline (the shared
 * selectionOutline.ts helper - no beam-specific outline file needed)
 * as SelectionStore changes. Contains no beam *data* logic itself.
 *
 * Does not raycast clicks itself - it exposes getMeshes() so the
 * shared SelectionRaycaster can combine beam meshes with every other
 * selectable layer's meshes into one click handler.
 */
export class BeamLayer {
  private readonly entries = new Map<string, BeamEntry>();

  constructor(
    private readonly scene: THREE.Scene,
    private readonly beamStore: BeamStore,
    private readonly selectionStore: SelectionStore,
    private readonly visibilityStore: VisibilityStore
  ) {
    this.beamStore.subscribe((beams) => this.syncBeams(beams));
    this.selectionStore.subscribe((selectedId) => this.syncSelection(selectedId));
    this.visibilityStore.subscribe((hidden) => this.syncVisibility(hidden));
  }

  /** Current beam meshes, for the shared SelectionRaycaster to raycast against. */
  getMeshes(): THREE.Object3D[] {
    return Array.from(this.entries.values(), (entry) => entry.mesh);
  }

  private syncBeams(beams: BeamData[]): void {
    const seenIds = new Set<string>();

    for (const beam of beams) {
      seenIds.add(beam.id);
      const entry = this.entries.get(beam.id);

      if (entry) {
        const { dimensionsChanged } = applyBeamDataToMesh(entry.mesh, beam);
        if (dimensionsChanged) {
          refreshSelectionOutline(entry.outline, entry.mesh);
        }
      } else {
        const mesh = buildBeamMesh(beam);
        const outline = buildSelectionOutline(mesh);
        mesh.add(outline);
        this.scene.add(mesh);
        this.entries.set(beam.id, { mesh, outline });
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

  /** Hiding a beam never deletes it - only its mesh's own .visible flag changes; the store and undo history are untouched. */
  private syncVisibility(hidden: ReadonlySet<string>): void {
    for (const [id, entry] of this.entries) {
      entry.mesh.visible = !hidden.has(id);
    }
  }

  private disposeEntry(entry: BeamEntry): void {
    this.scene.remove(entry.mesh);
    entry.mesh.geometry.dispose();
    (entry.mesh.material as THREE.Material).dispose();
    entry.outline.geometry.dispose();
    (entry.outline.material as THREE.Material).dispose();
  }
}
