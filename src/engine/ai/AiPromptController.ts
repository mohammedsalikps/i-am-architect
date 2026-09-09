import type { AIPipelineResult } from "./types";

/**
 * DOM-free UI state machine for the command bar's "AI Prompt" tab.
 * Owns exactly two things: the idle/submitting/success/error state
 * transitions, and the "prevent duplicate submissions while a request
 * is running" guard. Everything about *how* an instruction is actually
 * turned into commands is delegated entirely to an injected
 * `submitInstruction` function (in the running app, `AIService.submit`
 * - see AIService.ts) - this class has no reference to AICommandPipeline,
 * CommandExecutor, or any *Store, and cannot reach any of them. That's
 * what makes it fully unit-testable under Node with a plain fake async
 * function, and what guarantees the command bar itself never mutates
 * anything directly (see commandBar.ts, which only ever calls
 * `controller.submit()` - never a store, never CommandExecutor).
 *
 * Mirrors the `subscribe(listener)` convention already used throughout
 * this codebase (SelectionStore, HistoryManager, every *Store) so
 * commandBar.ts can render itself the same way every other UI piece
 * already does.
 */

export type AiPromptStatus = "idle" | "submitting" | "success" | "error";

export interface AiPromptState {
  status: AiPromptStatus;
  /** Human-readable summary of the last attempt's outcome - null while idle or submitting. */
  message: string | null;
  /** The provider's free-text notes from the last attempt (see AIPipelineResult.notes), if any - null when none were returned. */
  notes: string | null;
}

export type AiPromptListener = (state: AiPromptState) => void;

/** What AiPromptController delegates the actual work to - `AIService.submit` in the running app, a fake async function in tests. */
export type AiInstructionSubmitter = (instruction: string) => Promise<AIPipelineResult>;

const IDLE_STATE: AiPromptState = { status: "idle", message: null, notes: null };

function pluralize(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * Turns one AIPipelineResult into a single human-readable line for the
 * command bar - deliberately simple (this is "focused"/MVP display, not
 * a full per-command report). Every branch is driven only by fields
 * AIPipelineResult already exposes - no new business rules invented
 * here, no guessing at what AICommandPipeline "really meant".
 */
function summarizeResult(result: AIPipelineResult): string {
  const total = result.outcomes.length;

  if (result.success) {
    return `${pluralize(total, "command")} executed.`;
  }

  const firstErrorMessage = result.errors[0]?.message ?? "Unknown error.";
  if (total === 0) {
    // Nothing was ever attempted - an input-stage or provider-stage failure (e.g. empty instruction, provider unreachable).
    return firstErrorMessage;
  }

  const succeeded = result.outcomes.filter((outcome) => outcome.result.success).length;
  if (succeeded > 0) {
    return `${pluralize(succeeded, "command")} of ${total} succeeded. ${firstErrorMessage}`;
  }
  return firstErrorMessage;
}

export class AiPromptController {
  private state: AiPromptState = IDLE_STATE;
  private readonly listeners = new Set<AiPromptListener>();
  private readonly submitInstruction: AiInstructionSubmitter;

  constructor(submitInstruction: AiInstructionSubmitter) {
    this.submitInstruction = submitInstruction;
  }

  getState(): AiPromptState {
    return this.state;
  }

  /** Returns an unsubscribe function. Calls the listener once immediately with the current state - same convention as SelectionStore/HistoryManager. */
  subscribe(listener: AiPromptListener): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  /**
   * Submits `instruction`. No-ops - returns without ever calling the
   * injected `submitInstruction` - while a previous call is still in
   * flight; this is the entire "prevent duplicate submissions" guard,
   * and it lives here (not in commandBar.ts) so it's covered by
   * ai/verify.ts under Node, not left to browser-only testing.
   *
   * Deliberately does NOT pre-validate `instruction` itself (e.g. reject
   * an empty one before calling out) - AICommandPipeline.run() already
   * owns that exact rule (see ai/README.md) and produces a clean
   * `{success:false, errors:[{stage:"input", ...}]}` result for it;
   * duplicating that check here would risk the two disagreeing.
   */
  async submit(instruction: string): Promise<void> {
    if (this.state.status === "submitting") {
      return;
    }

    this.setState({ status: "submitting", message: null, notes: null });

    let result: AIPipelineResult;
    try {
      result = await this.submitInstruction(instruction);
    } catch (error) {
      this.setState({
        status: "error",
        message: error instanceof Error ? error.message : String(error),
        notes: null
      });
      return;
    }

    this.setState({
      status: result.success ? "success" : "error",
      message: summarizeResult(result),
      notes: result.notes ?? null
    });
  }

  private setState(next: AiPromptState): void {
    this.state = next;
    for (const listener of this.listeners) {
      listener(next);
    }
  }
}
