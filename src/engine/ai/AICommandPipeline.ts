import type { AIProvider } from "./AIProvider";
// Explicit .ts extension on this value import (unlike the type-only
// imports elsewhere in this file) is required so Node can run this
// file directly, e.g. from src/engine/ai/verify.ts - see
// allowImportingTsExtensions in tsconfig.json. Harmless for Vite too.
import { AI_SUPPORTED_OBJECT_TYPES } from "./types.ts";
import type { AICommandOutcome, AIPipelineError, AIPipelineResult, AIProjectSnapshot } from "./types";
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

const SUPPORTED_ACTIONS: readonly string[] = ["add", "update", "delete", "duplicate"];

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
function validateCommandShape(raw: unknown, availableObjectTypes: readonly ObjectType[]): string | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return "Malformed command: expected a plain object.";
  }

  const type = (raw as { type?: unknown }).type;
  if (typeof type !== "string" || type.length === 0) {
    return 'Malformed command: missing or invalid "type" field.';
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
 *  2. Call the provider, then structurally validate every command it
 *     returned (malformed shape, unsupported object type, unsupported
 *     command type) before anything is executed.
 *  3. Execute each structurally-valid command through CommandExecutor
 *     (which applies its own domain validation - e.g. invalid
 *     dimensions - exactly the same way it does for UI-issued
 *     commands), one at a time, in order.
 *
 * A command that fails validation - structural or domain - never stops
 * the other commands in the same response: every command in
 * `response.commands` is always attempted (multiple commands in one
 * response is a supported case, not just a single-command happy path),
 * and the aggregate `success` is true only if every one of them
 * succeeded. This mirrors how a partially-valid multi-step user action
 * should behave: report exactly what worked and what didn't, per command.
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

  constructor(provider: AIProvider, commandExecutor: CommandExecutorLike) {
    this.provider = provider;
    this.commandExecutor = commandExecutor;
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
    projectContext: AIProjectSnapshot,
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

    if (response.commands.length === 0) {
      return {
        success: false,
        instruction,
        outcomes: [],
        errors: [
          {
            stage: "provider",
            message: response.notes ?? "Provider produced no recognizable commands for this instruction."
          }
        ],
        notes: response.notes
      };
    }

    const outcomes: AICommandOutcome[] = [];
    const errors: AIPipelineError[] = [];

    response.commands.forEach((rawCommand, index) => {
      const shapeError = validateCommandShape(rawCommand, availableObjectTypes);
      if (shapeError) {
        errors.push({ stage: "validation", message: shapeError, commandIndex: index });
        outcomes.push({ command: rawCommand, result: { success: false, message: shapeError } });
        return;
      }

      const result = this.commandExecutor.execute(rawCommand);
      outcomes.push({ command: rawCommand, result });
      if (!result.success) {
        errors.push({
          stage: "execution",
          message: result.message ?? "Command execution failed.",
          commandIndex: index
        });
      }
    });

    return { success: errors.length === 0, instruction, outcomes, errors, notes: response.notes };
  }
}
