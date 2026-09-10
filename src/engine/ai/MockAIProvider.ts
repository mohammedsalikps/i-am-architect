import type { AIProvider } from "./AIProvider";
import type { AIContextObject, AIProviderRequest, AIProviderResponse } from "./types";
import type { ObjectType } from "../objects/types";
import type { Command } from "../commands/types";
// Explicit .ts extension on this value import lets Node run this file
// directly (ai/verify.ts, backend/mockBackend.ts) - see
// allowImportingTsExtensions in tsconfig.json. Harmless for Vite too.
import { DEFAULT_HOUSE_FOOTPRINT, HOUSE_FOOTPRINT_LIMITS, buildSimpleHousePlan, findHouseCenter } from "./housePlan.ts";
import { ELEMENT_KINDS } from "../elements/catalog.ts";
import type { HouseFootprint } from "./housePlan";

interface KeywordCommand {
  objectType: ObjectType;
  /** Matches a whole-word mention of this object type, e.g. "wall"/"walls" in "Create a wall" - not inside another word like "drywall". */
  pattern: RegExp;
  build: () => Command;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * One entry per keyword of every element kind in the catalog ("boundary
 * wall", "water pipe", "light switch", ...) - each builds an
 * "element.add" of that kind with the catalog's defaults.
 */
const ELEMENT_KEYWORD_COMMANDS: readonly KeywordCommand[] = ELEMENT_KINDS.flatMap((definition) =>
  definition.keywords.map((keyword) => ({
    objectType: "element" as ObjectType,
    pattern: new RegExp(String.raw`\b${escapeRegExp(keyword).replace(/ /g, String.raw`\s+`)}s?\b`, "i"),
    build: (): Command => ({ type: "element.add", element: { kind: definition.kind } })
  }))
);

// One entry per AI_SUPPORTED_OBJECT_TYPES member (see types.ts) - each
// builds a "<type>.add" command with no options, the same empty-options
// shape CommandExecutor already fills in with sensible defaults via
// createWallData()/createPillarData()/createBeamData()/createSlabData()/
// createDoorData()/createWindowData().
const KEYWORD_COMMANDS: readonly KeywordCommand[] = [
  { objectType: "wall", pattern: /\bwalls?\b/i, build: () => ({ type: "wall.add", wall: {} }) },
  { objectType: "pillar", pattern: /\bpillars?\b/i, build: () => ({ type: "pillar.add", pillar: {} }) },
  { objectType: "beam", pattern: /\bbeams?\b/i, build: () => ({ type: "beam.add", beam: {} }) },
  { objectType: "slab", pattern: /\bslabs?\b/i, build: () => ({ type: "slab.add", slab: {} }) },
  { objectType: "door", pattern: /\bdoors?\b/i, build: () => ({ type: "door.add", door: {} }) },
  { objectType: "window", pattern: /\bwindows?\b/i, build: () => ({ type: "window.add", window: {} }) }
];

/**
 * The object a clause asks for: of every available keyword it mentions,
 * the one mentioned first - and, where two start at the same word, the
 * longer one. So "add a boundary wall" is a boundary wall, not a wall;
 * "add a light switch" is a switch, not a light; and "add a wall around
 * the garden" is still a wall.
 */
function matchKeyword(clause: string, availableObjectTypes: readonly ObjectType[]): KeywordCommand | undefined {
  let best: { command: KeywordCommand; index: number; length: number } | undefined;
  for (const command of [...KEYWORD_COMMANDS, ...ELEMENT_KEYWORD_COMMANDS]) {
    if (!availableObjectTypes.includes(command.objectType)) {
      continue;
    }
    const match = command.pattern.exec(clause);
    if (match && (!best || match.index < best.index || (match.index === best.index && match[0].length > best.length))) {
      best = { command, index: match.index, length: match[0].length };
    }
  }
  return best?.command;
}

/** Splits "Create a wall and add a pillar" / "Create a wall, add a pillar; add a slab" into separate clauses, one instruction per recognizable object mention. */
function splitIntoClauses(instruction: string): string[] {
  return instruction
    .split(/\band\b|[,;\n]+/i)
    .map((clause) => clause.trim())
    .filter((clause) => clause.length > 0);
}

// Characters that can appear inside an object id ("wall-12"). An id only
// counts as mentioned when neither neighbour is one of these, so "wall-1"
// is not found inside "wall-10".
const ID_CHARACTER = /[A-Za-z0-9_-]/;

/** True if `id` appears in `text` as a whole token. */
function mentionsId(text: string, id: string): boolean {
  if (id.length === 0) {
    return false;
  }
  for (let index = text.indexOf(id); index !== -1; index = text.indexOf(id, index + 1)) {
    const before = index > 0 ? text[index - 1] : "";
    const after = index + id.length < text.length ? text[index + id.length] : "";
    if (!ID_CHARACTER.test(before) && !ID_CHARACTER.test(after)) {
      return true;
    }
  }
  return false;
}

// --- Explicit property edits of an existing object ---

const ID = String.raw`([A-Za-z][\w-]*)`;
const NUMBER = String.raw`(\d+(?:\.\d+)?)`;
const SIGNED_NUMBER = String.raw`(-?\d+(?:\.\d+)?)`;
const METERS = String.raw`(?:\s*(?:m|meters?|metres?))?`;

/** "Make wall-1 5 meters long" - the adjective names the dimension. */
const MAKE_SIZE = new RegExp(String.raw`^make\s+${ID}\s+${NUMBER}${METERS}\s+(long|tall|high|wide|deep|thick)\b`, "i");
const SIZE_ADJECTIVES: Readonly<Record<string, string>> = {
  long: "length",
  tall: "height",
  high: "height",
  wide: "width",
  deep: "depth",
  thick: "thickness"
};
/** "Change wall-1 height to 3.2 meters" / "Set wall-1 length to 5" */
const SET_DIMENSION = new RegExp(
  String.raw`^(?:change|set)\s+${ID}(?:'s)?\s+(length|height|width|depth|thickness)\s+to\s+${NUMBER}${METERS}`,
  "i"
);
/** "Rotate wall-1 by 90 degrees" (relative to its current rotation) / "Rotate wall-1 to 45 degrees" (absolute) */
const ROTATE = new RegExp(String.raw`^rotate\s+${ID}\s+(by|to)\s+${SIGNED_NUMBER}\s*(?:degrees?|deg|°)`, "i");
/** "Move wall-1 to X=2" */
const MOVE = new RegExp(String.raw`^move\s+${ID}\s+to\s+([xyz])\s*=?\s*${SIGNED_NUMBER}`, "i");

/** An explicit edit a clause asks for, before it has been checked against the current state. */
type RequestedEdit =
  | { objectId: string; kind: "dimension"; dimension: string; value: number }
  | { objectId: string; kind: "rotation"; mode: "by" | "to"; degrees: number }
  | { objectId: string; kind: "position"; axis: "x" | "y" | "z"; value: number };

function readRequestedEdit(clause: string): RequestedEdit | null {
  const size = MAKE_SIZE.exec(clause);
  if (size) {
    return { objectId: size[1], kind: "dimension", dimension: SIZE_ADJECTIVES[size[3].toLowerCase()], value: Number(size[2]) };
  }
  const set = SET_DIMENSION.exec(clause);
  if (set) {
    return { objectId: set[1], kind: "dimension", dimension: set[2].toLowerCase(), value: Number(set[3]) };
  }
  const rotate = ROTATE.exec(clause);
  if (rotate) {
    return { objectId: rotate[1], kind: "rotation", mode: rotate[2].toLowerCase() as "by" | "to", degrees: Number(rotate[3]) };
  }
  const move = MOVE.exec(clause);
  if (move) {
    return { objectId: move[1], kind: "position", axis: move[2].toLowerCase() as "x" | "y" | "z", value: Number(move[3]) };
  }
  return null;
}

/**
 * Turns a requested edit into an update_object command against the object
 * as the snapshot currently describes it - or explains why it can't. The
 * id must be one the snapshot contains: this never invents an id, and an
 * edit to an unknown object never falls back to creating one.
 */
function toUpdateCommand(
  edit: RequestedEdit,
  objects: readonly AIContextObject[],
  availableObjectTypes: readonly ObjectType[]
): Command | string {
  const object = objects.find((candidate) => candidate.id === edit.objectId);
  if (!object) {
    return `No existing object with id "${edit.objectId}" - nothing to update.`;
  }
  if (!availableObjectTypes.includes(object.type)) {
    return `${object.id} (${object.type}) can't be edited in this context.`;
  }

  switch (edit.kind) {
    case "dimension": {
      if (!Object.prototype.hasOwnProperty.call(object.dimensions, edit.dimension)) {
        return `${object.id} (${object.type}) has no "${edit.dimension}" dimension.`;
      }
      return { type: "update_object", objectId: object.id, changes: { dimensions: { [edit.dimension]: edit.value } } };
    }
    case "rotation": {
      const radians = (edit.degrees * Math.PI) / 180;
      const rotation = edit.mode === "by" ? object.rotation + radians : radians;
      return { type: "update_object", objectId: object.id, changes: { rotation } };
    }
    case "position": {
      const position: { x?: number; y?: number; z?: number } = {};
      position[edit.axis] = edit.value;
      return { type: "update_object", objectId: object.id, changes: { position } };
    }
  }
}

// --- Relationships: an opening in an existing wall, connected endpoints ---

const OBJECT_ID = String.raw`([a-z][a-z0-9]*(?:-[a-z0-9]+)*-\d+)`;
/** "Add a door to wall-1", "Put a window in wall-3" - a new door or window in an existing wall. */
const HOSTED_OPENING = new RegExp(
  String.raw`^(?:add|create|put|place|insert)\s+(?:a|an|one)\s+(door|window)\s+(?:to|in|on|into)\s+(?:the\s+)?${OBJECT_ID}\.?$`,
  "i"
);
/** "Connect water-pipe-1 to water-pipe-2", "Connect cable-1 end to cable-2 start" */
const CONNECT = new RegExp(
  String.raw`^(?:connect|join|link)\s+${OBJECT_ID}(?:'s)?(?:\s+(start|end))?\s+(?:to|with|onto)\s+${OBJECT_ID}(?:'s)?(?:\s+(start|end))?\.?$`,
  "i"
);

/**
 * A clause asking for a relationship between existing objects, as a
 * command - or why it can't be one. Ids must be in the context: an
 * unknown id never becomes a new object. Returns null for any other
 * clause.
 */
function toRelationshipCommand(
  clause: string,
  objects: readonly AIContextObject[],
  availableObjectTypes: readonly ObjectType[]
): Command | string | null {
  const hosted = HOSTED_OPENING.exec(clause);
  if (hosted) {
    const type = hosted[1].toLowerCase() as "door" | "window";
    const wallId = hosted[2].toLowerCase();
    const wall = objects.find((object) => object.id === wallId);
    if (!wall) {
      return `No existing object with id "${wallId}" - no ${type} was added.`;
    }
    if (wall.type !== "wall") {
      return `${wallId} is a ${wall.type}, not a wall - no ${type} was added.`;
    }
    if (!availableObjectTypes.includes(type)) {
      return `A ${type} isn't available in this context.`;
    }
    return type === "door" ? { type: "door.add", door: { hostId: wallId } } : { type: "window.add", window: { hostId: wallId } };
  }

  const connect = CONNECT.exec(clause);
  if (connect) {
    const fromId = connect[1].toLowerCase();
    const toId = connect[3].toLowerCase();
    for (const id of [fromId, toId]) {
      if (!objects.some((object) => object.id === id)) {
        return `No existing object with id "${id}" - nothing was connected.`;
      }
    }
    if (!availableObjectTypes.includes("element")) {
      return "Elements aren't available in this context - nothing was connected.";
    }
    const end = (value: string | undefined) => (value ? { endpoint: value.toLowerCase() as "start" | "end" } : {});
    return { type: "element.connect", from: { id: fromId, ...end(connect[2]) }, to: { id: toId, ...end(connect[4]) } };
  }
  return null;
}

// --- A whole house (see housePlan.ts) ---

const BUILD_VERB = /\b(?:build|create|design|make|construct|generate|draw)\b/i;
const HOUSE_NOUN = /\b(?:house|home|bungalow|cottage)\b/i;
/** Words between the verb and "house" that name one construction object: "build a wall next to the house" asks for a wall. */
const OBJECT_NOUN = /\b(?:walls?|pillars?|beams?|slabs?|doors?|windows?)\b/i;
/** A new house is introduced with an indefinite article: "build a house", "build me a small cottage" - not "make the house walls taller". */
const INDEFINITE = /^(?:me\s+|us\s+)?(?:a|an|one)\b/i;
const MAX_WORDS_BEFORE_HOUSE = 6;

/** "Build a simple 2-bedroom house ..." - a build verb whose object is a new house. */
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
  return (
    INDEFINITE.test(between) &&
    between.split(/\s+/).length <= MAX_WORDS_BEFORE_HOUSE &&
    !OBJECT_NOUN.test(between)
  );
}

/** "10m × 8m", "10 x 8", "12.5 by 9 metres" - length along X first, then width along Z. */
const FOOTPRINT = new RegExp(String.raw`${NUMBER}${METERS}\s*(?:x|×|\*|by)\s*${NUMBER}${METERS}`, "i");

function readFootprint(instruction: string): HouseFootprint | null {
  const match = FOOTPRINT.exec(instruction);
  return match ? { length: Number(match[1]), width: Number(match[2]) } : null;
}

/** Every type the house plan uses. */
const HOUSE_OBJECT_TYPES: readonly ObjectType[] = ["slab", "wall", "pillar", "door", "window"];

/**
 * The house plan for this request, placed clear of whatever the context's
 * geometry section says is already there - or no commands and a note
 * explaining why not.
 */
function planHouse(request: AIProviderRequest): AIProviderResponse {
  const missing = HOUSE_OBJECT_TYPES.filter((type) => !request.availableObjectTypes.includes(type));
  if (missing.length > 0) {
    return {
      commands: [],
      notes: `A house needs ${missing.join(", ")}, which ${missing.length === 1 ? "isn't" : "aren't"} available in this context - no house was planned.`
    };
  }

  const requested = readFootprint(request.instruction);
  const footprint = requested ?? DEFAULT_HOUSE_FOOTPRINT;
  const { min, max } = HOUSE_FOOTPRINT_LIMITS;
  const fits = (side: number) => side >= min && side <= max;
  if (!fits(footprint.length) || !fits(footprint.width)) {
    return {
      commands: [],
      notes: `A ${footprint.length} m × ${footprint.width} m footprint is outside what the house plan supports (each side ${min}-${max} m) - no house was planned.`
    };
  }

  const occupied = (request.projectContext.geometry?.objects ?? []).map((object) => object.aabb);
  const center = findHouseCenter(footprint, occupied);
  const commands = buildSimpleHousePlan({ ...footprint, center });

  const where =
    center.x === 0 && center.z === 0 ? "centered on the origin" : `centered at x = ${center.x}, z = ${center.z}, clear of the existing objects`;
  const notes = [
    `Planned a simple ${footprint.length} m × ${footprint.width} m house ${where}: 1 slab, 4 perimeter walls between 4 corner pillars, 1 front door and 2 windows (${commands.length} commands).`
  ];
  if (!requested) {
    notes.push(`No footprint was given, so the default ${DEFAULT_HOUSE_FOOTPRINT.length} m × ${DEFAULT_HOUSE_FOOTPRINT.width} m was used.`);
  }
  notes.push("Rooms, finishes, and services weren't part of the plan, so no interior walls were placed - add them from the ribbon or ask for them.");
  return { commands, notes: notes.join(" ") };
}

/**
 * Deterministic stand-in for a real LLM-backed provider. No network, no
 * randomness: the same request always gets the same response.
 *
 * **A whole house.** An instruction asking to build a new house ("Build a
 * simple 2-bedroom house on a 10m × 8m footprint") gets the complete plan
 * from housePlan.ts - slab, perimeter walls, corner pillars, a door, and
 * two windows, as one ordered list of `<type>.add` commands with explicit
 * positions and rotations. The footprint is read from the instruction
 * ("10m × 8m", "10 x 8", "10 by 8 metres") and defaults to 10 m × 8 m.
 * The plan goes on the origin when that's free; otherwise the context's
 * geometry section decides where it goes, clear of every existing object.
 * Rooms, finishes, and services aren't part of the plan - the notes say so.
 *
 * **Single objects.** Otherwise it matches whole-word object-type keywords
 * ("wall", "pillar", "beam", "slab", "door", "window") and every element
 * kind's catalog keywords ("roof", "water pipe", "light switch", "sofa",
 * ...) against each clause of the instruction and emits one "<type>.add"
 * or "element.add" command per recognized clause, in the order the clauses
 * appear, with default dimensions - see matchKeyword() for which keyword
 * wins when a clause mentions more than one.
 *
 * A clause whose object type isn't in `request.availableObjectTypes` is
 * treated the same as an unrecognized clause - it's reported back via
 * `notes`, not silently produced as a command AICommandPipeline would
 * then have to reject.
 *
 * **Edits.** Four explicit phrasings are recognized and turned into
 * `update_object` commands, checked against the object as
 * `request.projectContext` describes it: "Make wall-1 5 meters long",
 * "Change wall-1 height to 3.2 meters", "Rotate wall-1 by 90 degrees" (or
 * "to"), and "Move wall-1 to X=2". A clause that asks for an edit is never
 * treated as an add: an unknown id, or a dimension the object doesn't
 * have, produces no command and a note instead.
 *
 * **Relationships.** "Add a door to wall-1" (or a window; "to", "in",
 * "on", "into") puts a new opening into that existing wall -
 * `door.add { hostId }`. "Connect water-pipe-1 to water-pipe-2" (with an
 * optional "start"/"end" after either id) is an `element.connect`. Both
 * ids must be in the context; otherwise there's a note and no command.
 *
 * **Notes from the context.** When the instruction names an existing
 * object by id, the notes list each such object with its type. When it
 * names two or more, the notes also carry each named pair's relationship
 * from the context's geometry section, as the exact JSON the analysis
 * produced - uninterpreted, and never turned into a command. The context
 * is only ever read, never modified.
 *
 * There is no free-text dimension parsing for single adds, no delete or
 * duplicate, and no planning beyond the one house layout. That's a
 * deliberate limitation of this deterministic mock, not of
 * AICommandPipeline or the AIProvider interface - see ai/README.md
 * "Limitations".
 */
export class MockAIProvider implements AIProvider {
  interpret(request: AIProviderRequest): AIProviderResponse {
    if (asksForHouse(request.instruction)) {
      return planHouse(request);
    }

    const clauses = splitIntoClauses(request.instruction);
    const commands: Command[] = [];
    const unrecognized: string[] = [];
    const editProblems: string[] = [];

    for (const clause of clauses) {
      const edit = readRequestedEdit(clause);
      if (edit) {
        const result = toUpdateCommand(edit, request.projectContext.objects, request.availableObjectTypes);
        if (typeof result === "string") {
          editProblems.push(result);
        } else {
          commands.push(result);
        }
        continue;
      }

      const relationship = toRelationshipCommand(clause, request.projectContext.objects, request.availableObjectTypes);
      if (relationship) {
        if (typeof relationship === "string") {
          editProblems.push(relationship);
        } else {
          commands.push(relationship);
        }
        continue;
      }

      const match = matchKeyword(clause, request.availableObjectTypes);
      if (match) {
        commands.push(match.build());
      } else {
        unrecognized.push(clause);
      }
    }

    // Existing objects the instruction names by id, in snapshot order.
    const referenced: AIContextObject[] = request.projectContext.objects.filter((object) =>
      mentionsId(request.instruction, object.id)
    );

    const notes: string[] = [];
    if (unrecognized.length > 0) {
      notes.push(`Could not map to a command: ${unrecognized.map((clause) => `"${clause}"`).join(", ")}`);
    }
    notes.push(...editProblems);
    if (referenced.length > 0) {
      notes.push(`Referenced existing objects: ${referenced.map((object) => `${object.id} (${object.type})`).join(", ")}.`);
    }

    // For each pair of named objects, the relationship the context's
    // geometry section already holds - copied verbatim as JSON, in the
    // analysis's own pair order. Proves geometry reaches a provider; the
    // mock neither interprets it nor acts on it.
    const referencedIds = new Set(referenced.map((object) => object.id));
    for (const relationship of request.projectContext.geometry?.relationships ?? []) {
      if (referencedIds.has(relationship.a) && referencedIds.has(relationship.b)) {
        notes.push(`Geometry relationship: ${JSON.stringify(relationship)}.`);
      }
    }

    return {
      commands,
      notes: notes.length > 0 ? notes.join(" ") : undefined
    };
  }
}
