import type { AIProvider } from "./AIProvider";
// Explicit .ts extension on this value import (unlike the type-only
// imports elsewhere in this file) is required so Node can run this
// file directly, e.g. from src/engine/ai/verify.ts - see
// allowImportingTsExtensions in tsconfig.json. Harmless for Vite too.
import { AI_SUPPORTED_OBJECT_TYPES } from "./types.ts";
import { buildAIProjectContext } from "./aiProjectContext.ts";
import { parseHouseIntent } from "./houseIntent.ts";
import { buildHouseDesign, planHouseDesign, summarizeHouseDesign } from "./houseDesign.ts";
import { executeCommandBatch } from "../commands/executeCommandBatch.ts";
import type { HistoryGroupLike } from "../commands/executeCommandBatch";
import type { AICommandOutcome, AIPipelineError, AIPipelineResult, AIProjectContext, AIProjectSnapshot } from "./types";
import type { ObjectType } from "../objects/types";
import type { CommandResult } from "../commands/types";

/**
 * The subset of CommandExecutor's public API AICommandPipeline actually
 * depends on, expressed structurally rather than by importing the
 * concrete CommandExecutor class - the same "depend on a narrow shape,
 * not the concrete class" reasoning as commands/types.ts's *HistoryLike
 * interfaces. A real CommandExecutor instance satisfies this
 * automatically; a lightweight stand-in (e.g. a call-recording spy) can
 * satisfy it too, which is what ai/verify.ts uses to prove this class
 * never mutates anything except by calling `.execute()`.
 */
export interface CommandExecutorLike {
  execute(input: unknown): CommandResult;
}

/**
 * The most commands one provider response may contain. A simple house is
 * 12; this leaves room for far larger plans while bounding how much an
 * untrusted response can make the application do.
 */
export const MAX_COMMANDS_PER_RESPONSE = 200;

const SUPPORTED_ACTIONS: readonly string[] = ["add", "update", "delete", "duplicate", "connect"];

const UPDATE_OBJECT = "update_object";

/**
 * Structural checks for update_object - the one command whose name isn't
 * "<objectType>.<action>". Its object type isn't in the command at all
 * (CommandExecutor resolves it from the id), so type availability is
 * checked against the snapshot this run was given. Whether the id really
 * exists, and whether the changes are valid, stay CommandExecutor's (and
 * the stores') job - an id the snapshot doesn't know passes through here
 * and gets the executor's authoritative "not found" error.
 */
function validateUpdateObjectShape(
  raw: Record<string, unknown>,
  availableObjectTypes: readonly ObjectType[],
  projectContext: AIProjectSnapshot
): string | null {
  const objectId = raw.objectId;
  if (typeof objectId !== "string" || objectId.length === 0) {
    return 'Malformed update_object command: missing or invalid "objectId".';
  }

  const changes = raw.changes;
  if (typeof changes !== "object" || changes === null || Array.isArray(changes)) {
    return 'Malformed update_object command: "changes" must be an object.';
  }

  const target = projectContext.objects.find((object) => object.id === objectId);
  if (target && !availableObjectTypes.includes(target.type)) {
    return `Object type "${target.type}" is not available in this context.`;
  }

  return null;
}

/**
 * Structurally validates one provider-returned command before it's
 * allowed anywhere near CommandExecutor. This is deliberately separate
 * from (and runs before) CommandExecutor's own validation: CommandExecutor
 * already rejects a malformed/unknown command, but its error messages
 * don't distinguish "not shaped like a command at all" from "unsupported
 * object type" from "unsupported command type" - distinctions this
 * pipeline's callers need (see requirement list in ai/README.md).
 * Domain-level problems (e.g. invalid dimensions) are deliberately NOT
 * checked here - CommandExecutor (via each store's validator) already
 * owns that, and duplicating it here would risk the two disagreeing.
 */
function validateCommandShape(
  raw: unknown,
  availableObjectTypes: readonly ObjectType[],
  projectContext: AIProjectSnapshot
): string | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return "Malformed command: expected a plain object.";
  }

  const type = (raw as { type?: unknown }).type;
  if (typeof type !== "string" || type.length === 0) {
    return 'Malformed command: missing or invalid "type" field.';
  }

  if (type === UPDATE_OBJECT) {
    return validateUpdateObjectShape(raw as Record<string, unknown>, availableObjectTypes, projectContext);
  }

  const separatorIndex = type.indexOf(".");
  if (separatorIndex <= 0 || separatorIndex === type.length - 1) {
    return `Malformed command: "type" must be of the form "<objectType>.<action>", got "${type}".`;
  }

  const objectType = type.slice(0, separatorIndex);
  const action = type.slice(separatorIndex + 1);

  if (!AI_SUPPORTED_OBJECT_TYPES.includes(objectType as ObjectType)) {
    return `Unsupported object type: "${objectType}".`;
  }
  if (!availableObjectTypes.includes(objectType as ObjectType)) {
    return `Object type "${objectType}" is not available in this context.`;
  }
  if (!SUPPORTED_ACTIONS.includes(action)) {
    return `Unsupported command type: "${action}".`;
  }

  return null;
}

/**
 * Turns one natural-language instruction into executed construction
 * commands. Never touches Three.js scene objects or any *Store directly
 * - the only thing this class ever calls to cause a mutation is
 * `commandExecutor.execute()`. See ai/README.md for the full
 * architecture. Always runs in this order:
 *
 *  1. Reject an empty instruction outright - the provider is never
 *     called for one.
 *  2. Call the provider, then structurally validate EVERY command it
 *     returned (malformed shape, unsupported object type, unsupported
 *     command type). If any one is invalid, nothing is executed.
 *  3. Execute the whole response through CommandExecutor (which applies
 *     its own domain validation - e.g. invalid dimensions - exactly the
 *     same way it does for UI-issued commands) as one all-or-nothing
 *     batch: see commands/executeCommandBatch.ts.
 *
 * A response is therefore applied completely or not at all. A plan such
 * as a 12-object house never leaves half a house behind: a command the
 * stores reject rolls back every command before it. With a `history`
 * (the running app always passes the shared HistoryManager), the applied
 * response is ONE undo entry, so one Undo removes everything it built and
 * one Redo brings it back. Without one - only unit tests do this - the
 * batch still stops at the first failure, but nothing can be rolled back.
 *
 * A WHOLE-HOUSE DESIGN REQUEST ("build a house", "build a 10m x 8m house
 * with 3 bedrooms", ...) is recognized locally, by parseHouseIntent()
 * (houseIntent.ts), before any of the above - the provider is never
 * called for one. Its parameters (footprint, room list, size, bedroom
 * count) are resolved into a real, room-partitioned house by
 * houseDesign.ts's deterministic planner, executed inside the exact same
 * kind of history group as an ordinary provider response, so it is just
 * as atomic (one failure rolls back everything already built; success is
 * one undo entry). This exists because letting a real AI provider
 * freehand the geometry for a dozen-plus objects at once was exactly
 * what produced an incoherent, incomplete house - see this milestone's
 * own report. Everything that ISN'T a whole-house request (an ordinary
 * "build a wall", "add a door", or an edit) falls straight through to
 * the provider path below, completely unchanged.
 */
export class AICommandPipeline {
  // Plain field declarations + assignment in the constructor body,
  // deliberately NOT TypeScript parameter-property shorthand - unlike
  // the *HistoryController classes (see history/wallHistory.ts etc.),
  // this class IS instantiated directly by ai/verify.ts, and Node's
  // native TypeScript support cannot run parameter properties (only
  // erasable syntax is supported).
  private readonly provider: AIProvider;
  private readonly commandExecutor: CommandExecutorLike;
  /** Only its group methods are used - to make a response one undo entry and to roll a failed one back. Never a store. */
  private readonly history: HistoryGroupLike | undefined;

  constructor(provider: AIProvider, commandExecutor: CommandExecutorLike, history?: HistoryGroupLike) {
    this.provider = provider;
    this.commandExecutor = commandExecutor;
    this.history = history;
  }

  /**
   * Always returns a Promise, even when `provider` happens to be
   * synchronous (e.g. MockAIProvider) - `await`ing a plain value
   * resolves it on the next microtask, so a synchronous provider costs
   * nothing extra here. This is the one place the "real providers need
   * async" limitation flagged in earlier versions of this file was
   * meant to be absorbed - see ai/README.md.
   */
  async run(
    instruction: string,
    snapshot: AIProjectSnapshot,
    availableObjectTypes: readonly ObjectType[] = AI_SUPPORTED_OBJECT_TYPES
  ): Promise<AIPipelineResult> {
    const trimmedInstruction = typeof instruction === "string" ? instruction.trim() : "";

    if (trimmedInstruction.length === 0) {
      return {
        success: false,
        instruction,
        outcomes: [],
        errors: [{ stage: "input", message: "Instruction is empty." }]
      };
    }

    // Geometry is derived here, from this exact snapshot, on every run -
    // so whichever caller built the snapshot, the provider always sees
    // geometry that matches the objects beside it. Any `geometry` already
    // on the argument is ignored (see buildAIProjectContext).
    const projectContext = buildAIProjectContext(snapshot);

    const houseIntent = parseHouseIntent(trimmedInstruction);
    if (houseIntent.kind !== "none") {
      return this.runHouseDesign(instruction, houseIntent, projectContext, availableObjectTypes);
    }

    let response;
    try {
      response = await this.provider.interpret({
        instruction: trimmedInstruction,
        projectContext,
        availableObjectTypes
      });
    } catch (error) {
      return {
        success: false,
        instruction,
        outcomes: [],
        errors: [{ stage: "provider", message: `Provider threw an error: ${String(error)}` }]
      };
    }

    if (!response || !Array.isArray(response.commands)) {
      return {
        success: false,
        instruction,
        outcomes: [],
        errors: [
          { stage: "provider", message: 'Provider returned a malformed response: expected "{ commands: [] }".' }
        ]
      };
    }

    const commands: unknown[] = response.commands;
    const notes = response.notes;

    if (commands.length === 0) {
      return {
        success: false,
        instruction,
        outcomes: [],
        errors: [
          {
            stage: "provider",
            message: notes ?? "Provider produced no recognizable commands for this instruction."
          }
        ],
        notes
      };
    }

    if (commands.length > MAX_COMMANDS_PER_RESPONSE) {
      return {
        success: false,
        instruction,
        outcomes: [],
        errors: [
          {
            stage: "provider",
            message: `Provider returned ${commands.length} commands; one response may contain at most ${MAX_COMMANDS_PER_RESPONSE}.`
          }
        ],
        notes
      };
    }

    // 1. Validate the whole response before anything runs.
    const shapeErrors = commands.map((rawCommand) => validateCommandShape(rawCommand, availableObjectTypes, projectContext));
    const firstInvalid = shapeErrors.findIndex((shapeError) => shapeError !== null);
    if (firstInvalid !== -1) {
      const errors: AIPipelineError[] = [];
      const outcomes: AICommandOutcome[] = commands.map((command, index) => {
        const shapeError = shapeErrors[index];
        if (shapeError) {
          errors.push({ stage: "validation", message: shapeError, commandIndex: index });
          return { command, result: { success: false, message: shapeError } };
        }
        return {
          command,
          result: { success: false, message: `Not executed: command ${firstInvalid + 1} of this response is invalid, so none of it was run.` }
        };
      });
      return { success: false, instruction, outcomes, errors, notes };
    }

    // 2. Execute the whole response as one all-or-nothing, undoable batch.
    const batch = executeCommandBatch(this.commandExecutor, commands, this.history);

    if (batch.success) {
      return {
        success: true,
        instruction,
        outcomes: commands.map((command, index) => ({ command, result: batch.results[index] })),
        errors: [],
        notes
      };
    }

    if (batch.failedIndex === undefined) {
      // The batch couldn't start (another edit was in progress) - nothing ran.
      return {
        success: false,
        instruction,
        outcomes: [],
        errors: [{ stage: "execution", message: batch.message ?? "The commands could not be executed." }],
        notes
      };
    }

    const failedIndex = batch.failedIndex;
    const failed = batch.results[failedIndex];
    const rolledBack = this.history !== undefined;
    const outcomes: AICommandOutcome[] = commands.map((command, index) => {
      if (index === failedIndex) {
        return { command, result: failed };
      }
      if (index < failedIndex) {
        return {
          command,
          result: rolledBack
            ? { success: false, message: `Rolled back: command ${failedIndex + 1} failed, so nothing from this response was kept.` }
            : batch.results[index]
        };
      }
      return { command, result: { success: false, message: `Not executed: command ${failedIndex + 1} failed.` } };
    });

    return {
      success: false,
      instruction,
      outcomes,
      errors: [{ stage: "execution", message: failed.message ?? "Command execution failed.", commandIndex: failedIndex }],
      notes
    };
  }

  /**
   * The whole-house design path (see the class doc comment and
   * houseIntent.ts/houseDesign.ts). Mirrors run()'s own shape - one
   * all-or-nothing history group, the same AIPipelineResult contract -
   * so a caller (AiPromptController, ai/verify.ts) can't tell which path
   * produced a given result except by its `errors[].stage`.
   */
  private runHouseDesign(
    instruction: string,
    houseIntent: Extract<ReturnType<typeof parseHouseIntent>, { kind: "unsupported" | "house" }>,
    projectContext: AIProjectContext,
    availableObjectTypes: readonly ObjectType[]
  ): AIPipelineResult {
    if (houseIntent.kind === "unsupported") {
      return { success: false, instruction, outcomes: [], errors: [{ stage: "design", message: houseIntent.reason }] };
    }

    const required: readonly ObjectType[] = ["slab", "wall", "pillar", "door", "window", "element"];
    const missing = required.filter((type) => !availableObjectTypes.includes(type));
    if (missing.length > 0) {
      return {
        success: false,
        instruction,
        outcomes: [],
        errors: [{ stage: "design", message: `A house needs ${missing.join(", ")}, which ${missing.length === 1 ? "isn't" : "aren't"} available in this context.` }]
      };
    }

    const occupied = projectContext.geometry.objects.map((object) => object.aabb);
    const planned = planHouseDesign(houseIntent.request, occupied);
    if (!planned.ok) {
      return { success: false, instruction, outcomes: [], errors: [{ stage: "design", message: planned.error }] };
    }

    if (this.history?.isGrouping()) {
      return {
        success: false,
        instruction,
        outcomes: [],
        errors: [{ stage: "execution", message: "Another edit (such as a drag) is still in progress, so nothing was changed. Try again once it finishes." }]
      };
    }

    this.history?.beginGroup();
    let built;
    try {
      built = buildHouseDesign(planned.layout, (command) => this.commandExecutor.execute(command));
    } catch (error) {
      this.history?.cancelGroup();
      return {
        success: false,
        instruction,
        outcomes: [],
        errors: [{ stage: "execution", message: `Command threw an error: ${error instanceof Error ? error.message : String(error)}` }]
      };
    }

    const outcomes: AICommandOutcome[] = built.outcomes.map(({ command, result }) => ({ command, result }));
    if (!built.success) {
      this.history?.cancelGroup();
      return { success: false, instruction, outcomes, errors: [{ stage: "execution", message: built.error }] };
    }

    this.history?.endGroup();
    return { success: true, instruction, outcomes, errors: [], notes: summarizeHouseDesign(built.summary), houseSummary: built.summary };
  }
}
