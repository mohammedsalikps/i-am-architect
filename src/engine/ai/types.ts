import type { ObjectType } from "../objects/types";
import type { CommandResult } from "../commands/types";

/**
 * Provider-independent AI command pipeline - shared type definitions.
 * See ai/README.md for the full architecture. Nothing under
 * src/engine/ai/ imports Three.js, DOM, or any concrete *Store class -
 * see AICommandPipeline.ts for how mutations are routed exclusively
 * through CommandExecutor, and AIProjectSnapshot below for what a
 * provider is allowed to see of the current project.
 */

/** The construction object types the AI layer currently knows how to produce commands for. */
export const AI_SUPPORTED_OBJECT_TYPES: readonly ObjectType[] = [
  "wall",
  "pillar",
  "beam",
  "slab",
  "door",
  "window"
];

/**
 * A read-only summary of the current project - never the live stores
 * themselves. An AIProvider only ever sees this plain data snapshot,
 * never a WallStore/PillarStore/.../SelectionStore instance, so a
 * provider has no way to read or write scene data except through the
 * commands it returns in an AIProviderResponse.
 */
export interface AIProjectSnapshot {
  wallCount: number;
  pillarCount: number;
  beamCount: number;
  slabCount: number;
  doorCount: number;
  windowCount: number;
  assemblyCount: number;
  /** The single selected construction-object id, or null if nothing is selected - same shape SelectionStore.get() returns. */
  selectedObjectId: string | null;
}

/**
 * The subset of ProjectContext's stores buildAIProjectSnapshot() needs,
 * expressed structurally (like commands/types.ts's *HistoryLike
 * interfaces) rather than by importing the concrete WallStore/
 * PillarStore/.../ProjectContext types. A real ProjectContext object
 * satisfies this automatically; nothing here needs to import it, which
 * keeps this module free of any dependency on the *HistoryController
 * classes ProjectContext.ts constructs (those use TypeScript
 * parameter-property constructors, which Node's native TypeScript
 * support can't run - see ai/verify.ts for why that matters).
 */
export interface AIProjectSnapshotSource {
  wallStore: { getAll(): unknown[] };
  pillarStore: { getAll(): unknown[] };
  beamStore: { getAll(): unknown[] };
  slabStore: { getAll(): unknown[] };
  doorStore: { getAll(): unknown[] };
  windowStore: { getAll(): unknown[] };
  assemblyStore: { getAll(): unknown[] };
  selectionStore: { get(): string | null };
}

/** Builds a read-only AIProjectSnapshot from a live ProjectContext (or anything with the same shape) - this is the only place store data crosses into the AI layer, and it only ever crosses as counts, never as object references. */
export function buildAIProjectSnapshot(source: AIProjectSnapshotSource): AIProjectSnapshot {
  return {
    wallCount: source.wallStore.getAll().length,
    pillarCount: source.pillarStore.getAll().length,
    beamCount: source.beamStore.getAll().length,
    slabCount: source.slabStore.getAll().length,
    doorCount: source.doorStore.getAll().length,
    windowCount: source.windowStore.getAll().length,
    assemblyCount: source.assemblyStore.getAll().length,
    selectedObjectId: source.selectionStore.get()
  };
}

/** What AICommandPipeline hands to an AIProvider for one instruction. */
export interface AIProviderRequest {
  /** The user's raw natural-language instruction, already confirmed non-empty by the pipeline. */
  instruction: string;
  /** Read-only snapshot of the current project - see AIProjectSnapshot. */
  projectContext: AIProjectSnapshot;
  /** Which construction object types are currently available to create/edit. */
  availableObjectTypes: readonly ObjectType[];
}

/**
 * What an AIProvider returns. `commands` is deliberately `unknown[]`,
 * not `Command[]` - a provider (especially a future real LLM-backed
 * one) is untrusted input at this boundary, exactly like
 * CommandExecutor.execute()'s own `unknown` parameter. AICommandPipeline
 * is what validates each entry before anything is executed.
 */
export interface AIProviderResponse {
  commands: unknown[];
  /** Optional free-text notes from the provider (e.g. which parts of the instruction it couldn't map to a command) - for logs/debugging, not yet surfaced in the UI. */
  notes?: string;
}

/** One command's outcome after passing through validation and (if valid) CommandExecutor. */
export interface AICommandOutcome {
  /** The raw, not-yet-trusted command as returned by the provider. */
  command: unknown;
  result: CommandResult;
}

/** Where in the pipeline a failure happened - lets a caller distinguish "the provider produced garbage" from "CommandExecutor rejected a well-formed command". */
export type AIPipelineStage = "input" | "provider" | "validation" | "execution";

export interface AIPipelineError {
  stage: AIPipelineStage;
  message: string;
  /** Index into the provider's commands array, when the error is about one specific command. */
  commandIndex?: number;
}

/** The full result of running one instruction through AICommandPipeline.run(). */
export interface AIPipelineResult {
  success: boolean;
  instruction: string;
  outcomes: AICommandOutcome[];
  errors: AIPipelineError[];
}
