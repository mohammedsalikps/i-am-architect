/**
 * The material library: every material a construction object can be made
 * of, as plain data. An object's `material` field holds one of these ids;
 * the Properties panel and the Materials tab offer them, the element
 * catalog (elements/catalog.ts) says which categories suit each kind, and
 * the scene reads the appearance hints (roughness, metalness, opacity)
 * when it draws an element.
 *
 * Deliberately small and data-only - no textures, prices, suppliers, or
 * physical properties yet. The six original object types keep accepting
 * any non-empty material string (their saved projects may hold free-text
 * values); the newer element kinds require a library id.
 */

export type MaterialCategory =
  | "generic"
  | "structural"
  | "masonry"
  | "finish"
  | "wood"
  | "glass"
  | "metal"
  | "ceramic"
  | "stone"
  | "roofing"
  | "plumbing"
  | "electrical"
  | "fabric"
  | "landscape";

export interface MaterialDefinition {
  id: string;
  label: string;
  category: MaterialCategory;
  /** A typical color for the material - offered when it's applied, never forced on the object. */
  color: string;
  /** Appearance hints for the renderer, 0-1. */
  roughness: number;
  metalness: number;
  opacity: number;
}

function material(
  id: string,
  label: string,
  category: MaterialCategory,
  color: string,
  appearance: { roughness?: number; metalness?: number; opacity?: number } = {}
): MaterialDefinition {
  return {
    id,
    label,
    category,
    color,
    roughness: appearance.roughness ?? 0.85,
    metalness: appearance.metalness ?? 0,
    opacity: appearance.opacity ?? 1
  };
}

export const MATERIAL_LIBRARY: readonly MaterialDefinition[] = Object.freeze([
  material("generic", "Generic", "generic", "#c9c9c9", { roughness: 0.9 }),
  material("concrete", "Concrete", "structural", "#a3a3a3", { roughness: 0.95 }),
  material("reinforced-concrete", "Reinforced concrete", "structural", "#9a9a9a", { roughness: 0.95 }),
  material("brick", "Brick", "masonry", "#a0522d", { roughness: 0.95 }),
  material("concrete-block", "Concrete block", "masonry", "#b5b5b0", { roughness: 0.95 }),
  material("stone-masonry", "Stone masonry", "masonry", "#8f877c", { roughness: 0.95 }),
  material("plaster", "Plaster", "finish", "#e8e4da", { roughness: 0.9 }),
  material("paint", "Paint", "finish", "#efe9dd", { roughness: 0.7 }),
  material("laminate", "Laminate", "finish", "#b89a74", { roughness: 0.5 }),
  material("vinyl", "Vinyl", "finish", "#c7bda8", { roughness: 0.6 }),
  material("oak", "Oak", "wood", "#b08050", { roughness: 0.7 }),
  material("pine", "Pine", "wood", "#d2b48c", { roughness: 0.75 }),
  material("plywood", "Plywood", "wood", "#c8a878", { roughness: 0.8 }),
  material("glass", "Glass", "glass", "#9fd3e6", { roughness: 0.1, opacity: 0.45 }),
  material("steel", "Steel", "metal", "#8c9198", { roughness: 0.4, metalness: 0.8 }),
  material("stainless-steel", "Stainless steel", "metal", "#c0c4c8", { roughness: 0.3, metalness: 0.9 }),
  material("galvanized-steel", "Galvanized steel", "metal", "#a9adb1", { roughness: 0.5, metalness: 0.7 }),
  material("aluminium", "Aluminium", "metal", "#b8bcc2", { roughness: 0.35, metalness: 0.8 }),
  material("ceramic-tile", "Ceramic tile", "ceramic", "#e6e2d8", { roughness: 0.4 }),
  material("porcelain", "Porcelain", "ceramic", "#f4f4f2", { roughness: 0.3 }),
  material("marble", "Marble", "stone", "#e8e6e1", { roughness: 0.3 }),
  material("granite", "Granite", "stone", "#6e6a66", { roughness: 0.5 }),
  material("clay-roof-tile", "Clay roof tile", "roofing", "#a4502f", { roughness: 0.9 }),
  material("metal-roofing", "Metal roofing", "roofing", "#7d8a96", { roughness: 0.5, metalness: 0.6 }),
  material("asphalt-shingle", "Asphalt shingle", "roofing", "#4a4a4a", { roughness: 0.95 }),
  material("pvc", "PVC", "plumbing", "#e9e9e9", { roughness: 0.6 }),
  material("cpvc", "CPVC", "plumbing", "#ddd6c4", { roughness: 0.6 }),
  material("hdpe", "HDPE", "plumbing", "#2d2d2d", { roughness: 0.6 }),
  material("copper", "Copper", "plumbing", "#b87333", { roughness: 0.35, metalness: 0.9 }),
  material("pvc-conduit", "PVC conduit", "electrical", "#d9d9d9", { roughness: 0.6 }),
  material("copper-wire", "Copper wire", "electrical", "#c96f35", { roughness: 0.4, metalness: 0.8 }),
  material("abs-plastic", "ABS plastic", "electrical", "#f2f2f2", { roughness: 0.5 }),
  material("fabric", "Fabric", "fabric", "#7a8ca3", { roughness: 1 }),
  material("leather", "Leather", "fabric", "#6b4226", { roughness: 0.6 }),
  material("grass", "Grass", "landscape", "#4f8a3a", { roughness: 1 }),
  material("gravel", "Gravel", "landscape", "#9b9488", { roughness: 1 }),
  material("paving-stone", "Paving stone", "landscape", "#8d8a84", { roughness: 0.9 }),
  material("soil", "Soil", "landscape", "#6b4f35", { roughness: 1 }),
  material("foliage", "Foliage", "landscape", "#3f7d34", { roughness: 1 })
]);

const BY_ID: ReadonlyMap<string, MaterialDefinition> = new Map(MATERIAL_LIBRARY.map((entry) => [entry.id, entry]));

/** The library entry for an id, or undefined for a free-text or unknown material. */
export function getMaterial(id: string): MaterialDefinition | undefined {
  return BY_ID.get(id);
}

/** Library materials in the given categories, in library order - "generic" is always included. All of them when no categories are given. */
export function materialsFor(categories?: readonly MaterialCategory[]): MaterialDefinition[] {
  if (!categories) {
    return [...MATERIAL_LIBRARY];
  }
  return MATERIAL_LIBRARY.filter((entry) => entry.id === "generic" || categories.includes(entry.category));
}
