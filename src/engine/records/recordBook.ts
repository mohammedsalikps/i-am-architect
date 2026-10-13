import type { AIContextObject } from "../ai/types.ts";
import { compareIds } from "../ai/types.ts";
import { getElementKind } from "../elements/catalog.ts";
import { getAssetDefinition } from "../assets/catalog.ts";
import { getMaterial } from "../materials/materialLibrary.ts";

/**
 * The construction record book: one row per real object in the project,
 * with its material, dimensions, position and direction, plus area and
 * volume ONLY where this model's geometry defines them - and totals by
 * element type and material.
 *
 * Derived entirely from the objects as the rest of the app already reads
 * them (buildAIProjectSnapshot's AIContextObject[] - the same input the
 * Construction Method generator uses), never stored: it is recomputed from
 * the scene each time, so it can't disagree with the scene after an edit,
 * undo/redo, or reopening a saved project.
 *
 * A quantity this model can't support (a beam's "area", a sofa's volume,
 * a stair's anything) is null and shown as "—" - never estimated.
 */

export interface RecordRow {
  id: string;
  /** A room's or element's own name, when it has one. */
  label: string | null;
  type: string;
  typeLabel: string;
  material: string;
  materialLabel: string;
  /** Metres - null when the object has no such dimension. */
  length: number | null;
  height: number | null;
  thickness: number | null;
  /** Every other named dimension ("Width 0.9 m"), in metres. */
  otherDimensions: { name: string; value: number }[];
  /** The object's centre, world metres (+Y up, +Z front). */
  position: { x: number; y: number; z: number };
  direction: string;
  area: number | null;
  areaBasis: string | null;
  volume: number | null;
  volumeBasis: string | null;
}

export interface RecordTotal {
  typeLabel: string;
  materialLabel: string;
  count: number;
  /** Sum of lengths, for types measured by length (walls, beams, pipes, cables...). */
  length: number | null;
  /** Sum of the supported areas in this group; null when none is supported. */
  area: number | null;
  volume: number | null;
}

export interface RecordBook {
  rows: RecordRow[];
  totals: RecordTotal[];
  assumptions: string[];
}

export const RECORD_ASSUMPTIONS: readonly string[] = [
  "Units: lengths in metres (m), areas in square metres (m²), volumes in cubic metres (m³). Positions are each element's centre in world coordinates (X east, Y up, Z toward the front).",
  "Walls: area is one face (length × height) minus the doors and windows hosted in that wall; volume is that net area × thickness. No mortar, wastage or brick/block counts are included.",
  "Slabs, floors, ceilings, paths and landscape: plan area length × width; volume × thickness. Foundations: plan area × depth. Pillars: footprint width × depth; volume × height. Beams: volume length × height × width.",
  "Roofs: sloped area of the gable from its run, span and rise (no overhang beyond what is modelled). Doors and windows: opening area width × height. Rooms: floor area only (a room is a space, not built material). Water tanks: cylinder volume.",
  "“—” means this model doesn't define that quantity for the element type - it is not zero and is not estimated."
];

const round3 = (value: number): number => Math.round(value * 1000) / 1000;

function dim(object: AIContextObject, key: string): number | null {
  const value = object.dimensions[key];
  return typeof value === "number" && isFinite(value) ? value : null;
}

function typeLabel(object: AIContextObject): string {
  switch (object.type) {
    case "element":
      return getElementKind(object.kind ?? "")?.label ?? "Element";
    case "asset":
      return getAssetDefinition(object.assetId ?? "")?.label ?? "Furniture";
    default:
      return object.type.charAt(0).toUpperCase() + object.type.slice(1);
  }
}

function materialLabel(id: string): string {
  return getMaterial(id)?.label ?? (id.trim().length > 0 ? id : "Unspecified");
}

/** "east–west (along X)" for a length running along X, "north–south (along Z)" along Z, otherwise the angle. */
function directionOf(object: AIContextObject): string {
  const degrees = (((object.rotation * 180) / Math.PI) % 360 + 360) % 360;
  const near = (target: number) => Math.abs(degrees - target) < 0.5;
  const runsAlongLength = object.type === "wall" || object.type === "beam" || (object.type === "element" && getElementKind(object.kind ?? "")?.linear) || object.kind === "boundary-wall";
  if (runsAlongLength) {
    if (near(0) || near(180) || near(360)) return "east–west (along X)";
    if (near(90) || near(270)) return "north–south (along Z)";
  }
  return `rotated ${Math.round(degrees * 10) / 10}°`;
}

/** Area and volume by this model's own geometry - null where it doesn't define one. */
function quantities(object: AIContextObject, openingArea: number): Pick<RecordRow, "area" | "areaBasis" | "volume" | "volumeBasis"> {
  const none = { area: null, areaBasis: null, volume: null, volumeBasis: null };
  const L = dim(object, "length");
  const H = dim(object, "height");
  const T = dim(object, "thickness");
  const W = dim(object, "width");
  const D = dim(object, "depth");
  switch (object.type) {
    case "wall": {
      if (L === null || H === null || T === null) return none;
      const net = Math.max(0, L * H - openingArea);
      return {
        area: round3(net),
        areaBasis: openingArea > 0 ? `face L × H − ${round3(openingArea)} m² of openings` : "face L × H",
        volume: round3(net * T),
        volumeBasis: "net face area × thickness"
      };
    }
    case "slab":
      return L !== null && W !== null && T !== null ? { area: round3(L * W), areaBasis: "plan L × W", volume: round3(L * W * T), volumeBasis: "L × W × thickness" } : none;
    case "pillar":
      return W !== null && D !== null && H !== null ? { area: round3(W * D), areaBasis: "footprint W × D", volume: round3(W * D * H), volumeBasis: "W × D × H" } : none;
    case "beam":
      return L !== null && H !== null && W !== null ? { area: null, areaBasis: null, volume: round3(L * H * W), volumeBasis: "L × H × W" } : none;
    case "door":
    case "window":
      return W !== null && H !== null ? { area: round3(W * H), areaBasis: "opening W × H", volume: null, volumeBasis: null } : none;
    case "element": {
      switch (object.kind) {
        case "foundation":
          return L !== null && W !== null && D !== null ? { area: round3(L * W), areaBasis: "plan L × W", volume: round3(L * W * D), volumeBasis: "L × W × depth" } : none;
        case "flooring":
        case "ceiling":
        case "path":
        case "landscape":
          return L !== null && W !== null && T !== null ? { area: round3(L * W), areaBasis: "plan L × W", volume: round3(L * W * T), volumeBasis: "L × W × thickness" } : none;
        case "boundary-wall":
          return L !== null && H !== null && T !== null ? { area: round3(L * H), areaBasis: "face L × H", volume: round3(L * H * T), volumeBasis: "L × H × thickness" } : none;
        case "room":
          return L !== null && W !== null ? { area: round3(L * W), areaBasis: "floor L × W", volume: null, volumeBasis: null } : none;
        case "roof": {
          // A gable over the span W, rising H at the ridge, running L.
          if (L === null || W === null || H === null) return none;
          return { area: round3(2 * L * Math.hypot(W / 2, H)), areaBasis: "gable slopes 2 × L × √((W/2)² + rise²)", volume: null, volumeBasis: null };
        }
        case "water-tank": {
          const diameter = dim(object, "diameter");
          return diameter !== null && H !== null ? { area: null, areaBasis: null, volume: round3(Math.PI * (diameter / 2) ** 2 * H), volumeBasis: "cylinder π (d/2)² × H" } : none;
        }
        default:
          return none;
      }
    }
    default:
      return none;
  }
}

/** Whether a type is quantified by length in the totals. */
function measuredByLength(object: AIContextObject): boolean {
  return object.type === "wall" || object.type === "beam" || object.kind === "boundary-wall" || (object.type === "element" && !!getElementKind(object.kind ?? "")?.linear);
}

export function buildRecordBook(objects: readonly AIContextObject[]): RecordBook {
  // Area of the openings each wall hosts - deducted from that wall's face.
  const openings = new Map<string, number>();
  for (const object of objects) {
    if ((object.type === "door" || object.type === "window") && object.hostId) {
      const width = dim(object, "width");
      const height = dim(object, "height");
      if (width !== null && height !== null) openings.set(object.hostId, (openings.get(object.hostId) ?? 0) + width * height);
    }
  }

  const rows: RecordRow[] = [...objects]
    .sort((a, b) => a.type.localeCompare(b.type) || compareIds(a.id, b.id))
    .map((object) => {
      const others = Object.entries(object.dimensions)
        .filter(([key, value]) => !["length", "height", "thickness"].includes(key) && typeof value === "number" && isFinite(value))
        .map(([key, value]) => ({ name: key.charAt(0).toUpperCase() + key.slice(1), value: round3(value) }));
      return {
        id: object.id,
        label: object.label ?? null,
        type: object.type === "element" ? object.kind ?? "element" : object.type,
        typeLabel: typeLabel(object),
        material: object.material,
        materialLabel: materialLabel(object.material),
        length: dim(object, "length") === null ? null : round3(dim(object, "length")!),
        height: dim(object, "height") === null ? null : round3(dim(object, "height")!),
        thickness: dim(object, "thickness") === null ? null : round3(dim(object, "thickness")!),
        otherDimensions: others,
        position: { x: round3(object.position.x), y: round3(object.position.y), z: round3(object.position.z) },
        direction: directionOf(object),
        ...quantities(object, openings.get(object.id) ?? 0)
      };
    });

  // Totals by element type and material, in a stable order.
  const groups = new Map<string, { total: RecordTotal; byLength: boolean }>();
  const rowById = new Map(rows.map((row) => [row.id, row]));
  objects.forEach((object) => {
    const row = rowById.get(object.id)!;
    const key = `${row.typeLabel}\u0000${row.materialLabel}`;
    const group = groups.get(key) ?? { total: { typeLabel: row.typeLabel, materialLabel: row.materialLabel, count: 0, length: null, area: null, volume: null }, byLength: measuredByLength(object) };
    group.total.count += 1;
    if (group.byLength && row.length !== null) group.total.length = round3((group.total.length ?? 0) + row.length);
    if (row.area !== null) group.total.area = round3((group.total.area ?? 0) + row.area);
    if (row.volume !== null) group.total.volume = round3((group.total.volume ?? 0) + row.volume);
    groups.set(key, group);
  });
  const totals = [...groups.values()]
    .map(({ total }) => total)
    .sort((a, b) => a.typeLabel.localeCompare(b.typeLabel) || a.materialLabel.localeCompare(b.materialLabel));

  return { rows, totals, assumptions: [...RECORD_ASSUMPTIONS] };
}

// --- CSV ---

function csvCell(value: string | number | null): string {
  if (value === null) return "n/a";
  const text = typeof value === "number" ? String(value) : value;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function csvLine(cells: readonly (string | number | null)[]): string {
  return cells.map(csvCell).join(",");
}

export const RECORD_CSV_COLUMNS = [
  "ID",
  "Name",
  "Type",
  "Material",
  "Length (m)",
  "Height (m)",
  "Thickness (m)",
  "Other dimensions (m)",
  "X (m)",
  "Y (m)",
  "Z (m)",
  "Direction",
  "Area (m²)",
  "Area basis",
  "Volume (m³)",
  "Volume basis"
] as const;

/** The record book as CSV: every row, then the totals, then the units and assumptions - "n/a" where a quantity isn't defined. */
export function recordBookCsv(book: RecordBook): string {
  const lines = [
    csvLine([...RECORD_CSV_COLUMNS]),
    ...book.rows.map((row) =>
      csvLine([
        row.id,
        row.label ?? "",
        row.typeLabel,
        row.materialLabel,
        row.length,
        row.height,
        row.thickness,
        row.otherDimensions.map((entry) => `${entry.name} ${entry.value}`).join("; "),
        row.position.x,
        row.position.y,
        row.position.z,
        row.direction,
        row.area,
        row.areaBasis,
        row.volume,
        row.volumeBasis
      ])
    ),
    "",
    csvLine(["Totals by type and material"]),
    csvLine(["Type", "Material", "Count", "Total length (m)", "Total area (m²)", "Total volume (m³)"]),
    ...book.totals.map((total) => csvLine([total.typeLabel, total.materialLabel, total.count, total.length, total.area, total.volume])),
    "",
    csvLine(["Units and assumptions"]),
    ...book.assumptions.map((assumption) => csvLine([assumption]))
  ];
  return `${lines.join("\r\n")}\r\n`;
}
