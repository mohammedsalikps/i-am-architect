import { HOUSE_FOOTPRINT_LIMITS, type HouseFootprint } from "./housePlan.ts";

/**
 * Recognizes a whole-house DESIGN INTENT ("build a house", "build a 10m x
 * 8m house with 3 bedrooms", "create a small house", ...) in the raw
 * instruction text, and extracts its simple parameters - a footprint, a
 * size adjective, a bedroom count, a named room list, a floor count.
 *
 * This runs entirely locally, BEFORE the AI provider is ever called (see
 * AICommandPipeline.run()): a design request never asks Gemini/OpenAI to
 * invent house geometry - that was the root cause of "build a house"
 * producing an incoherent, incomplete scatter of objects (see
 * ai/README.md and this milestone's own report). Gemini remains fully in
 * the loop for everything this classifier does NOT recognize as a whole-
 * house request - an ordinary single-object instruction ("build a wall",
 * "add a door") falls straight through to the existing provider path,
 * completely unchanged.
 *
 * Deliberately narrow and regex-based, in the same spirit as
 * MockAIProvider.ts's own `asksForHouse()`/`readFootprint()` (which this
 * mirrors, though the two are independent so ai/e2e/verify.ts's existing
 * MockAIProvider-driven house tests aren't affected by anything below) -
 * a "build a house" request is a small, enumerable set of phrasings
 * (task section 5/17), which a classifier can recognize reliably and
 * deterministically; free-form geometry is not.
 */

export interface HouseDesignRequest {
  footprint?: HouseFootprint;
  size?: "small" | "medium" | "large";
  bedrooms?: number;
  /** Explicit named rooms, in the order mentioned, e.g. ["living room", "kitchen", "bedroom", "bedroom"]. */
  rooms?: string[];
  floors?: number;
}

export type HouseIntent =
  | { kind: "none" }
  | { kind: "unsupported"; reason: string }
  | { kind: "house"; request: HouseDesignRequest };

const BUILD_VERB = /\b(?:build|create|design|make|construct|generate|draw)\b/i;
const HOUSE_NOUN = /\b(?:house|home|bungalow|cottage)\b/i;
/** Words between the verb and "house" that name one construction object instead - "build a wall next to the house" asks for a wall, not a house. */
const OBJECT_NOUN = /\b(?:walls?|pillars?|beams?|slabs?|doors?|windows?)\b/i;
const MAX_WORDS_BEFORE_HOUSE = 10;

const NUMBER = String.raw`(\d+(?:\.\d+)?)`;
const METERS = String.raw`\s*m(?:eters?|etres?)?\b`;

/** "10m x 8m", "10 m by 8 m", "10 × 8 meters". */
const FOOTPRINT_X = new RegExp(String.raw`${NUMBER}${METERS}\s*(?:x|×|\*|by)\s*${NUMBER}${METERS}`, "i");
/** "12m wide and 10m deep" / "10m deep and 12m wide" - order-independent. */
const FOOTPRINT_WIDE = new RegExp(String.raw`${NUMBER}${METERS}\s*wide`, "i");
const FOOTPRINT_DEEP = new RegExp(String.raw`${NUMBER}${METERS}\s*(?:deep|long)`, "i");

const WORD_NUMBERS: Readonly<Record<string, number>> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };
/** "3 bedroom", "3-bedroom", "three bedroom". */
const BEDROOM_COUNT = new RegExp(String.raw`\b(\d+|${Object.keys(WORD_NUMBERS).join("|")})[\s-]*bedrooms?\b`, "i");
/** "2 floor", "2-storey", "two story", "2 floors". */
const FLOOR_COUNT = new RegExp(String.raw`\b(\d+|${Object.keys(WORD_NUMBERS).join("|")})[\s-]*(?:floors?|storeys?|stories?)\b`, "i");

const SIZE_ADJECTIVE = /\b(small|large|big|compact|tiny|huge)\b/i;
const SIZE_MAP: Readonly<Record<string, "small" | "large">> = {
  small: "small",
  compact: "small",
  tiny: "small",
  large: "large",
  big: "large",
  huge: "large"
};

/** Room-name keywords a "with ..." / "including ..." clause may list, mapped to their canonical label. Longer phrases first so "master bedroom" matches before "bedroom". */
const ROOM_KEYWORDS: readonly { pattern: RegExp; label: string }[] = [
  { pattern: /master\s*bedrooms?/i, label: "Master Bedroom" },
  { pattern: /living\s*rooms?/i, label: "Living Room" },
  { pattern: /dining\s*rooms?/i, label: "Dining Room" },
  { pattern: /bath\s*rooms?/i, label: "Bathroom" },
  { pattern: /bed\s*rooms?/i, label: "Bedroom" },
  { pattern: /kitchens?/i, label: "Kitchen" },
  { pattern: /studies?|home\s*offices?/i, label: "Study" }
];
/** "2 bedrooms", "a kitchen" - an optional count before a room keyword within a "with ..." list. */
const ROOM_ITEM_COUNT = /^(?:a|an|one)\b|^\d+\b/i;

function wordToNumber(text: string): number {
  return WORD_NUMBERS[text.toLowerCase()] ?? Number(text);
}

/** "Build a simple 2-bedroom house ..." - a build verb whose object is a new house (not some other object mentioned near the word "house"). */
function asksForHouse(instruction: string): boolean {
  const verb = BUILD_VERB.exec(instruction);
  if (!verb) {
    return false;
  }
  const rest = instruction.slice(verb.index + verb[0].length);
  const noun = HOUSE_NOUN.exec(rest);
  if (!noun) {
    return false;
  }
  const between = rest.slice(0, noun.index).trim();
  return between.split(/\s+/).filter(Boolean).length <= MAX_WORDS_BEFORE_HOUSE && !OBJECT_NOUN.test(between);
}

function readFootprint(instruction: string): HouseFootprint | undefined {
  const crossed = FOOTPRINT_X.exec(instruction);
  if (crossed) {
    return { length: Number(crossed[1]), width: Number(crossed[2]) };
  }
  const wide = FOOTPRINT_WIDE.exec(instruction);
  const deep = FOOTPRINT_DEEP.exec(instruction);
  if (wide && deep) {
    return { length: Number(wide[1]), width: Number(deep[1]) };
  }
  return undefined;
}

function readBedrooms(instruction: string): number | undefined {
  const match = BEDROOM_COUNT.exec(instruction);
  return match ? wordToNumber(match[1]) : undefined;
}

function readFloors(instruction: string): number | undefined {
  const match = FLOOR_COUNT.exec(instruction);
  return match ? wordToNumber(match[1]) : undefined;
}

function readSize(instruction: string): "small" | "large" | undefined {
  const match = SIZE_ADJECTIVE.exec(instruction);
  return match ? SIZE_MAP[match[1].toLowerCase()] : undefined;
}

/**
 * "... with a living room, kitchen and 2 bedrooms" / "... including a
 * bathroom" - room names listed after "with"/"including"/"having", each
 * item optionally led by a count ("2 bedrooms" expands to two "Bedroom"
 * entries). Returns undefined when no such clause is found, so callers
 * fall back to the default room set rather than an empty list.
 */
function readNamedRooms(instruction: string): string[] | undefined {
  const clauseMatch = /\b(?:with|including|having)\b(.+)$/i.exec(instruction);
  if (!clauseMatch) {
    return undefined;
  }
  const items = clauseMatch[1].split(/,|\band\b/i).map((item) => item.trim()).filter(Boolean);
  const rooms: string[] = [];
  for (const item of items) {
    const found = ROOM_KEYWORDS.find(({ pattern }) => pattern.test(item));
    if (!found) {
      continue; // an item this milestone doesn't recognize as a room - silently not added, never guessed at
    }
    const countMatch = ROOM_ITEM_COUNT.exec(item.trim());
    const count = countMatch && /^\d+$/.test(countMatch[0]) ? Number(countMatch[0]) : 1;
    for (let i = 0; i < count; i += 1) {
      rooms.push(found.label);
    }
  }
  return rooms.length > 0 ? rooms : undefined;
}

/**
 * The house parameters an instruction mentions - footprint, size,
 * bedrooms, named rooms, floors - without the "is this a build-a-house
 * request at all" gate parseHouseIntent() applies first. The architect
 * conversation (engine/architect/) reads these from a clarification
 * answer ("3 bedrooms, 12 x 9 m") that names no house at all.
 */
export function readHouseRequest(instruction: string): HouseDesignRequest {
  const footprint = readFootprint(instruction);
  const size = readSize(instruction);
  const bedrooms = readBedrooms(instruction);
  const rooms = readNamedRooms(instruction);
  const floors = readFloors(instruction);
  return {
    ...(footprint && isFinite(footprint.length) && isFinite(footprint.width) ? { footprint } : {}),
    ...(size ? { size } : {}),
    ...(bedrooms !== undefined ? { bedrooms } : {}),
    ...(rooms ? { rooms } : {}),
    ...(floors !== undefined ? { floors } : {})
  };
}

/**
 * Classifies one instruction. `{kind:"none"}` for anything that isn't a
 * whole-house request (including every ordinary single-object
 * instruction, which must keep working exactly as before - see task
 * section 2.A). `{kind:"unsupported"}` for a house request that
 * explicitly names a feature this milestone's construction engine
 * genuinely cannot build (currently: more than one floor) - reported as
 * a clear limitation rather than silently built wrong or ignored (task
 * sections 5 and 23). `{kind:"house", request}` otherwise, with whatever
 * parameters were found; every field is optional - resolveHouseDesign()
 * (houseDesign.ts) supplies sensible defaults for what's missing.
 */
export function parseHouseIntent(instruction: string): HouseIntent {
  if (!asksForHouse(instruction)) {
    return { kind: "none" };
  }

  const floors = readFloors(instruction);
  if (floors !== undefined && floors > 1) {
    return { kind: "unsupported", reason: MULTI_FLOOR_REASON };
  }

  const footprint = readFootprint(instruction);
  if (footprint && (!isFinite(footprint.length) || !isFinite(footprint.width))) {
    return { kind: "none" };
  }
  if (footprint && !footprintFits(footprint)) {
    return { kind: "unsupported", reason: footprintReason(footprint) };
  }

  return {
    kind: "house",
    request: {
      ...(footprint ? { footprint } : {}),
      ...(readSize(instruction) ? { size: readSize(instruction) } : {}),
      ...(readBedrooms(instruction) !== undefined ? { bedrooms: readBedrooms(instruction) } : {}),
      ...(readNamedRooms(instruction) ? { rooms: readNamedRooms(instruction) } : {}),
      ...(floors !== undefined ? { floors } : {})
    }
  };
}

const MULTI_FLOOR_REASON =
  "This design currently requires a feature that is not available yet: the construction engine doesn't yet support multiple floors. Describe a single-storey house instead - drop the floor count and I'll build the rest of the design.";

function footprintFits(footprint: HouseFootprint): boolean {
  const { min, max } = HOUSE_FOOTPRINT_LIMITS;
  return footprint.length >= min && footprint.length <= max && footprint.width >= min && footprint.width <= max;
}

function footprintReason(footprint: HouseFootprint): string {
  return `A ${footprint.length} m × ${footprint.width} m footprint is outside what the house planner supports (each side must be ${HOUSE_FOOTPRINT_LIMITS.min}-${HOUSE_FOOTPRINT_LIMITS.max} m).`;
}

/** The room names the house planner knows - what a house plan's `rooms` may contain. */
export const HOUSE_ROOM_LABELS: readonly string[] = [...new Set(ROOM_KEYWORDS.map(({ label }) => label))];
export const HOUSE_BEDROOM_LIMITS = { min: 1, max: 6 } as const;
const HOUSE_PLAN_KEYS = new Set(["bedrooms", "footprint", "rooms", "size", "floors"]);
const MAX_PLAN_ROOMS = 12;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isWholeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

/**
 * Validates a whole-house PLAN an AI provider returned (its response's
 * `house` - see promptSchema.ts) into the same HouseIntent a recognized
 * instruction gives, so it is planned and built by exactly the same
 * deterministic, validated house builder - the provider never supplies
 * a house's geometry. Anything unexpected (an unknown key, a fractional
 * bedroom count, a room the planner doesn't know) refuses the whole plan
 * rather than guessing; a multi-storey or out-of-range plan is
 * `unsupported`, with the same reasons as parseHouseIntent().
 */
export function validateHousePlan(value: unknown): { ok: true; intent: Extract<HouseIntent, { kind: "house" | "unsupported" }> } | { ok: false; error: string } {
  if (!isRecord(value)) {
    return { ok: false, error: "the house plan must be an object" };
  }
  const unknownKey = Object.keys(value).find((key) => !HOUSE_PLAN_KEYS.has(key));
  if (unknownKey !== undefined) {
    return { ok: false, error: `the house plan has an unsupported field "${unknownKey}"` };
  }

  const request: HouseDesignRequest = {};
  if (value.floors !== undefined) {
    if (!isWholeNumber(value.floors) || value.floors < 1) {
      return { ok: false, error: "floors must be a whole number of at least 1" };
    }
    if (value.floors > 1) {
      return { ok: true, intent: { kind: "unsupported", reason: MULTI_FLOOR_REASON } };
    }
    request.floors = value.floors;
  }
  if (value.footprint !== undefined) {
    const footprint = value.footprint;
    if (!isRecord(footprint) || typeof footprint.length !== "number" || typeof footprint.width !== "number" ||
        !isFinite(footprint.length) || !isFinite(footprint.width)) {
      return { ok: false, error: "footprint must be { length, width } in meters" };
    }
    const size = { length: footprint.length, width: footprint.width };
    if (!footprintFits(size)) {
      return { ok: true, intent: { kind: "unsupported", reason: footprintReason(size) } };
    }
    request.footprint = size;
  }
  if (value.bedrooms !== undefined) {
    if (!isWholeNumber(value.bedrooms) || value.bedrooms < HOUSE_BEDROOM_LIMITS.min || value.bedrooms > HOUSE_BEDROOM_LIMITS.max) {
      return { ok: false, error: `bedrooms must be a whole number from ${HOUSE_BEDROOM_LIMITS.min} to ${HOUSE_BEDROOM_LIMITS.max}` };
    }
    request.bedrooms = value.bedrooms;
  }
  if (value.size !== undefined) {
    if (value.size !== "small" && value.size !== "medium" && value.size !== "large") {
      return { ok: false, error: 'size must be "small", "medium" or "large"' };
    }
    request.size = value.size;
  }
  if (value.rooms !== undefined) {
    if (!Array.isArray(value.rooms) || value.rooms.length === 0 || value.rooms.length > MAX_PLAN_ROOMS) {
      return { ok: false, error: `rooms must list 1-${MAX_PLAN_ROOMS} rooms` };
    }
    const rooms: string[] = [];
    for (const room of value.rooms) {
      const label = typeof room === "string" ? HOUSE_ROOM_LABELS.find((known) => known.toLowerCase() === room.trim().toLowerCase()) : undefined;
      if (!label) {
        return { ok: false, error: `rooms may only name ${HOUSE_ROOM_LABELS.join(", ")}` };
      }
      rooms.push(label);
    }
    request.rooms = rooms;
  }
  return { ok: true, intent: { kind: "house", request } };
}
