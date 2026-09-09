import * as THREE from "three";
import type { SelectionStore } from "../engine/selection/SelectionStore";

/** Pointer must stay within this many pixels between down/up to count as a click rather than an orbit/pan drag. */
const CLICK_DRAG_THRESHOLD_PX = 5;

/**
 * Owns the single pointerdown/pointerup listener pair and the single
 * THREE.Raycaster for click-to-select, shared across every construction-
 * object layer (WallLayer, PillarLayer, ...).
 *
 * This used to live inside WallLayer itself, each layer independently
 * raycasting against only its own meshes. That worked with exactly one
 * selectable type; it breaks the moment a second one (pillar) exists,
 * because two independent "no hit in MY meshes -> clear()" handlers
 * race each other on the same click: clicking a wall would select it
 * via WallLayer's handler, then PillarLayer's handler (finding no
 * pillar under the cursor) would immediately clear that selection.
 *
 * Extracting one shared raycaster that combines every registered
 * layer's meshes into a single raycast, and decides select()-vs-clear()
 * exactly once per click, removes the race entirely - "one selected
 * construction object at a time" holds regardless of how many
 * selectable layers exist. Each layer still owns everything about its
 * own meshes (creation, sync, disposal, the outline) - it just
 * contributes its current mesh list here instead of listening for
 * clicks itself. See objects/README.md's "Layer ownership" table.
 *
 * Reads `mesh.userData.objectId` on whatever it hits - every mesh
 * builder (buildWallMesh, buildPillarMesh, ...) sets that same field,
 * so this class needs no per-type special-casing.
 */
export class SelectionRaycaster {
  private readonly raycaster = new THREE.Raycaster();
  private readonly meshProviders: Array<() => THREE.Object3D[]> = [];
  private pointerDownPosition: { x: number; y: number } | null = null;

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    private readonly domElement: HTMLElement,
    private readonly selectionStore: SelectionStore
  ) {
    this.domElement.addEventListener("pointerdown", this.handlePointerDown);
    this.domElement.addEventListener("pointerup", this.handlePointerUp);
  }

  /** Registers a source of selectable meshes - call once per layer (e.g. `wallLayer.getMeshes`). */
  registerLayer(getMeshes: () => THREE.Object3D[]): void {
    this.meshProviders.push(getMeshes);
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
    const meshes = this.meshProviders.flatMap((getMeshes) => getMeshes());
    const [hit] = this.raycaster.intersectObjects(meshes, false);

    if (hit) {
      this.selectionStore.select(hit.object.userData.objectId as string);
    } else {
      this.selectionStore.clear();
    }
  }
}
