import { MATERIAL_LIBRARY } from "../materials/materialLibrary.ts";
import type { AddWallCommand } from "../commands/types";
import type { HouseFootprint } from "../ai/housePlan.ts";
import { readDistance, readLocation } from "./parseUtterance.ts";
import type { LocationRef } from "./parseUtterance.ts";

/**
 * One wall, built by conversation: the EAVARA Architect asks for whatever
 * the user didn't say - material, length, height, thickness, direction,
 * position - instead of falling back to defaults, then builds it as one
 * validated, undoable `wall.add` (see ArchitectSession). Everything here
 * is plain data and parsing; the session owns the turn-taking and the
 * scene.
 *
 * Materials are the material library's own masonry entries (brick,
 * concrete block, stone masonry - see materials/materialLibrary.ts), so a
 * new masonry material appears here without code changes.
 */

export type WallDirection = "x" | "z";

export interface WallDraft {
  /** A material library id (a masonry material). */
  material?: string;
  /** Metres, along the wall. */
  length?: number;
  /** Metres. */
  height?: number;
  /** Metres. */
  thickness?: number;
  /** "x" runs east-west (along X); "z" runs north-south (along Z). */
  direction?: WallDirection;
  /** The wall's centre on the plan. */
  location?: LocationRef;
}

/** What's asked, in this order - direction before position, so a 3D pick previews the wall the right way round. */
export type WallSlot = "material" | "length" | "height" | "thickness" | "direction" | "position";
export const WALL_SLOTS: readonly WallSlot[] = ["material", "length", "height", "thickness", "direction", "position"];

export const WALL_LIMITS = {
  length: { min: 0.3, max: 50 },
  height: { min: 0.3, max: 10 },
  thickness: { min: 0.05, max: 1 }
} as const;

/** Common thicknesses, offered as choices - never applied unless the user picks one. */
const TYPICAL_THICKNESS: Readonly<Record<string, number>> = { brick: 0.23, "concrete-block": 0.2, "stone-masonry": 0.3 };
const STANDARD_HEIGHT = 2.7;

export interface WallMaterialOption {
  id: string;
  label: string;
  color: string;
  typicalThickness: number;
}

export const WALL_MATERIALS: readonly WallMaterialOption[] = MATERIAL_LIBRARY.filter((material) => material.category === "masonry").map(
  (material) => ({ id: material.id, label: material.label, color: material.color, typicalThickness: TYPICAL_THICKNESS[material.id] ?? 0.2 })
);

const MATERIAL_ALIASES: readonly { id: string; pattern: RegExp }[] = [
  { id: "brick", pattern: /\bbrick(?:s|work)?\b/i },
  { id: "concrete-block", pattern: /\b(?:concrete\s+|cement\s+|cinder\s+)?blocks?\b|\bblockwork\b|\bcmu\b/i },
  { id: "stone-masonry", pattern: /\bstone(?:\s+masonry|work)?\b/i }
];

export function wallMaterial(id: string | undefined): WallMaterialOption | undefined {
  return WALL_MATERIALS.find((material) => material.id === id);
}

/** A masonry material named in `text` ("brick", "concrete block", "stone"), or by its library label. */
export function readWallMaterial(text: string): string | undefined {
  for (const material of WALL_MATERIALS) {
    if (new RegExp(`\\b${material.label.replace(/\s+/g, "\\s+")}\\b`, "i").test(text)) return material.id;
  }
  const alias = MATERIAL_ALIASES.find(({ pattern }) => pattern.test(text));
  return alias && wallMaterial(alias.id) ? alias.id : undefined;
}

const UNIT = String.raw`(?:mm|millimet(?:er|re)s?|cm|centimet(?:er|re)s?|m|met(?:er|re)s?)`;
const DIST = String.raw`(?:\d+(?:\.\d+)?\s*${UNIT}|(?:half\s+(?:a\s+)?|(?:a|an|one|two|three|four|five|six|seven|eight|nine|ten|twelve|fifteen|twenty)\s+)met(?:er|re)s?)\b`;

/** A distance that a qualifier word marks as one dimension: "5 m long", "length of 5 m", "3 metres high", "230 mm thick". */
function qualifiedDistance(text: string, after: string, before: string): number | undefined {
  const trailing = new RegExp(String.raw`(${DIST})\s*(?:${after})\b`, "i").exec(text);
  if (trailing) return readDistance(trailing[1]);
  const leading = new RegExp(String.raw`\b(?:${before})\s*(?:of|is|=|:|to)?\s*(${DIST})`, "i").exec(text);
  return leading ? readDistance(leading[1]) : undefined;
}

export function readWallDirection(text: string): WallDirection | undefined {
  if (/\b(?:east[\s-]*(?:to[\s-]*)?west|west[\s-]*(?:to[\s-]*)?east|along\s+(?:the\s+)?x(?:[\s-]*axis)?|x[\s-]*axis|left\s+to\s+right|side\s+to\s+side|horizontal(?:ly)?)\b/i.test(text)) {
    return "x";
  }
  if (/\b(?:north[\s-]*(?:to[\s-]*)?south|south[\s-]*(?:to[\s-]*)?north|along\s+(?:the\s+)?z(?:[\s-]*axis)?|z[\s-]*axis|front\s+to\s+back|back\s+to\s+front)\b/i.test(text)) {
    return "z";
  }
  return undefined;
}

/** Everything about the wall that `text` states outright - nothing is assumed. */
export function readWallDraft(text: string): WallDraft {
  const draft: WallDraft = {};
  const material = readWallMaterial(text);
  if (material) draft.material = material;

  // "5 x 2.7 x 0.23 m": length x height (x thickness).
  const triple = new RegExp(String.raw`\b(\d+(?:\.\d+)?)\s*(?:m\b)?\s*(?:x|×|by)\s*(\d+(?:\.\d+)?)\s*(?:m\b)?(?:\s*(?:x|×|by)\s*(\d+(?:\.\d+)?)\s*(mm|cm|m)?)?`, "i").exec(text);
  if (triple && /\bwall\b|\bhigh\b|\btall\b|\bx\b|×/i.test(text)) {
    draft.length = Number(triple[1]);
    draft.height = Number(triple[2]);
    if (triple[3]) draft.thickness = readDistance(`${triple[3]} ${triple[4] ?? "m"}`);
  }

  const length = qualifiedDistance(text, "long|in\\s+length|of\\s+length", "length|long");
  const height = qualifiedDistance(text, "high|tall|in\\s+height", "height|high|tall");
  const thickness = qualifiedDistance(text, "thick|wide|in\\s+thickness|deep", "thickness|thick|width");
  if (length !== undefined) draft.length = length;
  if (height !== undefined) draft.height = height;
  if (thickness !== undefined) draft.thickness = thickness;

  // "a 5 metre brick wall": an unqualified distance just before "wall" is its length.
  if (draft.length === undefined) {
    const before = new RegExp(String.raw`(${DIST})(?:\s+[a-z-]+){0,3}\s+wall\b`, "i").exec(text);
    if (before) draft.length = readDistance(before[1]);
  }

  const direction = readWallDirection(text);
  if (direction) draft.direction = direction;
  const location = readLocation(text);
  if (location) draft.location = location;
  return draft;
}

export function missingWallSlot(draft: WallDraft): WallSlot | undefined {
  return WALL_SLOTS.find((slot) => (slot === "position" ? draft.location === undefined : draft[slot] === undefined));
}

/** A number that isn't a sensible size for this dimension - checked before anything is built. */
export function wallSizeProblem(slot: "length" | "height" | "thickness", value: number): string | null {
  const { min, max } = WALL_LIMITS[slot];
  if (!isFinite(value) || value < min || value > max) {
    return `A wall ${slot} must be ${fmtMeters(min)}–${fmtMeters(max)}.`;
  }
  return null;
}

/**
 * The answer to one question, read from the raw words: a unit-less number
 * is metres for length and height ("5" is 5 m), and millimetres for a
 * thickness of 20 or more ("230" is 230 mm); "standard"/"typical" picks
 * the offered standard value. Undefined when the words don't answer it.
 */
export function readSlotAnswer(slot: WallSlot, text: string, draft: WallDraft): Partial<WallDraft> | undefined {
  const said = text.trim();
  switch (slot) {
    case "material": {
      const material = readWallMaterial(said);
      return material ? { material } : undefined;
    }
    case "length":
    case "height":
    case "thickness": {
      if (/\b(?:standard|typical|usual|normal|default)\b/i.test(said)) {
        if (slot === "height") return { height: STANDARD_HEIGHT };
        if (slot === "thickness" && wallMaterial(draft.material)) return { thickness: wallMaterial(draft.material)!.typicalThickness };
      }
      const withUnit = readDistance(said);
      if (withUnit !== undefined) return { [slot]: withUnit };
      const bare = /^(?:about\s+|around\s+)?(\d+(?:\.\d+)?)\s*$/i.exec(said);
      if (!bare) return undefined;
      const value = Number(bare[1]);
      if (slot === "thickness") return value >= 20 ? { thickness: value / 1000 } : value <= 1.5 ? { thickness: value } : undefined;
      return { [slot]: value };
    }
    case "direction": {
      const direction = readWallDirection(said) ?? (/^(?:x|along\s+x)$/i.test(said) ? "x" : /^(?:z|along\s+z)$/i.test(said) ? "z" : undefined);
      return direction ? { direction } : undefined;
    }
    case "position": {
      const location = readLocation(said);
      return location ? { location } : undefined;
    }
  }
}

export function fmtMeters(value: number): string {
  return `${Number(value.toFixed(3))} m`;
}

function fmtThickness(value: number): string {
  return `${Math.round(value * 1000)} mm`;
}

export function directionLabel(direction: WallDirection): string {
  return direction === "x" ? "east–west (along X)" : "north–south (along Z)";
}

/** The wall's plan footprint (X by Z) - for a 3D pick's preview and the overlap check. */
export function wallFootprint(draft: WallDraft): HouseFootprint {
  const length = draft.length ?? 1;
  const thickness = draft.thickness ?? 0.2;
  return draft.direction === "z" ? { length: thickness, width: length } : { length, width: thickness };
}

export interface WallQuestion {
  text: string;
  choices: { label: string; say: string }[];
  /** Ask for a click in the 3D view. */
  pick?: boolean;
}

export function wallQuestion(slot: WallSlot, draft: WallDraft): WallQuestion {
  switch (slot) {
    case "material":
      return {
        text: `What should the wall be built of? ${WALL_MATERIALS.map((material) => material.label).join(", ")}.`,
        choices: WALL_MATERIALS.map((material) => ({ label: material.label, say: material.label.toLowerCase() }))
      };
    case "length":
      return { text: "How long should the wall be, in metres?", choices: [3, 4, 5, 6].map((value) => ({ label: `${value} m`, say: `${value} m` })) };
    case "height":
      return {
        text: `How high should it be? A standard storey wall is ${fmtMeters(STANDARD_HEIGHT)}.`,
        choices: [
          { label: `${fmtMeters(STANDARD_HEIGHT)} (standard)`, say: `${STANDARD_HEIGHT} m` },
          { label: "3 m", say: "3 m" },
          { label: "1.2 m (low wall)", say: "1.2 m" }
        ]
      };
    case "thickness": {
      const material = wallMaterial(draft.material);
      const typical = material?.typicalThickness;
      const values = [...new Set([typical, 0.1, 0.2, 0.23, 0.3].filter((value): value is number => value !== undefined))].slice(0, 4);
      return {
        text: material
          ? `How thick? A typical ${material.label.toLowerCase()} wall is ${fmtThickness(material.typicalThickness)}.`
          : "How thick should the wall be?",
        choices: values.map((value) => ({ label: value === typical ? `${fmtThickness(value)} (typical)` : fmtThickness(value), say: `${Math.round(value * 1000)} mm` }))
      };
    }
    case "direction":
      return {
        text: "Which way should it run?",
        choices: [
          { label: "East–west (along X)", say: "east-west" },
          { label: "North–south (along Z)", say: "north-south" }
        ]
      };
    case "position":
      return {
        text: "Where should its centre be? Say coordinates in metres (e.g. “at 2, 3”), “at the origin”, or pick a spot in the 3D view.",
        choices: [
          { label: "📍 Pick in the 3D view", say: "pick a location" },
          { label: "At the origin", say: "at the origin" }
        ],
        pick: false
      };
  }
}

/** "a 5 m long, 2.7 m high, 230 mm thick brick wall, running east–west, centred at (2, 3)". */
export function describeWall(draft: Required<Omit<WallDraft, "location">> & { center: { x: number; z: number } }): string {
  const material = wallMaterial(draft.material)?.label.toLowerCase() ?? draft.material;
  return `a ${fmtMeters(draft.length)} long, ${fmtMeters(draft.height)} high, ${fmtThickness(draft.thickness)} thick ${material} wall, running ${directionLabel(draft.direction)}, centred at (${draft.center.x}, ${draft.center.z})`;
}

/** Volume of masonry, m³ - length x height x thickness. */
export function wallVolume(draft: { length: number; height: number; thickness: number }): number {
  return Math.round(draft.length * draft.height * draft.thickness * 1000) / 1000;
}

/** The validated command for a complete draft - material colour from the library, resting on the ground (y omitted). */
export function wallCommand(draft: Required<Omit<WallDraft, "location">>, center: { x: number; z: number }): AddWallCommand {
  return {
    type: "wall.add",
    wall: {
      length: draft.length,
      height: draft.height,
      thickness: draft.thickness,
      material: draft.material,
      color: wallMaterial(draft.material)?.color ?? "#c9c9c9",
      rotation: draft.direction === "z" ? Math.PI / 2 : 0,
      position: { x: center.x, z: center.z }
    }
  };
}
