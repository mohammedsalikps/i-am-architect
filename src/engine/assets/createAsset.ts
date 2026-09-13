// Explicit .ts extension on this value import lets Node run this file
// directly (the verify suites do). Harmless for Vite.
import { getAssetDefinition } from "./catalog.ts";
import type { AssetData, AssetDimensions } from "./types";
import type { Vector3Data } from "../objects/types";

export interface CreateAssetOptions {
  /** Which catalog entry to place - required. */
  assetId: string;
  /** The name people see; defaults to the definition's label. */
  label?: string;
  position?: Partial<Vector3Data>;
  rotation?: number;
  /** Real-world meters; any of width/height/depth, the rest take the definition's own default box. */
  dimensions?: Partial<AssetDimensions>;
  material?: string;
  color?: string;
}

/** One id counter per asset definition: sofa-1, sofa-2, bed-1, ... - same convention as elements/createElement.ts's nextIdFor(). */
const nextIds = new Map<string, number>();

function nextIdFor(assetId: string): string {
  const next = nextIds.get(assetId) ?? 1;
  nextIds.set(assetId, next + 1);
  return `${assetId}-${next}`;
}

/**
 * Makes every id createAssetData() hands out from now on come after
 * `ids` - called when a saved project is loaded, since its assets keep
 * their ids (see project/projectPersistence.ts). Never moves a counter
 * backwards. Mirrors elements/createElement.ts's reserveElementIds().
 */
export function reserveAssetIds(ids: Iterable<string>): void {
  for (const id of ids) {
    const match = /^([a-z][a-z-]*[a-z])-(\d+)$/.exec(id);
    if (match && getAssetDefinition(match[1])) {
      nextIds.set(match[1], Math.max(nextIds.get(match[1]) ?? 1, Number(match[2]) + 1));
    }
  }
}

/**
 * A new instance of a catalog asset, with the definition's own real-world
 * box for anything not given. Rests on the ground (its base at y=0)
 * unless a position with y is supplied. Values are copied, not checked -
 * AssetStore validates the result exactly as it validates any other
 * write. Throws only for an unknown assetId, which has no defaults to
 * build from - CommandExecutor checks it first and reports it, same
 * convention as createElementData().
 */
export function createAssetData(options: CreateAssetOptions): AssetData {
  const definition = getAssetDefinition(options.assetId);
  if (!definition) {
    throw new Error(`Unknown asset "${String(options.assetId)}".`);
  }

  const dimensions: AssetDimensions = {
    width: options.dimensions?.width ?? definition.defaultDimensions.width,
    height: options.dimensions?.height ?? definition.defaultDimensions.height,
    depth: options.dimensions?.depth ?? definition.defaultDimensions.depth
  };

  const position: Vector3Data = {
    x: options.position?.x ?? 0,
    y: options.position?.y ?? dimensions.height / 2,
    z: options.position?.z ?? 0
  };

  return {
    id: nextIdFor(definition.id),
    type: "asset",
    assetId: definition.id,
    label: options.label ?? definition.label,
    position,
    rotation: options.rotation ?? 0,
    dimensions,
    material: options.material ?? definition.defaultMaterial,
    color: options.color ?? definition.defaultColor,
    assemblyId: null
  };
}

/** World-space offset applied to a duplicate so it never sits exactly on top of the original - the same value every object type uses. */
const DUPLICATE_OFFSET = 0.75;

/** An independent copy: same asset, label, size, material and color, a fresh id, offset so the two don't overlap. */
export function duplicateAssetData(asset: AssetData): AssetData {
  return createAssetData({
    assetId: asset.assetId,
    label: asset.label,
    position: { x: asset.position.x + DUPLICATE_OFFSET, y: asset.position.y, z: asset.position.z + DUPLICATE_OFFSET },
    rotation: asset.rotation,
    dimensions: { ...asset.dimensions },
    material: asset.material,
    color: asset.color
  });
}
