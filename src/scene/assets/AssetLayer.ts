import type * as THREE from "three";
import type { AssetData } from "../../engine/assets/types";
import { getAssetDefinition } from "../../engine/assets/catalog";
import type { AssetStore } from "../../engine/assets/AssetStore";
import type { SelectionStore } from "../../engine/selection/SelectionStore";
import type { VisibilityStore } from "../visibility/VisibilityStore";
import type { AssetLoader } from "./AssetLoader";
import {
  applyAssetTransform,
  assetAppearanceKey,
  buildLoadedVisual,
  buildPlaceholderVisual,
  disposeAssetVisual,
  type AssetVisual
} from "./buildAssetVisual";

interface AssetEntry {
  visual: AssetVisual;
  /** assetAppearanceKey() when the visual was built. */
  appearance: string;
  /** Guards against a stale async load/failure landing after the asset was removed or changed again - see syncAssets()'s own docs. */
  requestId: number;
}

/**
 * Bridges AssetStore to the Three.js scene - the design-asset equivalent
 * of ElementLayer, with one real difference: loading a design asset's
 * model is asynchronous (a real GLTFLoader fetch/parse - see
 * AssetLoader.ts), where an element's primitive shape is drawn
 * synchronously. So every asset starts as an immediate placeholder box
 * (task: a real loading state) and is swapped for its real model once
 * loaded, or for a distinct failure placeholder if loading rejects (task:
 * a real failure state) - never a silent gap in the scene.
 *
 * `requestId` on each entry is what keeps a slow or failed load from
 * clobbering a NEWER state: if the asset is deleted, or changes again
 * (a different assetId via delete+re-add, a resize, a material change)
 * before an in-flight load/failure resolves, that result is simply
 * discarded when it lands - the entry it would have updated no longer
 * has a matching requestId.
 *
 * Does not raycast clicks itself - getMeshes() hands every asset's
 * pickable meshes to the shared SelectionRaycaster (and
 * ManipulationController), each tagged with its asset's id. A
 * still-loading asset contributes no meshes (nothing to select yet); a
 * failed one does (a failed placeholder can still be selected, inspected
 * and deleted).
 */
export class AssetLayer {
  private readonly entries = new Map<string, AssetEntry>();
  private nextRequestId = 0;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly assetStore: AssetStore,
    private readonly selectionStore: SelectionStore,
    private readonly visibilityStore: VisibilityStore,
    private readonly loader: AssetLoader
  ) {
    this.assetStore.subscribe((assets) => this.syncAssets(assets));
    this.selectionStore.subscribe((selectedId) => this.syncSelection(selectedId));
    this.visibilityStore.subscribe((hidden) => this.syncVisibility(hidden));
  }

  /** Every placed asset's pickable meshes, hidden ones excluded - see WallLayer.getMeshes()'s own comment for why this filtering has to happen here (THREE.Raycaster doesn't consult `.visible` itself). */
  getMeshes(): THREE.Object3D[] {
    return Array.from(this.entries.values())
      .filter((entry) => entry.visual.group.visible)
      .flatMap((entry) => entry.visual.meshes);
  }

  private syncAssets(assets: AssetData[]): void {
    const seenIds = new Set<string>();

    for (const asset of assets) {
      seenIds.add(asset.id);
      const appearance = assetAppearanceKey(asset);
      const entry = this.entries.get(asset.id);

      if (entry && entry.appearance === appearance) {
        applyAssetTransform(entry.visual.group, asset);
        continue;
      }
      if (entry) {
        this.disposeEntry(entry);
      }

      const requestId = (this.nextRequestId += 1);
      const definition = getAssetDefinition(asset.assetId);
      const placeholder = buildPlaceholderVisual(asset, definition ? "loading" : "failed");
      this.scene.add(placeholder.group);
      this.entries.set(asset.id, { visual: placeholder, appearance, requestId });

      if (definition) {
        buildLoadedVisual(asset, this.loader, definition)
          .then((visual) => this.settle(asset.id, requestId, visual))
          .catch(() => this.settle(asset.id, requestId, buildPlaceholderVisual(asset, "failed")));
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

  /** Replaces a placeholder with its resolved (loaded or failed) visual - a no-op if the entry moved on (removed, or rebuilt again) since this request started. */
  private settle(id: string, requestId: number, visual: AssetVisual): void {
    const current = this.entries.get(id);
    if (!current || current.requestId !== requestId) {
      disposeAssetVisual(visual); // this specific result is no longer wanted - never leaked into the scene
      return;
    }
    this.scene.remove(current.visual.group);
    disposeAssetVisual(current.visual);
    this.scene.add(visual.group);
    this.entries.set(id, { visual, appearance: current.appearance, requestId });
    this.syncSelection(this.selectionStore.get());
    this.syncVisibility(this.visibilityStore.getHidden());
  }

  private syncSelection(selectedId: string | null): void {
    for (const [id, entry] of this.entries) {
      entry.visual.outline.visible = id === selectedId;
    }
  }

  /** Hiding an asset never deletes it - only its group's own .visible flag changes; the store and undo history are untouched. */
  private syncVisibility(hidden: ReadonlySet<string>): void {
    for (const [id, entry] of this.entries) {
      entry.visual.group.visible = !hidden.has(id);
    }
  }

  private disposeEntry(entry: AssetEntry): void {
    this.scene.remove(entry.visual.group);
    disposeAssetVisual(entry.visual);
  }
}
