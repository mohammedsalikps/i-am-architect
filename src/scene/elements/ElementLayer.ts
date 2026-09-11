import type * as THREE from "three";
import type { ElementData } from "../../engine/elements/types";
import type { ElementStore } from "../../engine/elements/ElementStore";
import type { SelectionStore } from "../../engine/selection/SelectionStore";
import type { VisibilityStore } from "../visibility/VisibilityStore";
import {
  applyElementTransform,
  buildElementVisual,
  disposeElementVisual,
  elementAppearanceKey,
  type ElementVisual
} from "./buildElementMesh";

interface ElementEntry {
  visual: ElementVisual;
  /** elementAppearanceKey() when the visual was built. */
  appearance: string;
}

/**
 * Bridges ElementStore to the Three.js scene for every element kind - the
 * same job PillarLayer does for pillars, generic over the catalog. It
 * creates, updates and removes element visuals as the store changes, and
 * shows the selected element's outline. A move or turn only re-places the
 * existing group; a change to size, parameters, material or color
 * rebuilds it.
 *
 * Does not raycast clicks itself - getMeshes() hands every element part
 * to the shared SelectionRaycaster (and ManipulationController), each
 * tagged with its element's id.
 */
export class ElementLayer {
  private readonly entries = new Map<string, ElementEntry>();

  constructor(
    private readonly scene: THREE.Scene,
    private readonly elementStore: ElementStore,
    private readonly selectionStore: SelectionStore,
    private readonly visibilityStore: VisibilityStore
  ) {
    this.elementStore.subscribe((elements) => this.syncElements(elements));
    this.selectionStore.subscribe((selectedId) => this.syncSelection(selectedId));
    this.visibilityStore.subscribe((hidden) => this.syncVisibility(hidden));
  }

  /** Every element part, for the shared SelectionRaycaster to raycast against. */
  getMeshes(): THREE.Object3D[] {
    return Array.from(this.entries.values()).flatMap((entry) => entry.visual.meshes);
  }

  private syncElements(elements: ElementData[]): void {
    const seenIds = new Set<string>();

    for (const element of elements) {
      seenIds.add(element.id);
      const entry = this.entries.get(element.id);
      const appearance = elementAppearanceKey(element);

      if (entry && entry.appearance === appearance) {
        applyElementTransform(entry.visual.group, element);
        continue;
      }
      if (entry) {
        this.disposeEntry(entry);
      }
      const visual = buildElementVisual(element);
      this.scene.add(visual.group);
      this.entries.set(element.id, { visual, appearance });
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
      entry.visual.outline.visible = id === selectedId;
    }
  }

  /** Hiding an element never deletes it - only its group's own .visible flag changes; the store and undo history are untouched. */
  private syncVisibility(hidden: ReadonlySet<string>): void {
    for (const [id, entry] of this.entries) {
      entry.visual.group.visible = !hidden.has(id);
    }
  }

  private disposeEntry(entry: ElementEntry): void {
    this.scene.remove(entry.visual.group);
    disposeElementVisual(entry.visual);
  }
}
