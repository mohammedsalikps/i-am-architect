import * as THREE from "three";
import type { WallData } from "../../engine/wall/types";
import type { WallStore } from "../../engine/wall/WallStore";
import type { DoorStore } from "../../engine/door/DoorStore";
import type { WindowStore } from "../../engine/window/WindowStore";
import type { SelectionStore } from "../../engine/selection/SelectionStore";
import type { VisibilityStore } from "../visibility/VisibilityStore";
import { wallOpeningRects } from "../../engine/openings/hostOpening";
import type { HostPlacement, OpeningSize, WallOpeningRect } from "../../engine/openings/hostOpening";
import { buildWallMesh, applyWallDataToMesh } from "./buildWallMesh";
import { buildBoxOutline, refreshBoxOutline } from "../selectionOutline";

interface WallEntry {
  mesh: THREE.Mesh;
  outline: THREE.LineSegments;
}

/**
 * Bridges wall/selection engine state to the Three.js scene: creates,
 * updates and removes wall meshes as WallStore changes, and shows/hides
 * a selection outline as SelectionStore changes. Contains no wall
 * *data* logic itself - that all lives in the engine stores.
 *
 * A wall is drawn with a hole for every door and window hosted in it, so
 * it also follows the door and window stores: an opening added, moved
 * along its wall, resized, or removed redraws its wall. The outline is
 * always the wall's whole box.
 *
 * Does not raycast clicks itself - it exposes getMeshes() so the
 * shared SelectionRaycaster (src/scene/SelectionRaycaster.ts) can
 * combine wall meshes with every other selectable layer's meshes into
 * one click handler. See that file's docs for why click-handling moved
 * out of this class.
 */
export class WallLayer {
  private readonly entries = new Map<string, WallEntry>();

  constructor(
    private readonly scene: THREE.Scene,
    private readonly wallStore: WallStore,
    private readonly doorStore: DoorStore,
    private readonly windowStore: WindowStore,
    private readonly selectionStore: SelectionStore,
    private readonly visibilityStore: VisibilityStore
  ) {
    const resync = (): void => this.syncWalls(this.wallStore.getAll());
    this.wallStore.subscribe((walls) => this.syncWalls(walls));
    this.doorStore.subscribe(resync);
    this.windowStore.subscribe(resync);
    this.selectionStore.subscribe((selectedId) => this.syncSelection(selectedId));
    this.visibilityStore.subscribe((hidden) => this.syncVisibility(hidden));
  }

  /**
   * Current wall meshes, for the shared SelectionRaycaster/
   * ManipulationController to raycast against - hidden walls excluded.
   * THREE.Raycaster does NOT consult an object's own `.visible` flag on
   * its own (that's a rendering-only concern) - a mesh handed to
   * `intersectObjects()` is picked whether or not it's actually drawn, so
   * this method (not the raycasters) is what keeps a hidden object from
   * being selected or manipulated through its invisible mesh.
   */
  getMeshes(): THREE.Object3D[] {
    return Array.from(this.entries.values())
      .filter((entry) => entry.mesh.visible)
      .map((entry) => entry.mesh);
  }

  /** Each wall's hosted openings, in the wall's frame. */
  private openingsByWall(walls: readonly WallData[]): Map<string, WallOpeningRect[]> {
    const hosted = new Map<string, { size: OpeningSize; placement: HostPlacement }[]>();
    for (const opening of [...this.doorStore.getAll(), ...this.windowStore.getAll()]) {
      if (opening.hostId && opening.hostPlacement) {
        const list = hosted.get(opening.hostId) ?? [];
        list.push({ size: opening.dimensions, placement: opening.hostPlacement });
        hosted.set(opening.hostId, list);
      }
    }
    const rects = new Map<string, WallOpeningRect[]>();
    for (const wall of walls) {
      rects.set(wall.id, wallOpeningRects(wall, hosted.get(wall.id) ?? []));
    }
    return rects;
  }

  private syncWalls(walls: WallData[]): void {
    const seenIds = new Set<string>();
    const openings = this.openingsByWall(walls);

    for (const wall of walls) {
      seenIds.add(wall.id);
      const entry = this.entries.get(wall.id);
      const holes = openings.get(wall.id) ?? [];
      const { length, height, thickness } = wall.dimensions;

      if (entry) {
        const { dimensionsChanged } = applyWallDataToMesh(entry.mesh, wall, holes);
        if (dimensionsChanged) {
          refreshBoxOutline(entry.outline, length, height, thickness);
        }
      } else {
        const mesh = buildWallMesh(wall, holes);
        const outline = buildBoxOutline(length, height, thickness);
        mesh.add(outline);
        this.scene.add(mesh);
        this.entries.set(wall.id, { mesh, outline });
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

  /** Hiding a wall never deletes it - only its mesh's own .visible flag changes; the store and undo history are untouched. */
  private syncVisibility(hidden: ReadonlySet<string>): void {
    for (const [id, entry] of this.entries) {
      entry.mesh.visible = !hidden.has(id);
    }
  }

  private disposeEntry(entry: WallEntry): void {
    this.scene.remove(entry.mesh);
    entry.mesh.geometry.dispose();
    (entry.mesh.material as THREE.Material).dispose();
    entry.outline.geometry.dispose();
    (entry.outline.material as THREE.Material).dispose();
  }
}
