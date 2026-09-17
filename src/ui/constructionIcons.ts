/**
 * One small, hand-drawn SVG icon per construction ribbon tool - real
 * architectural symbols (a door swing, a stepped footing, a stair
 * profile, a duplex outlet, a WC in plan, ...) instead of the 2-letter
 * text abbreviations `iconFor()` (ribbonTabs.ts) used to produce. Same
 * conventions as ui/assetIcons.ts's furniture icons, deliberately
 * mirrored (and, for a handful of kinds both libraries name - bed, sofa,
 * wardrobe, kitchen counter, toilet, plant - drawn identically) so the
 * two icon sets read as one coherent visual language: 48x48 viewBox,
 * `fill="none"`, `stroke="currentColor"` (so a card/button can recolor it
 * with plain CSS on hover/active, no per-state markup), simple geometric
 * line art - the standard plan-view or elevation symbol for each element
 * where architectural drafting already has one (a door swing arc, a
 * duplex outlet face, a WC in plan, a reflected-ceiling-plan diagonal)
 * rather than a literal 3D rendering or a photo.
 *
 * Phase 2 (task: "no unexplained fallback abbreviation for a catalog
 * tool"): every kind in engine/elements/catalog.ts's ELEMENT_KINDS, plus
 * the six original types and Paint, now has an entry here - see that
 * file for the authoritative kind list this mirrors. A kind added to the
 * catalog after this milestone still falls back to `iconFor()`'s letters
 * until it's drawn here; nothing about that fallback path changed.
 */

const CONSTRUCTION_ICONS: Readonly<Record<string, string>> = {
  // --- The six original types ---
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

  // --- Structure ---
  // A stepped strip foundation in section, narrowing up toward the wall it carries.
  foundation: `<svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="18" y="14" width="12" height="10" stroke="currentColor" stroke-width="2"/><path d="M8 34v-8h32v8" stroke="currentColor" stroke-width="2"/><path d="M6 34h36" stroke="currentColor" stroke-width="2.5"/></svg>`,
  // A pitched gable roof.
  roof: `<svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M6 32 24 10 42 32" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M10 32h28" stroke="currentColor" stroke-width="2"/></svg>`,
  // A straight-flight stair in side profile: rising treads.
  stair: `<svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M8 38h7v-7h7v-7h7v-7h7v-7h6" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>`,

  // --- Rooms ---
  // A named room: a floor-plan rectangle with a center mark, standing in for its label.
  room: `<svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="8" y="8" width="32" height="32" rx="1.5" stroke="currentColor" stroke-width="2"/><path d="M24 19v10M19 24h10" stroke="currentColor" stroke-width="1.5"/></svg>`,

  // --- Finish ---
  // A floor finish in plan: a tiled grid, distinct from the ceiling's diagonal below.
  flooring: `<svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="8" y="10" width="32" height="28" rx="1.5" stroke="currentColor" stroke-width="2"/><path d="M8 20h32M8 29h32M18 10v28M29 10v28" stroke="currentColor" stroke-width="1.2"/></svg>`,
  // A ceiling finish - the reflected-ceiling-plan convention: a panel cut by its diagonals.
  ceiling: `<svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="8" y="10" width="32" height="28" rx="1.5" stroke="currentColor" stroke-width="2"/><path d="M8 10l32 28M40 10 8 38" stroke="currentColor" stroke-width="1.2"/></svg>`,

  // --- Plumbing ---
  // A supply pipe with an elbow and coupling marks at each end.
  "water-pipe": `<svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M10 38V22a8 8 0 0 1 8-8h20" stroke="currentColor" stroke-width="3" stroke-linecap="round"/><circle cx="10" cy="38" r="2.3" stroke="currentColor" stroke-width="1.5"/><circle cx="38" cy="14" r="2.3" stroke="currentColor" stroke-width="1.5"/></svg>`,
  // A waste pipe: a hopper/funnel inlet narrowing into a vertical drain.
  "drain-pipe": `<svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M10 10h28l-8 12h-12z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M24 22v16" stroke="currentColor" stroke-width="3" stroke-linecap="round"/></svg>`,
  // A cylindrical storage tank.
  "water-tank": `<svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M10 14a14 5 0 0 1 28 0v20a14 5 0 0 1-28 0z" stroke="currentColor" stroke-width="2"/><ellipse cx="24" cy="14" rx="14" ry="5" stroke="currentColor" stroke-width="2"/></svg>`,
  // A pump: an impeller diamond inside its housing.
  pump: `<svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="24" cy="24" r="13" stroke="currentColor" stroke-width="2"/><path d="M24 13l9 11-9 11-9-11z" stroke="currentColor" stroke-width="1.5"/></svg>`,
  // A basin in plan: the counter outline, the bowl, the tap mark.
  sink: `<svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="8" y="14" width="32" height="20" rx="3" stroke="currentColor" stroke-width="2"/><ellipse cx="24" cy="25" rx="10" ry="6" stroke="currentColor" stroke-width="1.5"/><path d="M24 14v3" stroke="currentColor" stroke-width="1.5"/></svg>`,
  // The standard plan-view WC symbol: cistern above, bowl below.
  toilet: `<svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="16" y="8" width="16" height="10" rx="1.5" stroke="currentColor" stroke-width="2"/><path d="M14 20c0-1 1-2 2-2h16c1 0 2 1 2 2v6c0 5-4 10-10 10s-10-5-10-10v-6Z" stroke="currentColor" stroke-width="2"/></svg>`,
  // A shower tray with its drain and a spray mark from the head.
  shower: `<svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="10" y="10" width="28" height="28" rx="2" stroke="currentColor" stroke-width="2"/><circle cx="24" cy="30" r="2" stroke="currentColor" stroke-width="1.5"/><path d="M32 14l3-3M32 18l4-1M28 12l1-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`,
  // A tap: the arm rising from the counter to its handle.
  tap: `<svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M10 36h9M14.5 36V22a7 7 0 0 1 7-7h11" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/><circle cx="32.5" cy="15" r="2.2" stroke="currentColor" stroke-width="1.5"/></svg>`,

  // --- Electrical ---
  // A conduit run: the raceway line with periodic clip/support marks.
  conduit: `<svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M6 24h36" stroke="currentColor" stroke-width="3"/><path d="M14 18v12M24 18v12M34 18v12" stroke="currentColor" stroke-width="1.3"/></svg>`,
  // A cable run: the standard wavy conductor line.
  cable: `<svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M4 30c4-10 8-10 12 0s8 10 12 0 8-10 12 0 6 7 8 4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`,
  // A wall switch: the plate and its rocker.
  switch: `<svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="15" y="10" width="18" height="28" rx="2" stroke="currentColor" stroke-width="2"/><rect x="20" y="17" width="8" height="14" rx="2.5" stroke="currentColor" stroke-width="1.6"/></svg>`,
  // The standard architectural duplex-outlet face: two slots and a ground.
  socket: `<svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="12" y="14" width="24" height="20" rx="2.5" stroke="currentColor" stroke-width="2"/><path d="M20 21v6M28 21v6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M24 28v3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`,
  // A ceiling light: the reflected-ceiling-plan burst symbol.
  light: `<svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="24" cy="24" r="9" stroke="currentColor" stroke-width="2"/><path d="M24 6v6M24 36v6M6 24h6M36 24h6M11 11l4 4M33 33l4 4M37 11l-4 4M15 33l-4 4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`,
  // The distribution board: the panel door over its rows of breakers.
  "distribution-board": `<svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="12" y="7" width="24" height="34" rx="2" stroke="currentColor" stroke-width="2"/><path d="M17 15h14M17 21h14M17 27h14M17 33h14" stroke="currentColor" stroke-width="1.3"/></svg>`,

  // --- Interior --- (bed/sofa/wardrobe/kitchen-counter drawn identically to
  // the matching asset-library icon, so the same real object reads the
  // same whether it came from this parametric catalog or the GLTF one)
  bed: `<svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="6" y="24" width="36" height="10" rx="1.5" stroke="currentColor" stroke-width="2"/><rect x="6" y="14" width="8" height="10" rx="1" stroke="currentColor" stroke-width="2"/><rect x="16" y="18" width="12" height="6" rx="1" stroke="currentColor" stroke-width="2"/><path d="M6 34v4M42 34v4" stroke="currentColor" stroke-width="2"/></svg>`,
  // A table in plan: the tabletop over its legs.
  table: `<svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="8" y="14" width="32" height="6" rx="1" stroke="currentColor" stroke-width="2"/><path d="M12 20v14M36 20v14" stroke="currentColor" stroke-width="2"/></svg>`,
  // A chair in plan: the seat square under a thick backrest line.
  chair: `<svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="13" y="16" width="22" height="20" rx="2" stroke="currentColor" stroke-width="2"/><path d="M13 16h22" stroke="currentColor" stroke-width="4" stroke-linecap="round"/></svg>`,
  sofa: `<svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M8 26v6a2 2 0 0 0 2 2h28a2 2 0 0 0 2-2v-6" stroke="currentColor" stroke-width="2"/><rect x="6" y="20" width="6" height="12" rx="1.5" stroke="currentColor" stroke-width="2"/><rect x="36" y="20" width="6" height="12" rx="1.5" stroke="currentColor" stroke-width="2"/><rect x="10" y="16" width="28" height="12" rx="2" stroke="currentColor" stroke-width="2"/></svg>`,
  wardrobe: `<svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="12" y="7" width="24" height="34" rx="1.5" stroke="currentColor" stroke-width="2"/><path d="M24 7v34" stroke="currentColor" stroke-width="2"/></svg>`,
  // A base cabinet: the countertop line over its door front.
  "kitchen-cabinet": `<svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="8" y="20" width="32" height="16" rx="1" stroke="currentColor" stroke-width="2"/><path d="M6 20h36" stroke="currentColor" stroke-width="2.5"/><path d="M24 20v16" stroke="currentColor" stroke-width="1.3"/></svg>`,
  "kitchen-counter": `<svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="6" y="14" width="36" height="6" rx="1" stroke="currentColor" stroke-width="2"/><rect x="8" y="20" width="32" height="14" rx="1" stroke="currentColor" stroke-width="2"/></svg>`,

  // --- Exterior ---
  // Lawn/ground in plan: the grade line over a run of grass-blade ticks.
  landscape: `<svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M6 36h36" stroke="currentColor" stroke-width="2"/><path d="M12 36l-2-6M12 36l2-6M20 36l-2-6M20 36l2-6M28 36l-2-6M28 36l2-6M36 36l-2-6M36 36l2-6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>`,
  // A paved path in plan: a winding run with paver joint lines.
  path: `<svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M16 6C11 18 11 30 16 42M32 6c5 12 5 24 0 36" stroke="currentColor" stroke-width="2"/><path d="M15 14h18M14 22h20M14 30h20M15 38h18" stroke="currentColor" stroke-width="1" stroke-dasharray="1 3"/></svg>`,
  // A low boundary/compound wall in elevation: shorter than the structural wall above, with a coping line.
  "boundary-wall": `<svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="6" y="26" width="36" height="12" stroke="currentColor" stroke-width="2"/><path d="M4 26h40" stroke="currentColor" stroke-width="2.5"/><path d="M6 32h36" stroke="currentColor" stroke-width="1" stroke-dasharray="2 3"/></svg>`,
  // A picket gate between its two posts.
  gate: `<svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M9 10v28M39 10v28" stroke="currentColor" stroke-width="2.5"/><rect x="9" y="16" width="30" height="18" stroke="currentColor" stroke-width="1.6"/><path d="M16 16v18M24 16v18M32 16v18" stroke="currentColor" stroke-width="1.2"/></svg>`,
  // The standard architectural tree symbol: a round canopy over its trunk.
  tree: `<svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="24" cy="18" r="12" stroke="currentColor" stroke-width="2"/><path d="M24 29v11" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/></svg>`,
  plant: `<svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M16 30h16l-2 8H18l-2-8Z" stroke="currentColor" stroke-width="2"/><circle cx="24" cy="18" r="10" stroke="currentColor" stroke-width="2"/></svg>`,

  // --- Ribbon-only actions (not a catalog kind) ---
  // A paint roller.
  paint: `<svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="10" y="10" width="20" height="10" rx="2" stroke="currentColor" stroke-width="2"/><path d="M20 20v6h8" stroke="currentColor" stroke-width="2"/><rect x="24" y="26" width="8" height="12" rx="1.5" stroke="currentColor" stroke-width="2"/></svg>`
};

/** A ribbon tool's own icon, or null when this milestone hasn't drawn one yet - see the module doc comment for coverage. Callers fall back to `iconFor()`'s letters, never a blank button. */
export function constructionIconSvg(id: string): string | null {
  return CONSTRUCTION_ICONS[id] ?? null;
}
