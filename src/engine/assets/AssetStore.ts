import type { AssetData, AssetId } from "./types";
// Explicit .ts extensions on these value imports let Node run this file
// directly (the verify suites do). Harmless for Vite.
import { ObjectRegistry, type RegistryListener } from "../objects/ObjectRegistry.ts";
import { validateAsset, type AssetValidationResult } from "./validateAsset.ts";

export type AssetStoreListener = RegistryListener<AssetData>;

export type AssetChanges = Partial<Omit<AssetData, "id" | "type" | "assetId">>;

function notFound(id: AssetId): AssetValidationResult {
  return { valid: false, errors: [{ field: "id", message: `No asset found with id "${id}".` }] };
}

/**
 * The one store for every placed design asset - the same "compose
 * ObjectRegistry, add only your own rules" facade WallStore and
 * ElementStore already use (see objects/README.md). A deliberately
 * SEPARATE store from ElementStore: a design asset (a sofa, a bed, a
 * lamp) is a loaded GLTF model instance with a real bounding box and no
 * parametric shape recipe, non-dimensional parameters, or endpoint
 * connections - folding it into ElementStore would mean every element
 * consumer (buildElementMesh's shape switch, the catalog's dimension/
 * axis tables, connection validation) growing "if it's actually an
 * asset" branches throughout, exactly the "one unsafe generic mesh
 * system" the milestone says not to build. Keeping them apart means
 * neither system's rules leak into the other's.
 *
 * Rules enforced here:
 * - every write is validated by validateAsset() against the asset's
 *   assetId (catalog.ts)
 * - a duplicate id is rejected on add()
 * - an asset's assetId never changes after it is created (like an
 *   element's kind)
 */
export class AssetStore {
  private readonly registry = new ObjectRegistry<AssetData>();

  add(asset: AssetData): AssetValidationResult {
    const result = validateAsset(asset);
    if (!result.valid) {
      return result;
    }
    if (this.registry.has(asset.id)) {
      return { valid: false, errors: [{ field: "id", message: `An asset with id "${asset.id}" already exists.` }] };
    }
    this.registry.add(asset);
    return result;
  }

  /** Merges `changes` into the asset and validates the complete result first. Nested `dimensions`/`position` are complete replacement objects when provided, like every other store. */
  update(id: AssetId, changes: AssetChanges): AssetValidationResult {
    const existing = this.registry.get(id);
    if (!existing) {
      return notFound(id);
    }
    const rawAssetId = (changes as { assetId?: unknown }).assetId;
    if (rawAssetId !== undefined && rawAssetId !== existing.assetId) {
      return { valid: false, errors: [{ field: "assetId", message: "An asset's assetId can't change - place a new asset instead." }] };
    }

    const merged: AssetData = { ...existing, ...changes };
    const result = validateAsset(merged);
    if (!result.valid) {
      return result;
    }
    this.registry.update(id, changes);
    return result;
  }

  /** Overwrites an asset exactly - for undo/redo snapshots. Still validated. */
  set(id: AssetId, asset: AssetData): AssetValidationResult {
    const result = validateAsset(asset);
    if (!result.valid) {
      return result;
    }
    this.registry.set(id, asset);
    return result;
  }

  remove(id: AssetId): void {
    this.registry.remove(id);
  }

  get(id: AssetId): AssetData | undefined {
    return this.registry.get(id);
  }

  getAll(): AssetData[] {
    return this.registry.getAll();
  }

  /** Returns an unsubscribe function. Calls the listener once immediately with the current state. */
  subscribe(listener: AssetStoreListener): () => void {
    return this.registry.subscribe(listener);
  }
}
