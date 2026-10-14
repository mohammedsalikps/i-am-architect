/**
 * Roof styles and the two exterior looks the house generator and the
 * Architect use. A roof's style changes only the shape drawn inside its
 * box (scene/elements/buildElementMesh.ts) - never its length, span or
 * position - so restyling a house can't resize a room. Pure and testable.
 */

export const ROOF_STYLES = ["flat", "mono-pitch", "gable"] as const;
export type RoofStyle = (typeof ROOF_STYLES)[number];

export function isRoofStyle(value: unknown): value is RoofStyle {
  return typeof value === "string" && (ROOF_STYLES as readonly string[]).includes(value);
}

/** Each style's height, metres: a flat roof's deck and parapet, a mono-pitch's single slope, a gable's ridge. */
export const ROOF_RISE: Readonly<Record<RoofStyle, number>> = { flat: 0.5, "mono-pitch": 1, gable: 1.6 };

/** Each style's finish: contemporary roofs in dark standing-seam metal, a gable in clay tile. */
export const ROOF_FINISH: Readonly<Record<RoofStyle, { material: string; color: string }>> = {
  flat: { material: "metal-roofing", color: "#4b5258" },
  "mono-pitch": { material: "metal-roofing", color: "#4b5258" },
  gable: { material: "clay-roof-tile", color: "#a4502f" }
};

/** How the style is said: "a flat roof with a parapet", "a mono-pitch roof"... */
export const ROOF_STYLE_TEXT: Readonly<Record<RoofStyle, string>> = {
  flat: "a flat roof with a parapet, in dark metal",
  "mono-pitch": "a mono-pitch roof (one slope), in dark metal",
  gable: "a gable roof in clay tile"
};

/**
 * The finish a modern exterior wall is rendered in: a warm white plaster
 * over the masonry. Only the colour changes - the wall's material (brick,
 * block or stone) stays as built, and the record book still says so.
 */
export const RENDER_WHITE = "#ece8df";

/** The plaster finish a modern house's interior walls get - again only the colour; the masonry stays as built. */
export const PLASTER_FINISH = "#e8e4da";

/**
 * The changes that give a roof `style`: its shape, a height to suit it,
 * and its finish - with its base kept on the walls and its length, span
 * and plan position untouched. Shared by the Architect ("make the roof
 * flat") and the inspector's Style row, so both restyle identically.
 */
export function roofStyleChanges(
  roof: { position: { x: number; y: number; z: number }; dimensions: Readonly<Record<string, number>>; params: Readonly<Record<string, unknown>> },
  style: RoofStyle
): { params: Record<string, string | number>; dimensions: Record<string, number>; position: { x: number; y: number; z: number }; material: string; color: string } {
  const rise = ROOF_RISE[style];
  const base = roof.position.y - (roof.dimensions.height ?? rise) / 2;
  const params: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(roof.params)) if (typeof value === "string" || typeof value === "number") params[key] = value;
  return {
    params: { ...params, style },
    dimensions: { ...roof.dimensions, height: rise },
    position: { ...roof.position, y: Math.round((base + rise / 2) * 1000) / 1000 },
    material: ROOF_FINISH[style].material,
    color: ROOF_FINISH[style].color
  };
}

export type ExteriorStyle = "modern" | "traditional";

/** The roof each exterior look gets. */
export const EXTERIOR_ROOF: Readonly<Record<ExteriorStyle, RoofStyle>> = { modern: "flat", traditional: "gable" };
