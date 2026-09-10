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
 * It also reads the project context: when the instruction names an
 * existing object by id (e.g. "next to wall-1"), the notes list each
 * such object with its type, taken from `request.projectContext.objects`.
 * An id that isn't in the context is not listed. This exists to prove a
 * provider can inspect the supplied model; it never changes which
 * commands are produced.
 *
 * Recognizes only "create/add a <type>" style instructions today - it
 * has no concept of "update", "delete", or "duplicate" instructions,
 * and no dimension/position parsing from free text. That's a
 * deliberate limitation of this deterministic mock, not of
 * AICommandPipeline or the AIProvider interface - see ai/README.md
 * "Limitations".
 */
export class MockAIProvider implements AIProvider {
  interpret(request: AIProviderRequest): AIProviderResponse {
    const clauses = splitIntoClauses(request.instruction);
    const commands: Command[] = [];
    const unrecognized: string[] = [];

    for (const clause of clauses) {
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
    if (referenced.length > 0) {
      notes.push(`Referenced existing objects: ${referenced.map((object) => `${object.id} (${object.type})`).join(", ")}.`);
    }

    return {
      commands,
      notes: notes.length > 0 ? notes.join(" ") : undefined
    };
  }
}
