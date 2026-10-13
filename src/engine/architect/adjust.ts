import { readDistance } from "./parseUtterance.ts";
import { readWallMaterial } from "./wallBuilder.ts";

/**
 * Conversational edits to ONE existing element - "it", "this", "that",
 * "the new wall": "move it two metres east", "make it 3 m high", "use brick
 * instead". The session decides what "it" is (the wall just built, or the
 * selection - and asks when those disagree); this file only reads what the
 * words ask for. A size with no dimension word ("make it 5 metres") is
 * reported as ambiguous, never guessed.
 */

export type Adjustment =
  | { kind: "move"; dx: number; dz: number; distance: number; direction: string }
  /** `change`: "1 m longer" (+1) or "1 m shorter" (-1) - a change by `value`, not a new size of `value`. */
  | { kind: "resize"; dimension: "length" | "width" | "height" | "thickness"; value: number; change?: 1 | -1 }
  | { kind: "material"; material: string }
  | { kind: "ambiguous-size"; value: number };

/** Words that point at one element already in the conversation. */
export const ADJUST_TARGET = /\b(?:it|this|that|the\s+(?:new|last|same)\s+wall|this\s+wall|that\s+wall)\b/i;
const MOVE_VERB = /\b(?:move|shift|slide|nudge|push|pull)\b/i;
const SIZE_VERB = /\b(?:make|set|change|resize|extend|shorten|lengthen|raise|lower)\b/i;
const MATERIAL_VERB = /\b(?:use|switch(?:\s+it)?\s+to|change\s+(?:it\s+)?to|make\s+it|build\s+it\s+(?:in|with|from|out\s+of)|in|instead)\b/i;

/** Compass directions are world axes: east +X, west -X, north -Z (away from the front), south +Z (toward the front). */
const DIRECTIONS: readonly { pattern: RegExp; dx: number; dz: number; name: string }[] = [
  { pattern: /\beast(?:wards?)?\b/i, dx: 1, dz: 0, name: "east" },
  { pattern: /\bwest(?:wards?)?\b/i, dx: -1, dz: 0, name: "west" },
  { pattern: /\bnorth(?:wards?)?\b/i, dx: 0, dz: -1, name: "north" },
  { pattern: /\bsouth(?:wards?)?\b/i, dx: 0, dz: 1, name: "south" },
  { pattern: /\bright\b/i, dx: 1, dz: 0, name: "right" },
  { pattern: /\bleft\b/i, dx: -1, dz: 0, name: "left" },
  { pattern: /\b(?:forwards?|to\s+the\s+front|toward(?:s)?\s+the\s+front)\b/i, dx: 0, dz: 1, name: "forward" },
  { pattern: /\b(?:backwards?|back|to\s+the\s+back|toward(?:s)?\s+the\s+back)\b/i, dx: 0, dz: -1, name: "back" }
];

/** Comparative size words: "1 m longer" is a change of +1 m, never a new length of 1 m. */
const COMPARATIVES: Readonly<Record<string, 1 | -1>> = {
  longer: 1,
  shorter: -1,
  wider: 1,
  narrower: -1,
  deeper: 1,
  taller: 1,
  higher: 1,
  lower: -1,
  thicker: 1,
  thinner: -1
};

const DIMENSION_WORDS: readonly { dimension: "length" | "width" | "height" | "thickness"; pattern: RegExp }[] = [
  { dimension: "length", pattern: /\b(?:long|length|longer|shorter)\b/i },
  { dimension: "width", pattern: /\b(?:wide|width|wider|narrower|deep|depth)\b/i },
  { dimension: "height", pattern: /\b(?:high|tall|height|higher|taller|lower)\b/i },
  { dimension: "thickness", pattern: /\b(?:thick|thickness|thicker|thinner)\b/i }
];

const UNIT = String.raw`(?:mm|millimet(?:er|re)s?|cm|centimet(?:er|re)s?|m|met(?:er|re)s?)`;
const NUMBER_WORDS = "a|an|one|two|three|four|five|six|seven|eight|nine|ten|twelve|fifteen|twenty|half\\s+a";
const DISTANCE = new RegExp(String.raw`(?:\d+(?:\.\d+)?\s*${UNIT}|(?:${NUMBER_WORDS})\s+met(?:er|re)s?)\b`, "gi");

/** Every distance in `text`, in order, with its position and value in metres. */
function distances(text: string): { index: number; end: number; value: number }[] {
  const found: { index: number; end: number; value: number }[] = [];
  for (const match of text.matchAll(DISTANCE)) {
    const value = readDistance(match[0]);
    if (value !== undefined && match.index !== undefined) found.push({ index: match.index, end: match.index + match[0].length, value });
  }
  return found;
}

/** "Use brick instead", "switch to block", "move 2 m east": the element in hand is implied. */
const IMPLIED_TARGET = /^\s*(?:(?:now|then|and|ok(?:ay)?|no)[\s,]+)?(?:use|switch\s+to|change\s+to|move|shift|nudge|slide)\b|\binstead\b/i;
/** A named element ("the front door", "the kitchen", "the back wall") is a room edit, not "it". */
const NAMED_ELEMENT = /\bthe\s+(?!new\b|last\b|same\b)[a-z-]+\s+(?:wall|door|window)s?\b|\b(?:doors?|windows?|entrance|kitchen|bedroom|bathroom|living|dining|study|room)\b/i;

/** Whether `text` asks to change an existing element ("it"/"this"/"the new wall", or implied) rather than build something. */
export function isAdjustment(text: string): boolean {
  if (NAMED_ELEMENT.test(text)) return false;
  if (!ADJUST_TARGET.test(text) && !IMPLIED_TARGET.test(text)) return false;
  return readAdjustments(text).length > 0;
}

/** What the words ask for - possibly several ("make it 4 m long and 3 m high"). Empty when nothing is recognized. */
export function readAdjustments(text: string): Adjustment[] {
  const adjustments: Adjustment[] = [];
  const found = distances(text);

  if (MOVE_VERB.test(text)) {
    const direction = DIRECTIONS.find(({ pattern }) => pattern.test(text));
    if (direction && found.length > 0) {
      const distance = found[0].value;
      adjustments.push({ kind: "move", dx: direction.dx * distance, dz: direction.dz * distance, distance, direction: direction.name });
      return adjustments;
    }
  }

  if (SIZE_VERB.test(text) || /\bno\b/i.test(text)) {
    for (const entry of found) {
      // The dimension word right after the distance ("4 m long") - or, failing that, right before it ("height of 3 m").
      const after = text.slice(entry.end, entry.end + 16);
      const before = text.slice(Math.max(0, entry.index - 16), entry.index);
      const namedAfter = DIMENSION_WORDS.find(({ pattern }) => pattern.test(after));
      const named = namedAfter ?? DIMENSION_WORDS.find(({ pattern }) => pattern.test(before));
      const near = namedAfter ? after : before;
      const comparative = Object.keys(COMPARATIVES).find((word) => new RegExp(String.raw`\b${word}\b`, "i").test(near));
      adjustments.push(
        named
          ? { kind: "resize", dimension: named.dimension, value: entry.value, ...(comparative ? { change: COMPARATIVES[comparative] } : {}) }
          : { kind: "ambiguous-size", value: entry.value }
      );
    }
  }

  const material = readWallMaterial(text);
  if (material && MATERIAL_VERB.test(text)) adjustments.push({ kind: "material", material });
  return adjustments;
}
