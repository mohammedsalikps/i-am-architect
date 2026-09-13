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

/** One object-type bucket in an AiBuildSummary, ready to render ("8 walls"). */
export interface AiBuildSummaryEntry {
  label: string;
  count: number;
}

/**
 * What a successful AI response actually built, for the command bar's
 * "AI Build Complete" result card (task: don't just say "Success.") -
 * derived entirely from AIPipelineResult.outcomes, never a second
 * business rule about what AICommandPipeline "really did". Only counts
 * outcomes whose command was a real `*.add` that returned an objectId -
 * an `update_object`/`*.update` edit (e.g. "make the living room bigger")
 * intentionally does not appear here, since nothing new was CREATED.
 */
export interface AiBuildSummary {
  total: number;
  byType: AiBuildSummaryEntry[];
  /** Every created object's id, in outcome order - what "Focus Building"/"Review Changes" act on. */
  objectIds: string[];
}

export interface AiPromptState {
  status: AiPromptStatus;
  /** Human-readable summary of the last attempt's outcome - null while idle or submitting. Always safe to show a normal user: never a raw exception, HTTP status, or stack trace - see friendlyAiErrorMessage(). */
  message: string | null;
  /** The provider's free-text notes from the last attempt (see AIPipelineResult.notes), if any - null when none were returned. */
  notes: string | null;
  /** What got created, for the result card - null when nothing was (an edit-only instruction, or a failed attempt). */
  summary: AiBuildSummary | null;
  /** The original, unfiltered error text `message` was simplified from - null unless it actually differs (nothing to hide behind "Show details" otherwise). Developer/debugging detail only - never shown by default. */
  details: string | null;
}

export type AiPromptListener = (state: AiPromptState) => void;

/** What AiPromptController delegates the actual work to - `AIService.submit` in the running app, a fake async function in tests. */
export type AiInstructionSubmitter = (instruction: string) => Promise<AIPipelineResult>;

const IDLE_STATE: AiPromptState = { status: "idle", message: null, notes: null, summary: null, details: null };

/**
 * Raw text substrings that mark a message as an internal/technical
 * failure a normal user should never see verbatim - a network error, an
 * HTTP status code, a JSON parsing failure, or a provider's own wrapped
 * exception string (see BackendAIProvider.ts/GeminiProvider.ts, which
 * both throw `Error` objects whose `.message` includes exactly this kind
 * of detail). Matched case-insensitively against the raw message.
 */
const TECHNICAL_FAILURE_PATTERNS: readonly RegExp[] = [
  /fetch failed/i,
  /failed to fetch/i,
  /network ?error/i,
  /\bECONNREFUSED\b/,
  /\bETIMEDOUT\b/,
  /\bAbortError\b/,
  /backend request failed/i,
  /gemini request failed/i,
  /provider threw an error/i,
  /\bJSON\b.*(parse|malformed)/i,
  /status (4|5)\d\d/i,
  /\b5\d\d\b/
];

/**
 * Turns one AICommandPipeline/provider error message into something a
 * normal user should see (task: never "fetch failed"/"500"/a raw JSON
 * parse error - a short, actionable line instead; the technical detail
 * stays available as `AiPromptState.details` for a "Show details"
 * disclosure, never lost, just not the headline). A message that is
 * already one of the pipeline's own clean validation errors (e.g.
 * `Unsupported object type: "x".`) or the backend's own already-friendly
 * refusal (e.g. `Sign in to use the AI assistant.`) matches none of
 * these patterns and passes through unchanged.
 */
export function friendlyAiErrorMessage(raw: string): string {
  if (TECHNICAL_FAILURE_PATTERNS.some((pattern) => pattern.test(raw))) {
    return "AI service temporarily unavailable. Please try again.";
  }
  return raw;
}

const CREATED_TYPE_LABELS: Readonly<Record<string, { singular: string; plural: string }>> = {
  room: { singular: "room", plural: "rooms" },
  wall: { singular: "wall", plural: "walls" },
  pillar: { singular: "pillar", plural: "pillars" },
  beam: { singular: "beam", plural: "beams" },
  slab: { singular: "slab", plural: "slabs" },
  door: { singular: "door", plural: "doors" },
  window: { singular: "window", plural: "windows" },
  element: { singular: "item", plural: "items" }
};

/** Display order for the result card - rooms first (they read as the headline of a house), "item" (everything else) last. */
const CREATED_TYPE_ORDER = ["room", "wall", "pillar", "beam", "slab", "door", "window", "element"];

function commandTypeOf(command: unknown): string | null {
  if (typeof command === "object" && command !== null && "type" in command) {
    const type = (command as { type: unknown }).type;
    return typeof type === "string" ? type : null;
  }
  return null;
}

/** A generic `element.add` whose element.kind is "room" - the catalog has no separate "room.add" command (see engine/elements/catalog.ts). */
function isRoomAddCommand(command: unknown): boolean {
  if (typeof command !== "object" || command === null) {
    return false;
  }
  const element = (command as { element?: unknown }).element;
  return typeof element === "object" && element !== null && (element as { kind?: unknown }).kind === "room";
}

/** Pure and exported so it's covered by ai/verify.ts under Node, not left to browser-only testing - mirrors the rest of this file's own testability goal. */
export function summarizeCreatedObjects(
  outcomes: readonly { command: unknown; result: { success: boolean; objectId?: string } }[]
): AiBuildSummary | null {
  const counts = new Map<string, number>();
  const objectIds: string[] = [];

  for (const outcome of outcomes) {
    if (!outcome.result.success || !outcome.result.objectId) {
      continue;
    }
    const type = commandTypeOf(outcome.command);
    if (!type || !type.endsWith(".add")) {
      continue;
    }
    const objectType = type.slice(0, -".add".length);
    const bucket = objectType === "element" && isRoomAddCommand(outcome.command) ? "room" : objectType;
    counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
    objectIds.push(outcome.result.objectId);
  }

  if (objectIds.length === 0) {
    return null;
  }

  const byType: AiBuildSummaryEntry[] = CREATED_TYPE_ORDER.filter((key) => counts.has(key)).map((key) => {
    const count = counts.get(key) ?? 0;
    const labels = CREATED_TYPE_LABELS[key] ?? { singular: key, plural: `${key}s` };
    return { label: count === 1 ? labels.singular : labels.plural, count };
  });

  return { total: objectIds.length, byType, objectIds };
}

/**
 * Decides whether one keydown in the AI Prompt input should submit.
 * DOM-free (it takes only the two fields it reads) so the rule is
 * covered by ai/verify.ts under Node rather than left to browser-only
 * testing.
 *
 * - Only `key === "Enter"` counts. That is what every physical Enter
 *   key - main or numpad - reports. A keydown carrying no key identity
 *   at all (`key: ""`, which some synthetic-event tools emit for a
 *   "Return" press) is not an Enter, and is ignored.
 * - An Enter that confirms an IME composition (Japanese, Chinese, or
 *   Korean input) arrives with `isComposing: true`. It finishes the
 *   composed text, so it must not also submit that text half-typed.
 */
export function isAiPromptSubmitKey(event: { key: string; isComposing?: boolean }): boolean {
  return event.key === "Enter" && event.isComposing !== true;
}

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

  const firstError = result.errors[0];
  const firstErrorMessage = firstError?.message ?? "Unknown error.";
  if (total === 0) {
    // Nothing was ever attempted - an input-stage or provider-stage failure (e.g. empty instruction, provider unreachable).
    return firstErrorMessage;
  }

  const succeeded = result.outcomes.filter((outcome) => outcome.result.success).length;
  if (succeeded > 0) {
    // Only a pipeline without a history can leave part of a response applied - the running app always passes one.
    return `${pluralize(succeeded, "command")} of ${total} succeeded. ${firstErrorMessage}`;
  }
  if (total === 1) {
    return firstErrorMessage;
  }
  // A multi-command response is all-or-nothing: no outcome succeeded, so nothing it asked for was applied.
  const where = firstError?.commandIndex === undefined ? "" : `Command ${firstError.commandIndex + 1} of ${total} failed: `;
  return `${where}${firstErrorMessage} Nothing was changed.`;
}

export class AiPromptController {
  private state: AiPromptState = IDLE_STATE;
  private readonly listeners = new Set<AiPromptListener>();
  private readonly submitInstruction: AiInstructionSubmitter;
  private readonly onCreated?: (objectIds: string[]) => void;

  /**
   * `onCreated`, when given, is called once after a successful response
   * that created at least one object - the running app wires this to
   * SceneManager.focusOn() (via ui/commandBar.ts/ui/layout.ts) so the
   * viewport shows the result immediately (task: "VIEWPORT: displays the
   * building"), without this class knowing anything about cameras or
   * Three.js itself - same "report a decision, let the caller act on it"
   * shape as submitInstruction.
   */
  constructor(submitInstruction: AiInstructionSubmitter, onCreated?: (objectIds: string[]) => void) {
    this.submitInstruction = submitInstruction;
    this.onCreated = onCreated;
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

    this.setState({ status: "submitting", message: null, notes: null, summary: null, details: null });

    let result: AIPipelineResult;
    try {
      result = await this.submitInstruction(instruction);
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      const friendly = friendlyAiErrorMessage(raw);
      this.setState({
        status: "error",
        message: friendly,
        notes: null,
        summary: null,
        details: friendly === raw ? null : raw
      });
      return;
    }

    const summary = result.success ? summarizeCreatedObjects(result.outcomes) : null;
    const rawMessage = summarizeResult(result);
    const friendlyMessage = friendlyAiErrorMessage(rawMessage);
    this.setState({
      status: result.success ? "success" : "error",
      message: friendlyMessage,
      notes: result.notes ?? null,
      summary,
      details: friendlyMessage === rawMessage ? null : rawMessage
    });
    if (summary) {
      this.onCreated?.(summary.objectIds);
    }
  }

  private setState(next: AiPromptState): void {
    this.state = next;
    for (const listener of this.listeners) {
      listener(next);
    }
  }
}
