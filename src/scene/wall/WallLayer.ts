import * as THREE from "three";
import type { WallData } from "../../engine/wall/types";
import type { WallStore } from "../../engine/wall/WallStore";
import type { SelectionStore } from "../../engine/selection/SelectionStore";
import { buildWallMesh, applyWallDataToMesh } from "./buildWallMesh";
import { buildWallOutline, refreshWallOutline } from "./wallOutline";

interface WallEntry {
  mesh: THREE.Mesh;
  outline: THREE.LineSegments;
}

/** Pointer must stay within this many pixels between down/up to count as a click rather than an orbit/pan drag. */
const CLICK_DRAG_THRESHOLD_PX = 5;

/**
 * Bridges wall/selection engine state to the Three.js scene: creates,
 * updates and removes wall meshes as WallStore changes, shows/hides a
 * selection outline as SelectionStore changes, and turns canvas clicks
 * into selection changes via raycasting. Contains no wall *data* logic
 * itself - that all lives in the engine stores.
 */
export class WallLayer {
  private readonly entries = new Map<string, WallEntry>();
  private readonly raycaster = new THREE.Raycaster();
  private pointerDownPosition: { x: number; y: number } | null = null;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly camera: THREE.PerspectiveCamera,
    private readonly domElement: HTMLElement,
    private readonly wallStore: WallStore,
    private readonly selectionStore: SelectionStore
  ) {
    this.wallStore.subscribe((walls) => this.syncWalls(walls));
    this.selectionStore.subscribe((selectedId) => this.syncSelection(selectedId));

    this.domElement.addEventListener("pointerdown", this.handlePointerDown);
    this.domElement.addEventListener("pointerup", this.handlePointerUp);
  }

  private syncWalls(walls: WallData[]): void {
    const seenIds = new Set<string>();

    for (const wall of walls) {
      seenIds.add(wall.id);
      const entry = this.entries.get(wall.id);

      if (entry) {
        const { dimensionsChanged } = applyWallDataToMesh(entry.mesh, wall);
        if (dimensionsChanged) {
          refreshWallOutline(entry.outline, entry.mesh);
        }
      } else {
        const mesh = buildWallMesh(wall);
        const outline = buildWallOutline(mesh);
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
  }

  private syncSelection(selectedId: string | null): void {
    for (const [id, entry] of this.entries) {
      entry.outline.visible = id === selectedId;
    }
  }

  private disposeEntry(entry: WallEntry): void {
    this.scene.remove(entry.mesh);
    entry.mesh.geometry.dispose();
    (entry.mesh.material as THREE.Material).dispose();
    entry.outline.geometry.dispose();
    (entry.outline.material as THREE.Material).dispose();
  }

  private readonly handlePointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) {
      this.pointerDownPosition = null; // ignore right/middle button (pan/other controls)
      return;
    }
    this.pointerDownPosition = { x: event.clientX, y: event.clientY };
  };

  private readonly handlePointerUp = (event: PointerEvent): void => {
    const start = this.pointerDownPosition;
    this.pointerDownPosition = null;
    if (!start) {
      return;
    }

    const distance = Math.hypot(event.clientX - start.x, event.clientY - start.y);
    if (distance > CLICK_DRAG_THRESHOLD_PX) {
      return; // an orbit/pan drag, not a selection click
    }

    this.handleClick(event);
  };

  private handleClick(event: PointerEvent): void {
    const rect = this.domElement.getBoundingClientRect();
    const pointer = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1
    );

    this.raycaster.setFromCamera(pointer, this.camera);
    const meshes = Array.from(this.entries.values(), (entry) => entry.mesh);
    const [hit] = this.raycaster.intersectObjects(meshes, false);

    if (hit) {
      this.selectionStore.select(hit.object.userData.wallId as string);
    } else {
      this.selectionStore.clear();
    }
  }
}
