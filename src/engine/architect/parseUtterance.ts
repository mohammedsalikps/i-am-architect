// Explicit .ts extensions on value imports let Node run this file directly
// (engine/architect/verify.ts does). Harmless for Vite.
import { parseHouseIntent, readHouseRequest } from "../ai/houseIntent.ts";
import { isAdjustment, readMoveTo } from "./adjust.ts";
import { isRelocation } from "./roomEdits.ts";
import { isPipeRun } from "./pipeRun.ts";
import type { ExteriorStyle, RoofStyle } from "../elements/roofStyles.ts";
import type { HouseDesignRequest } from "../ai/houseIntent.ts";
import type { HouseFootprint } from "../ai/housePlan.ts";

/**
 * Classifies one conversational turn for the architect (ArchitectSession).
 * Pure and regex-based, in the same spirit as ai/houseIntent.ts: the
 * architect's vocabulary - a site, a location, a house, a build stage, a
 * yes/no - is small and enumerable, so it is recognized deterministically
 * and offline. Anything this doesn't recognize is `{kind:"unknown"}`, and
 * the session hands it to the existing AI pipeline unchanged - so "Add a
 * wall 5m long" (one new object) still goes exactly where it went before.
 */

export interface PlanPoint {
  x: number;
  z: number;
}

export type ArchitectStage = "foundation" | "structure" | "openings" | "rooms" | "roof" | "interiors";

/** Where a request says to put something. */
export type LocationRef = { kind: "point"; point: PlanPoint } | { kind: "site-centre" } | { kind: "here" };

/** A direction as seen in the Front view: left = -X, right = +X, front = +Z, back = -Z. */
export type Direction = "left" | "right" | "front" | "back";

export type Utterance =
  | { kind: "yes" }
  | { kind: "no" }
  | { kind: "undo" }
  | { kind: "help" }
  | { kind: "status" }
  | { kind: "reset" }
  | { kind: "defaults" }
  | { kind: "pick-location" }
  | { kind: "location"; location: LocationRef }
  /** A workspace view setting, never the model: "set the grid spacing to half a metre". */
  | { kind: "grid"; spacing: number }
  /** "Turn snapping off", "snap to 0.25 m". */
  | { kind: "snapping"; on?: boolean; step?: number }
  /** "Keep the dimensions but make the exterior modern" - the roof's shape and the walls' finish, never a size. `roof`: a roof style said with it. */
  | { kind: "exterior"; style: ExteriorStyle; roof?: RoofStyle }
  /** "Make the roof flat", "change it to a gable roof". */
  | { kind: "roof-style"; style: RoofStyle }
  | { kind: "site"; dimensions?: HouseFootprint; area?: number; location?: LocationRef }
  | { kind: "house"; request: HouseDesignRequest; location?: LocationRef; unsupported?: string }
  | { kind: "details"; request: HouseDesignRequest; location?: LocationRef }
  | { kind: "stage"; stage: ArchitectStage; text: string }
  | { kind: "next" }
  | { kind: "all"; upTo?: ArchitectStage }
  | { kind: "single-opening"; opening: "door" | "window"; text: string }
  | { kind: "clear-conflicts" }
  | { kind: "nearest-free" }
  | { kind: "show"; text: string }
  | { kind: "show-roof" }
  | { kind: "refurnish"; text: string }
  /** `relocate`: into another wall ("put the door on the other wall"), not along its own. */
  | { kind: "move-opening"; text: string; opening: "door" | "window"; distance?: number; direction?: Direction; relocate?: true }
  | { kind: "wall-length"; text: string; length?: number }
  /** One new wall, built by conversation (wallBuilder.ts) - "add a 5 m brick wall", "build a wall". */
  | { kind: "build-wall"; text: string }
  /** A change to one existing element - "move it 2 m east", "make it 3 m high", "use brick instead" (adjust.ts). */
  /** `room`: the words named a room ("make that room 4.5 m wide") - the target is a room, never another object. */
  | { kind: "adjust"; text: string; room?: true }
  /** One new room, built by conversation (roomBuilder.ts) - "create a 4 m by 5 m kitchen, 3 m high". */
  | { kind: "build-room"; text: string }
  | { kind: "pipe-run"; text: string }
  | { kind: "unknown" };

const NUMBER = String.raw`(-?\d+(?:\.\d+)?)`;
const UNSIGNED = String.raw`(\d+(?:\.\d+)?)`;
const METERS = String.raw`(?:\s*(?:m|meters?|metres?)\b)?`;

/** "30 x 20", "30m × 20m", "30 by 20 metres". Unlike houseIntent.ts's own footprint reader, the units are optional. */
const DIMENSIONS = new RegExp(String.raw`\b${UNSIGNED}${METERS}\s*(?:x|×|\*|by)\s*${UNSIGNED}${METERS}`, "i");
const AREA = new RegExp(String.raw`\b${UNSIGNED}\s*(?:sq\.?\s*m|sqm|m2|m²|square\s*met(?:er|re)s?)(?![a-z])`, "i");

/**
 * Plan coordinates: "at 5, -3", "at (5, -3)", "x=5 z=-3", "x 5, z -3",
 * "coordinates 5 -3", "to 4,2", or a bare "5, -3". The second number may
 * be named z or y - people say "y" for the plan's second axis.
 */
const COORDINATES = [
  new RegExp(String.raw`\bx\s*[=:]?\s*${NUMBER}\s*,?\s*(?:and\s*)?[zy]\s*[=:]?\s*${NUMBER}`, "i"),
  new RegExp(String.raw`(?:\bat|\bto|\bcoordinates?|\blocation|\bpoint|\bposition|^)\s*:?\s*\(\s*${NUMBER}\s*,\s*${NUMBER}\s*\)`, "i"),
  new RegExp(
    String.raw`(?:\bat|\bto|\bcoordinates?|\blocation|\bpoint|\bposition)\s*:?\s*${NUMBER}\s*(?:,|\s)\s*${NUMBER}(?![\s-]*(?:m\b|meters?|metres?|bed|x\b|×|by\b))`,
    "i"
  ),
  new RegExp(String.raw`^\s*\(?\s*${NUMBER}\s*,\s*${NUMBER}\s*\)?\s*$`, "i")
];

const HOUSE_NOUN = /\b(?:house|home|bungalow|cottage|villa|residence|dwelling)\b/i;
const WANT_VERB = /\b(?:want|need|like|plan|let'?s|lets|give me)\b/i;
const SITE_NOUN = /\b(?:site|plot|land|lot|parcel)\b/i;
const SITE_CENTRE =
  /\b(?:(?:centre|center|middle)\s+of\s+(?:the\s+)?(?:site|plot|land|lot)|(?:site|plot)\s+(?:centre|center|middle)|on\s+(?:the|my)\s+(?:site|plot))\b/i;
const ORIGIN = /\b(?:at|on|to)\s+(?:the\s+)?origin\b/i;
const HERE = /\bhere\b|\bthis\s+(?:spot|point|location)\b/i;

const WORD_NUMBERS: Readonly<Record<string, number>> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8 };

const YES = /^(?:yes|yeah|yep|yup|sure|ok(?:ay)?|confirm(?:ed)?|go\s+ahead|do\s+it|proceed|sounds\s+good|please\s+do|correct|let'?s\s+go|build\s+it|looks\s+good)\b/i;
const NO = /^(?:no|nope|nah|cancel|stop|never\s*mind|not\s+now|wait)\b/i;
/** What may follow a yes/no without adding anything to it: "yes please", "ok, go ahead". */
const FILLER = /^(?:please|thanks|thank\s+you|go\s+ahead|do\s+it|build\s+it|let'?s\s+go|sure|great|perfect)?[\s.!]*$/i;
const UNDO = /^(?:please\s+)?undo\b/i;
const HELP = /^(?:help|\?|what\s+can\s+you\s+do|how\s+does\s+this\s+work|what\s+do\s+i\s+do)\b/i;
const STATUS = /\b(?:status|progress|where\s+are\s+we|what'?s\s+next|what\s+is\s+next|what\s+have\s+you\s+built)\b/i;
const RESET = /\b(?:new\s+design|start\s+(?:over|again|fresh)|reset\s+(?:the\s+)?(?:design|plan|conversation)|another\s+house|second\s+house)\b/i;
const DEFAULTS = /\b(?:you\s+decide|your\s+call|surprise\s+me|use\s+(?:the\s+)?defaults?|standard\s+(?:plan|house|size)|whatever|doesn'?t\s+matter)\b/i;
const PICK = /\b(?:pick|choose|select|click|mark|set)\b.*\b(?:location|spot|point|place|position|coordinates?)\b|^(?:pick|choose)\b/i;

const NEXT = /^(?:next|continue|go\s+on|keep\s+going|carry\s+on|proceed\s+with\s+the\s+next(?:\s+stage)?|next\s+stage|(?:build|do)\s+(?:the\s+)?next(?:\s+stage)?|and\s+then)\b/i;
const ALL =
  /\b(?:build|do|finish|complete|construct)\b.*\b(?:everything|all\s+(?:stages|of\s+it|the\s+rest|the\s+stages)|the\s+(?:whole\s+thing|rest)|rest\s+of\s+(?:it|the\s+house)|remaining(?:\s+stages)?)\b|^(?:finish|complete)\s+(?:the\s+|my\s+)?(?:house|home|building)\b|^build\s+everything\b|^(?:build|do)\s+(?:it\s+)?all\b/i;
const UP_TO = /\b(?:up\s+to|until|through|including)\s+(?:the\s+)?([a-z &]+)$/i;

const CLEAR = /\b(?:clear|remove|delete|demolish)\b.*\b(?:them|it|those|that|conflicts?|objects?|existing|walls?|everything|way)\b/i;
const NEAREST = /\b(?:nearest|closest)\b.*\b(?:free|clear|empty|spot|space|place)\b|\bfree\s+spot\b|\bmove\s+it\s+(?:over|aside)\b/i;

/** Stage keywords, checked in this order. A plural/collective form is the stage; a singular "a wall" is left to the AI pipeline (one new object). */
const STAGE_PATTERNS: readonly { stage: ArchitectStage; pattern: RegExp }[] = [
  { stage: "interiors", pattern: /\b(?:furnish(?:ing|ed)?|furniture|furnishings|interiors?|decorate|fit[\s-]*out)\b/i },
  { stage: "roof", pattern: /\broof(?:ing)?\b/i },
  { stage: "openings", pattern: /\b(?:doors?\s+and\s+windows?|windows?\s+and\s+doors?|openings|the\s+doors|the\s+windows|doors|windows)\b/i },
  { stage: "rooms", pattern: /\b(?:rooms|room\s+labels|spaces|zones|zoning|label\s+the\s+rooms?|mark\s+(?:out\s+)?the\s+rooms?)\b/i },
  { stage: "structure", pattern: /\b(?:walls|the\s+walls?|columns|pillars|structure|frame|shell|superstructure)\b/i },
  { stage: "foundation", pattern: /\b(?:foundations?|footings?|slab|plinth|base|groundwork)\b/i }
];
const STAGE_VERB =
  /\b(?:build|add|lay|put|place|raise|erect|install|construct|do|start|begin|now|cast|pour|create|make|furnish|decorate|cover|frame|mark|label|fit|next|then|go|and)\b/i;

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function readCoordinates(text: string): PlanPoint | undefined {
  for (const pattern of COORDINATES) {
    const match = pattern.exec(text);
    if (match) {
      const x = Number(match[1]);
      const z = Number(match[2]);
      if (isFinite(x) && isFinite(z)) {
        return { x: round(x), z: round(z) };
      }
    }
  }
  return undefined;
}

/** Where `text` says to put something, if anywhere. */
export function readLocation(text: string): LocationRef | undefined {
  const point = readCoordinates(text);
  if (point) return { kind: "point", point };
  if (ORIGIN.test(text)) return { kind: "point", point: { x: 0, z: 0 } };
  if (SITE_CENTRE.test(text)) return { kind: "site-centre" };
  if (HERE.test(text)) return { kind: "here" };
  return undefined;
}

export function readDimensions(text: string): HouseFootprint | undefined {
  const match = DIMENSIONS.exec(text);
  if (!match) return undefined;
  const length = Number(match[1]);
  const width = Number(match[2]);
  return isFinite(length) && isFinite(width) && length > 0 && width > 0 ? { length, width } : undefined;
}

/**
 * The house parameters in a turn - houseIntent.ts's own readers, plus
 * unit-less footprints ("12 x 9") and word or short bedroom counts
 * ("three bedrooms", "3 bed", "3BHK").
 */
export function readDetails(text: string): HouseDesignRequest {
  const request: HouseDesignRequest = { ...readHouseRequest(text) };
  if (!request.footprint) {
    const dimensions = readDimensions(text);
    if (dimensions) request.footprint = dimensions;
  }
  if (request.bedrooms === undefined) {
    const match = new RegExp(String.raw`\b(\d+|${Object.keys(WORD_NUMBERS).join("|")})[\s-]*(?:bed(?:room)?s?|br|bhk)\b`, "i").exec(text);
    if (match) request.bedrooms = WORD_NUMBERS[match[1].toLowerCase()] ?? Number(match[1]);
  }
  return request;
}

const DISTANCE_WORDS: Readonly<Record<string, number>> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12, fifteen: 15, twenty: 20 };

/** A length in metres: "1 m", "1.5 metres", "50 cm", "300 mm", "one metre", "half a metre", "four metres". */
export function readDistance(text: string): number | undefined {
  const numeric = /(-?\d+(?:\.\d+)?)\s*(mm|millimet(?:er|re)s?|cm|centimet(?:er|re)s?|m|met(?:er|re)s?)\b/i.exec(text);
  if (numeric) {
    const value = Number(numeric[1]);
    const unit = numeric[2].toLowerCase();
    return unit.startsWith("mm") || unit.startsWith("milli") ? value / 1000 : unit.startsWith("c") ? value / 100 : value;
  }
  if (/\bhalf\s+(?:a\s+)?met(?:er|re)\b/i.test(text)) return 0.5;
  const words = new RegExp(String.raw`\b(${Object.keys(DISTANCE_WORDS).join("|")})\s+met(?:er|re)s?\b`, "i").exec(text);
  return words ? DISTANCE_WORDS[words[1].toLowerCase()] : undefined;
}

/** Which way to move, as seen in the Front view - "front door" and "back wall" are names, not directions. */
export function readDirection(text: string): Direction | undefined {
  const said = text.toLowerCase().replace(/\b(?:front|back|rear)\s+(?:door|wall|window)s?\b/g, " ");
  if (/\bleft\b/.test(said)) return "left";
  if (/\bright\b/.test(said)) return "right";
  if (/\b(?:forwards?|frontwards?|toward(?:s)?\s+the\s+front|to\s+the\s+front|front)\b/.test(said)) return "front";
  if (/\b(?:backwards?|toward(?:s)?\s+the\s+back|to\s+the\s+back|back|rear)\b/.test(said)) return "back";
  return undefined;
}

const SHOW = /^(?:please\s+)?(?:show(?:\s+me)?|view|focus(?:\s+on)?|zoom\s+(?:in\s+)?(?:to|on|into)|take\s+me\s+to|go\s+to|look\s+at|where(?:'s|\s+is))\b/i;
const SHOW_ROOF = /\b(?:show|unhide|bring\s+back|restore)\b.*\broof\b|\broof\s+back\b/i;
const REFURNISH = /\b(?:re-?furnish(?:ing)?|re-?decorate|rearrange\s+(?:the\s+)?furniture|redo\s+the\s+furniture)\b|\brearrange\b/i;
const MOVE = /\b(?:move|shift|slide|nudge)\b/i;
const OPENING_REF = /\b(doors?|windows?|entrance)\b|\b(door|window)-\d+\b/i;
const RESIZE = /\b(?:make|set|change|resize|extend|shorten|lengthen|stretch|cut)\b/i;
const WALL_BUILD_VERB = /\b(?:build|add|create|construct|put\s+up|place|raise|erect|draw|make|want|need|give\s+me)\b/i;
const ONE_NEW_WALL = /\b(?:a|an|one|another|new|1)\s+(?:[\w.,×-]+\s+){0,20}?wall\b(?!s)/i;
const ONE_NEW_ROOM = /\b(?:a|an|one|another|new|1)\s+(?:[\w.,×-]+\s+){0,14}?(?:room|bed\s*room|kitchen|bath\s*room|living\s+room|lounge|dining\s+room|study|office|hall(?:way)?|utility|laundry|garage|store(?:room)?|pantry|toilet|washroom)\b(?!s)/i;
// Adding something INTO a room ("add a wall to the kitchen", a door, furniture) - but "with brick walls" is part of the room.
const NOT_ONE_NEW_ROOM = /\b(?:doors?|windows?|furnish\w*|furniture|sofa|bed|table|chair|wardrobe|rooms)\b/i;
const NOT_ONE_NEW_WALL = /\b(?:walls|doors?|windows?|selected|house|home|bungalow|cottage|room|kitchen|bedroom|bathroom)\b/i;

function stageIn(text: string): ArchitectStage | undefined {
  return STAGE_PATTERNS.find(({ pattern }) => pattern.test(text))?.stage;
}

/** The exterior looks: "modern", "traditional". */
const EXTERIOR_LOOK: readonly [RegExp, ExteriorStyle][] = [
  [/\b(?:modern|contemporary|minimal(?:ist)?)\b/i, "modern"],
  [/\b(?:traditional|classic|conventional)\b/i, "traditional"]
];
/** What an exterior restyle is about. */
const EXTERIOR_SUBJECT = /\b(?:exterior|outside|facade|façade|elevations?|look|style|appearance|house|home|building)\b/i;
/** Roof shapes as people say them - mono-pitch first, so "mono-pitched" isn't read as a gable's "pitched". */
const ROOF_SHAPE: readonly [RegExp, RoofStyle][] = [
  [/\bmono[\s-]?pitch(?:ed)?\b|\bshed\b|\bskillion\b|\bsingle[\s-]slop(?:e|ed|ing)\b|\blean[\s-]to\b/i, "mono-pitch"],
  [/\bflat\b/i, "flat"],
  [/\bgabled?\b|\bpitched\b|\bsloping\b|\btwo[\s-]slope\b/i, "gable"]
];
const RESTYLE_VERB = /\b(?:make|change|turn|switch|give|restyle|update|convert|keep|use|style|instead)\b/i;
const CREATE_VERB = /\b(?:build|create|design|add|plan|draw|start|put)\b/i;

/** "Set the grid spacing to half a metre", "change the grid to 25 cm", "a 0.5 m grid". */
const GRID_SETTING = /\bgrid\s+(?:spacing|size|step|cells?|lines?|to|of|every|at)\b|\b(?:set|make|change|use|switch)\s+(?:the\s+)?grid\b|\bgrid\s*[=:]|(?:met(?:er|re)s?|\bm|cm|mm)\s+grid\b/i;
/** "Turn snapping off", "disable snapping", "no snapping". */
const SNAP_OFF = /\bsnap(?:ping)?\s+(?:is\s+)?off\b|\b(?:turn|switch)\s+off\s+(?:the\s+)?snap|\b(?:disable|stop)\s+(?:the\s+)?snap|\b(?:no|without)\s+snap/i;
/** "Turn snapping on", "enable snapping". */
const SNAP_ON = /\bsnap(?:ping)?\s+(?:is\s+)?(?:back\s+)?on\b|\b(?:turn|switch)\s+on\s+(?:the\s+)?snap|\b(?:enable|start)\s+(?:the\s+)?snap/i;
/** "Snap to 0.25 m", "snapping every half a metre", "snap step 0.1 m". */
const SNAP_STEP = /\bsnap(?:ping)?\s+(?:to|every|at|step|of|by)\b|\bsnap(?:ping)?\s+(?:step|increment)\b/i;

export function parseUtterance(raw: string): Utterance {
  const text = raw.trim().replace(/\s+/g, " ");
  if (text.length === 0) return { kind: "unknown" };

  // Workspace view settings - never the model. Before yes/no, so "no, turn snapping off" isn't read as a "no".
  // Only phrased as a setting: "put the wall on the grid, 3 m long" is about the wall.
  if (GRID_SETTING.test(text) && !HOUSE_NOUN.test(text)) {
    const spacing = readDistance(text);
    if (spacing !== undefined) return { kind: "grid", spacing };
  }
  if (SNAP_OFF.test(text)) return { kind: "snapping", on: false };
  const snapStep = SNAP_STEP.test(text) ? readDistance(text) : undefined;
  if (snapStep !== undefined) return { kind: "snapping", on: true, step: snapStep };
  if (SNAP_ON.test(text)) return { kind: "snapping", on: true };

  // The exterior's look and the roof's shape - restyling what is built, never building or resizing.
  if (RESTYLE_VERB.test(text) && !CREATE_VERB.test(text)) {
    const look = EXTERIOR_LOOK.find(([pattern]) => pattern.test(text))?.[1];
    const roofShape = /\broof\b/i.test(text) ? ROOF_SHAPE.find(([pattern]) => pattern.test(text))?.[1] : undefined;
    if (look && EXTERIOR_SUBJECT.test(text)) return { kind: "exterior", style: look, ...(roofShape ? { roof: roofShape } : {}) };
    if (roofShape) return { kind: "roof-style", style: roofShape };
  }

  // "yes" / "no" alone, or followed by filler, is an answer; followed by
  // more ("yes, start with the foundation"), the rest is what counts.
  for (const [pattern, kind] of [
    [YES, "yes"],
    [NO, "no"]
  ] as const) {
    const match = pattern.exec(text);
    if (match) {
      const rest = text.slice(match[0].length).replace(/^[\s,.!:-]+/, "");
      if (FILLER.test(rest)) return { kind };
      const parsed = parseUtterance(rest);
      return parsed.kind === "unknown" ? { kind } : parsed;
    }
  }
  if (UNDO.test(text)) return { kind: "undo" };
  if (HELP.test(text)) return { kind: "help" };
  if (RESET.test(text)) return { kind: "reset" };
  if (CLEAR.test(text) && !HOUSE_NOUN.test(text)) return { kind: "clear-conflicts" };
  if (NEAREST.test(text)) return { kind: "nearest-free" };
  if (DEFAULTS.test(text) && !HOUSE_NOUN.test(text)) return { kind: "defaults" };

  // A pipe run with its points ("run a 25 mm water pipe from 0, 0 to 3, 0") - before walls and rooms,
  // so "a drain pipe from the bathroom ..." isn't taken for a room.
  if (isPipeRun(text)) return { kind: "pipe-run", text };

  // One NEW wall: a build verb and "a/an/another/new ... wall" - never
  // "the ... wall" (an existing one), walls (the structure stage), or
  // anything about doors, windows, rooms or a whole house.
  if (WALL_BUILD_VERB.test(text) && ONE_NEW_WALL.test(text) && !NOT_ONE_NEW_WALL.test(text)) {
    return { kind: "build-wall", text };
  }

  // One NEW room: a build verb and "a/an/another/new ... kitchen/room/..." -
  // not a whole house, not "the rooms" (the rooms stage), and not something
  // to add INTO a room (a wall, door, window or furniture).
  if (WALL_BUILD_VERB.test(text) && ONE_NEW_ROOM.test(text) && !NOT_ONE_NEW_ROOM.test(text) && !ONE_NEW_WALL.test(text) && !HOUSE_NOUN.test(text)) {
    return { kind: "build-room", text };
  }

  // "Move it beside the living room": moving the room just built (or selected) next to another.
  if (/\b(?:move|put|place|shift)\s+(?:it|this|that)\s+(?:beside|next\s+to|adjacent\s+to|alongside|(?:east|west|north|south)\s+of|behind|in\s+front\s+of)\b/i.test(text)) {
    return { kind: "adjust", text };
  }

  // Room-aware edits on the house as it stands (see roomEdits.ts). A
  // "selected" object is left to the AI pipeline's own deterministic
  // edits ("make the selected wall 5 metres long"), exactly as before.
  // A change to "it"/"this"/"the new wall" - not a selected-object edit
  // (the AI pipeline's own deterministic edits keep those), not a house
  // plan change ("make it 12 x 10 m", "3 bedrooms").
  if (!/\bselected\b/i.test(text) && !DIMENSIONS.test(text) && !/\bbed(?:room)?s?\b/i.test(text) && !HOUSE_NOUN.test(text) && isAdjustment(text)) {
    return { kind: "adjust", text };
  }
  // "Make that room 4.5 metres wide", "move this room 2 m east": the room itself is what's changed - read as "it", but only ever a room.
  // Only when it is the verb's own object: "make the wall in that room 4 m long" is about the wall, not the room.
  // Never the possessive: "make that room's left wall 6 m long" is about the wall. "The room" too: with several rooms, it asks which.
  const THAT_ROOM = /\b(make|move|shift|resize|change|set|extend|shrink|enlarge|widen|lengthen|stretch|push|slide|nudge)\s+(?:that|this|the)\s+(?:room|space)\b(?!['’]s\b)/i;
  if (THAT_ROOM.test(text) && !/\bselected\b/i.test(text) && !HOUSE_NOUN.test(text)) {
    const asIt = text.replace(THAT_ROOM, "$1 it");
    if (isAdjustment(asIt)) return { kind: "adjust", text: asIt, room: true };
  }
  // "Move the kitchen to X 10, Y 8", "move it to 10, 8": an edit to something already there - never choosing where the house goes.
  if (readMoveTo(text) && /\b(?:move|shift|put|place)\b/i.test(text) && !HOUSE_NOUN.test(text)) {
    if (isAdjustment(text)) return { kind: "adjust", text };
    return { kind: "unknown" };
  }
  if (SHOW_ROOF.test(text)) return { kind: "show-roof" };
  if (SHOW.test(text)) return { kind: "show", text };
  if (REFURNISH.test(text)) return { kind: "refurnish", text };
  if (!/\bselected\b/i.test(text)) {
    const opening = OPENING_REF.exec(text);
    // Any distance the slide would read ("by half a metre") means a slide along the wall, never a move to another wall.
    if (opening && isRelocation(text) && readDistance(text) === undefined) {
      const word = (opening[1] ?? opening[2]).toLowerCase();
      return { kind: "move-opening", text, opening: word.startsWith("window") ? "window" : "door", relocate: true };
    }
    if (MOVE.test(text) && opening) {
      const word = (opening[1] ?? opening[2]).toLowerCase();
      const distance = readDistance(text);
      const direction = readDirection(text);
      return {
        kind: "move-opening",
        text,
        opening: word.startsWith("window") ? "window" : "door",
        ...(distance !== undefined ? { distance } : {}),
        ...(direction ? { direction } : {})
      };
    }
    if (/\bwalls?\b|\bwall-\d+\b/i.test(text) && RESIZE.test(text) && /\b(?:long|length|met(?:er|re)s?|m)\b/i.test(text) && !HOUSE_NOUN.test(text)) {
      const length = readDistance(text);
      return { kind: "wall-length", text, ...(length !== undefined ? { length } : {}) };
    }
  }

  // "Build the rest of the house" / "finish the house" continue a design -
  // checked before the house classifier, which would otherwise read them
  // as a request for a brand-new house.
  if (ALL.test(text)) {
    const upTo = UP_TO.exec(text);
    const stage = upTo ? stageIn(upTo[1]) : undefined;
    return stage ? { kind: "all", upTo: stage } : { kind: "all" };
  }

  // A whole house: houseIntent.ts's own classifier first, then "I want a house ...".
  const houseIntent = parseHouseIntent(text);
  if (houseIntent.kind !== "none" || (HOUSE_NOUN.test(text) && WANT_VERB.test(text))) {
    const location = readLocation(text);
    return {
      kind: "house",
      request: readDetails(text),
      ...(location ? { location } : {}),
      ...(houseIntent.kind === "unsupported" ? { unsupported: houseIntent.reason } : {})
    };
  }

  if (NEXT.test(text)) return { kind: "next" };
  if (PICK.test(text) && !stageIn(text)) return { kind: "pick-location" };

  if (SITE_NOUN.test(text) && !SITE_CENTRE.test(text) && !/^(?:at|to|on|in|use)\b/i.test(text)) {
    const dimensions = readDimensions(text);
    const area = AREA.exec(text);
    const location = readLocation(text.replace(DIMENSIONS, " "));
    return {
      kind: "site",
      ...(dimensions ? { dimensions } : {}),
      ...(area ? { area: Number(area[1]) } : {}),
      ...(location && location.kind === "point" ? { location } : {})
    };
  }

  const single = /\b(?:a|an|one|another|1)\s+(door|window)\b/i.exec(text);
  if (single && !/\b(?:doors|windows)\b/i.test(text)) {
    return { kind: "single-opening", opening: single[1].toLowerCase() as "door" | "window", text };
  }

  const stage = stageIn(text);
  if (stage && (STAGE_VERB.test(text) || text.split(" ").length <= 4)) {
    return { kind: "stage", stage, text };
  }

  // Bare details - a clarification answer ("3 bedrooms", "12 x 9 m") or a plan change ("make it 12 by 10").
  const details = readDetails(text);
  const location = readLocation(text);
  if (Object.keys(details).length > 0) {
    return { kind: "details", request: details, ...(location ? { location } : {}) };
  }
  if (location) return { kind: "location", location };
  if (STATUS.test(text)) return { kind: "status" };

  // A bare number answers "how many bedrooms?".
  const bare = /^(\d+|one|two|three|four|five|six|seven|eight)$/i.exec(text);
  if (bare) {
    return { kind: "details", request: { bedrooms: WORD_NUMBERS[bare[1].toLowerCase()] ?? Number(bare[1]) } };
  }

  return { kind: "unknown" };
}
