/**
 * The design-asset catalog: every placeable GLB/GLTF asset (furniture,
 * fixtures, lighting, decor), as data - the same "one table, everything
 * else reads it" shape elements/catalog.ts uses for construction
 * elements. Deliberately a SEPARATE catalog/store from ElementStore
 * (never merged - see AssetStore.ts's own docs): a design asset is a
 * loaded GLTF model instance (position/rotation/a real-meters bounding
 * size), not a parametric primitive recipe, and it may be freely
 * transform-scaled where a construction element must not be.
 *
 * `defaultDimensions` is the asset's own real-world bounding box, in
 * meters, exactly as authored (see scripts/generate-asset-models.mjs,
 * which prints each model's measured box - these numbers are copied
 * from that output, not guessed) - AssetLoader re-measures the same box
 * at runtime (engine/assets bounding-box calculation, done in the
 * browser) so the two can never silently drift without a build/test
 * catching it.
 */

import type { MaterialCategory } from "../materials/materialLibrary";

export type AssetCategory = "living" | "bedroom" | "dining" | "kitchen" | "bathroom" | "lighting" | "decor" | "outdoor";

export interface AssetCategoryDefinition {
  id: AssetCategory;
  label: string;
}

export const ASSET_CATEGORIES: readonly AssetCategoryDefinition[] = Object.freeze([
  { id: "living", label: "Living" },
  { id: "bedroom", label: "Bedroom" },
  { id: "dining", label: "Dining" },
  { id: "kitchen", label: "Kitchen" },
  { id: "bathroom", label: "Bathroom" },
  { id: "lighting", label: "Lighting" },
  { id: "decor", label: "Decor" },
  { id: "outdoor", label: "Outdoor" }
]);

export interface AssetDefinition {
  id: string;
  label: string;
  category: AssetCategory;
  subcategory?: string;
  description: string;
  /** Relative to src/assets/ (see AssetLoader.ts) - never an absolute filesystem path or a remote URL committed into this repository. */
  url: string;
  /** The model's own real-world bounding box, in meters - see this file's own docs. */
  defaultDimensions: { width: number; height: number; depth: number };
  /** Material categories that suit this asset - the Materials tab offers these (plus "generic"), same convention as ElementKindDefinition. */
  materialCategories: readonly MaterialCategory[];
  defaultMaterial: string;
  defaultColor: string;
  /** Words a search or an AI instruction may use for this asset. */
  keywords: readonly string[];
  /** Bumped whenever this definition's geometry/scale meaningfully changes, so a placed instance authored under an older version could one day be migrated - not consulted anywhere yet. */
  version: number;
}

function asset(def: Omit<AssetDefinition, "version" | "keywords"> & { keywords?: readonly string[] }): AssetDefinition {
  return { ...def, version: 1, keywords: def.keywords ?? [def.label.toLowerCase()] };
}

/**
 * A small, real, project-owned demonstration set (task: "start small... a
 * small high-quality set is better") - every model is a simple, honestly
 * plain box/cylinder/cone composition (see scripts/generate-asset-models.mjs),
 * not a claim of photorealism, and not a downloaded third-party asset.
 * "outdoor" is deliberately left with no entries, to exercise (and keep
 * honest) the asset library's real "No assets available yet" empty state
 * rather than only ever being demonstrated by category screenshots.
 */
export const ASSET_DEFINITIONS: readonly AssetDefinition[] = Object.freeze([
  asset({
    id: "sofa",
    label: "Sofa",
    category: "living",
    description: "A three-seat sofa with armrests.",
    url: "sofa.gltf",
    defaultDimensions: { width: 2.0, height: 0.92, depth: 0.85 },
    materialCategories: ["fabric"],
    defaultMaterial: "fabric",
    defaultColor: "#7a8ca3",
    keywords: ["sofa", "couch", "settee", "living room"]
  }),
  asset({
    id: "coffee-table",
    label: "Coffee Table",
    category: "living",
    description: "A low table for a living room seating area.",
    url: "coffee-table.gltf",
    defaultDimensions: { width: 1.1, height: 0.44, depth: 0.55 },
    materialCategories: ["wood"],
    defaultMaterial: "oak",
    defaultColor: "#b08050",
    keywords: ["coffee table", "side table"]
  }),
  asset({
    id: "tv-console",
    label: "TV Console",
    category: "living",
    description: "A low media console/unit.",
    url: "tv-console.gltf",
    defaultDimensions: { width: 1.6, height: 0.42, depth: 0.4 },
    materialCategories: ["wood"],
    defaultMaterial: "plywood",
    defaultColor: "#4a3a2c",
    keywords: ["tv console", "tv unit", "media unit", "cabinet"]
  }),
  asset({
    id: "plant",
    label: "Potted Plant",
    category: "living",
    description: "A potted indoor plant.",
    url: "plant.gltf",
    defaultDimensions: { width: 0.64, height: 1.08, depth: 0.64 },
    materialCategories: ["landscape"],
    defaultMaterial: "foliage",
    defaultColor: "#3f7d34",
    keywords: ["plant", "potted plant", "houseplant"]
  }),
  asset({
    id: "bed",
    label: "Double Bed",
    category: "bedroom",
    description: "A double bed with mattress, headboard and pillows.",
    url: "bed.gltf",
    defaultDimensions: { width: 1.6, height: 0.875, depth: 2.0 },
    materialCategories: ["wood", "fabric"],
    defaultMaterial: "pine",
    defaultColor: "#6b4f35",
    keywords: ["bed", "double bed", "bedroom"]
  }),
  asset({
    id: "bedside-table",
    label: "Bedside Table",
    category: "bedroom",
    description: "A small nightstand.",
    url: "bedside-table.gltf",
    defaultDimensions: { width: 0.45, height: 0.55, depth: 0.41 },
    materialCategories: ["wood"],
    defaultMaterial: "oak",
    defaultColor: "#8a6a45",
    keywords: ["bedside table", "nightstand"]
  }),
  asset({
    id: "wardrobe",
    label: "Wardrobe",
    category: "bedroom",
    description: "A tall two-door wardrobe.",
    url: "wardrobe.gltf",
    defaultDimensions: { width: 1.0, height: 2.0, depth: 0.61 },
    materialCategories: ["wood"],
    defaultMaterial: "plywood",
    defaultColor: "#5c4630",
    keywords: ["wardrobe", "closet", "armoire"]
  }),
  asset({
    id: "dining-table",
    label: "Dining Table",
    category: "dining",
    description: "A rectangular dining table.",
    url: "dining-table.gltf",
    defaultDimensions: { width: 1.6, height: 0.77, depth: 0.9 },
    materialCategories: ["wood"],
    defaultMaterial: "oak",
    defaultColor: "#a97c50",
    keywords: ["dining table", "table"]
  }),
  asset({
    id: "dining-chair",
    label: "Dining Chair",
    category: "dining",
    description: "A simple dining chair.",
    url: "dining-chair.gltf",
    defaultDimensions: { width: 0.42, height: 0.88, depth: 0.42 },
    materialCategories: ["wood"],
    defaultMaterial: "oak",
    defaultColor: "#a97c50",
    keywords: ["dining chair", "chair"]
  }),
  asset({
    id: "kitchen-counter",
    label: "Kitchen Counter",
    category: "kitchen",
    description: "A base cabinet with worktop and an inset sink.",
    url: "kitchen-counter.gltf",
    defaultDimensions: { width: 2.05, height: 0.89, depth: 0.64 },
    materialCategories: ["wood", "stone", "metal"],
    defaultMaterial: "laminate",
    defaultColor: "#e5ded0",
    keywords: ["kitchen counter", "cabinet", "worktop", "countertop", "sink"]
  }),
  asset({
    id: "toilet",
    label: "Toilet",
    category: "bathroom",
    description: "A close-coupled toilet.",
    url: "toilet.gltf",
    defaultDimensions: { width: 0.44, height: 0.75, depth: 0.61 },
    materialCategories: ["ceramic"],
    defaultMaterial: "porcelain",
    defaultColor: "#f4f4f2",
    keywords: ["toilet", "wc", "bathroom"]
  }),
  asset({
    id: "floor-lamp",
    label: "Floor Lamp",
    category: "lighting",
    description: "A freestanding floor lamp.",
    url: "floor-lamp.gltf",
    defaultDimensions: { width: 0.32, height: 1.59, depth: 0.32 },
    materialCategories: ["metal", "fabric"],
    defaultMaterial: "steel",
    defaultColor: "#8c9198",
    keywords: ["floor lamp", "lamp", "lighting"]
  }),
  asset({
    id: "rug",
    label: "Area Rug",
    category: "decor",
    description: "A flat area rug.",
    url: "rug.gltf",
    defaultDimensions: { width: 2.0, height: 0.02, depth: 1.4 },
    materialCategories: ["fabric"],
    defaultMaterial: "fabric",
    defaultColor: "#a3402f",
    keywords: ["rug", "carpet"]
  })
]);

const BY_ID: ReadonlyMap<string, AssetDefinition> = new Map(ASSET_DEFINITIONS.map((entry) => [entry.id, entry]));

export function getAssetDefinition(id: string): AssetDefinition | undefined {
  return BY_ID.get(id);
}

export function assetDefinitionsIn(category?: AssetCategory): readonly AssetDefinition[] {
  return category ? ASSET_DEFINITIONS.filter((entry) => entry.category === category) : ASSET_DEFINITIONS;
}

/** Case-insensitive match against an asset's label, category, subcategory and keywords. */
export function searchAssetDefinitions(query: string): readonly AssetDefinition[] {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return ASSET_DEFINITIONS;
  }
  return ASSET_DEFINITIONS.filter(
    (entry) =>
      entry.label.toLowerCase().includes(needle) ||
      entry.category.toLowerCase().includes(needle) ||
      entry.subcategory?.toLowerCase().includes(needle) ||
      entry.keywords.some((keyword) => keyword.toLowerCase().includes(needle))
  );
}
