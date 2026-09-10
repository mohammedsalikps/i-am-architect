import type { AIProvider } from "./AIProvider";
import type { AIContextObject, AIProviderRequest, AIProviderResponse } from "./types";
import type { ObjectType } from "../objects/types";
import type { Command } from "../commands/types";

interface KeywordCommand {
  objectType: ObjectType;
  /** Matches a whole-word mention of this object type, e.g. "wall"/"walls" in "Create a wall" - not inside another word like "drywall". */
  pattern: RegExp;
  build: () => Command;
}

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

/**
 * Deterministic stand-in for a real LLM-backed provider (OpenAI/Gemini/
 * Claude - none of which are wired up yet, see ai/README.md). Matches
 * whole-word object-type keywords ("wall", "pillar", "beam", "slab",
 * "door", "window") against each clause of the instruction and emits
 * one "<type>.add" command per recognized clause, in the order the
 * clauses appear, with default dimensions.
 *
 * A clause whose object type isn't in `request.availableObjectTypes` is
 * treated the same as an unrecognized clause - it's reported back via
 * `notes`, not silently produced as a command AICommandPipeline would
 * then have to reject.
 *
 * It also edits existing objects. Four explicit phrasings are recognized
 * and turned into `update_object` commands, checked against the object
 * as `request.projectContext` describes it: "Make wall-1 5 meters long",
 * "Change wall-1 height to 3.2 meters", "Rotate wall-1 by 90 degrees"
 * (or "to"), and "Move wall-1 to X=2". A clause that asks for an edit is
 * never treated as an add: an unknown id, or a dimension the object
 * doesn't have, produces no command and a note instead.
 *
 * And it reads the project context for notes: when the instruction names
 * an existing object by id, the notes list each such object with its
 * type. The snapshot is only ever read, never modified.
 *
 * There is no free-text dimension parsing for adds, no delete or
 * duplicate, and no spatial reasoning. That's a deliberate limitation of
 * this deterministic mock, not of AICommandPipeline or the AIProvider
 * interface - see ai/README.md "Limitations".
 */
export class MockAIProvider implements AIProvider {
  interpret(request: AIProviderRequest): AIProviderResponse {
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

      const match = KEYWORD_COMMANDS.find(
        (candidate) => candidate.pattern.test(clause) && request.availableObjectTypes.includes(candidate.objectType)
      );
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

    return {
      commands,
      notes: notes.length > 0 ? notes.join(" ") : undefined
    };
  }
}
