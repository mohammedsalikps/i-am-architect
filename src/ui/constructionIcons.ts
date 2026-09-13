/**
 * One small, hand-drawn SVG icon per construction ribbon tool - real
 * architectural symbols (a door swing, a stepped footing, a stair
 * profile, ...) instead of the 2-letter text abbreviations `iconFor()`
 * (ribbonTabs.ts) used to produce. Same conventions as
 * ui/assetIcons.ts's furniture icons, deliberately mirrored so the two
 * icon sets read as one coherent visual language: 48x48 viewBox,
 * `fill="none"`, `stroke="currentColor"` (so a card/button can recolor it
 * with plain CSS on hover/active, no per-state markup), simple geometric
 * line art - the standard plan-view symbol for each element where one
 * exists (door swing arc, window-in-wall, stair treads, a stepped
 * strip-footing section) rather than a literal 3D rendering.
 *
 * Deliberately scoped to the ribbon tools this milestone's task actually
 * named (the six original types plus the four Building-category catalog
 * kinds, and Paint for consistency - it was the one remaining hardcoded
 * text glyph, `icon: "Pa"` in ribbonTabs.ts) rather than every catalog
 * kind across every tab - see ribbonTabs.ts's own comment on why. A tool
 * with no entry here keeps its existing `iconFor()` letter fallback, so
 * nothing already showing regresses - this only ever adds coverage.
 */

const CONSTRUCTION_ICONS: Readonly<Record<string, string>> = {
  // A wall in elevation: coursed brickwork, offset row to row.
  wall: `<svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="8" y="10" width="32" height="28" rx="1.5" stroke="currentColor" stroke-width="2"/><path d="M8 19h32M8 29h32M18 10v9M30 19v10M18 29v9" stroke="currentColor" stroke-width="1.5"/></svg>`,
  // A column: a slender shaft between a capital and a base.
  pillar: `<svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="15" y="6" width="18" height="4" rx="1" stroke="currentColor" stroke-width="2"/><rect x="20" y="10" width="8" height="28" stroke="currentColor" stroke-width="2"/><rect x="15" y="38" width="18" height="4" rx="1" stroke="currentColor" stroke-width="2"/></svg>`,
  // A beam spanning between two supports.
  beam: `<svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="7" y="18" width="34" height="7" rx="1" stroke="currentColor" stroke-width="2"/><path d="M13 25v11M35 25v11" stroke="currentColor" stroke-width="2"/></svg>`,
  // A floor slab in section: a flat plane over hatching (concrete).
  slab: `<svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="7" y="28" width="34" height="7" rx="1" stroke="currentColor" stroke-width="2"/><path d="M11 35l6 6M20 35l6 6M29 35l6 6" stroke="currentColor" stroke-width="1.5"/></svg>`,
  // The standard plan-view door symbol: a leaf against the frame, swinging through a quarter-circle arc.
  door: `<svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M12 12v28h26" stroke="currentColor" stroke-width="2"/><path d="M12 40 12 12" stroke="currentColor" stroke-width="2.5"/><path d="M12 12A28 28 0 0 1 38 40" stroke="currentColor" stroke-width="1.5" stroke-dasharray="3 3"/></svg>`,
  // The standard plan-view window symbol: a gap in the wall with two parallel panes.
  window: `<svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M6 20h36M6 28h36" stroke="currentColor" stroke-width="2.5"/><path d="M6 16v16M42 16v16" stroke="currentColor" stroke-width="2"/><path d="M6 24h36" stroke="currentColor" stroke-width="1.5"/></svg>`,
  // A stepped strip foundation in section, narrowing up toward the wall it carries.
  foundation: `<svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="18" y="14" width="12" height="10" stroke="currentColor" stroke-width="2"/><path d="M8 34v-8h32v8" stroke="currentColor" stroke-width="2"/><path d="M6 34h36" stroke="currentColor" stroke-width="2.5"/></svg>`,
  // A pitched gable roof.
  roof: `<svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M6 32 24 10 42 32" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M10 32h28" stroke="currentColor" stroke-width="2"/></svg>`,
  // A straight-flight stair in side profile: rising treads.
  stair: `<svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M8 38h7v-7h7v-7h7v-7h7v-7h6" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>`,
  // A named room: a floor-plan rectangle with a center mark, standing in for its label.
  room: `<svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="8" y="8" width="32" height="32" rx="1.5" stroke="currentColor" stroke-width="2"/><path d="M24 19v10M19 24h10" stroke="currentColor" stroke-width="1.5"/></svg>`,
  // A paint roller.
  paint: `<svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="10" y="10" width="20" height="10" rx="2" stroke="currentColor" stroke-width="2"/><path d="M20 20v6h8" stroke="currentColor" stroke-width="2"/><rect x="24" y="26" width="8" height="12" rx="1.5" stroke="currentColor" stroke-width="2"/></svg>`
};

/** A ribbon tool's own icon, or null when this milestone hasn't drawn one yet - see the module doc comment for the deliberately scoped coverage. Callers fall back to `iconFor()`'s letters, never a blank button. */
export function constructionIconSvg(id: string): string | null {
  return CONSTRUCTION_ICONS[id] ?? null;
}
