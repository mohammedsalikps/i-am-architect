import type { AIProvider } from "./AIProvider";
import type { AIProviderRequest, AIProviderResponse } from "./types";
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

    return {
      commands,
      notes:
        unrecognized.length > 0
          ? `Could not map to a command: ${unrecognized.map((clause) => `"${clause}"`).join(", ")}`
          : undefined
    };
  }
}
