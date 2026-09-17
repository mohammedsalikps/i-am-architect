import type { AIPipelineResult } from "./types";
import type { HouseDesignSummary } from "./houseDesign.ts";

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
  /** What got MODIFIED, for the result card's "Design updated" variant - null when `summary` is present (a response that created anything shows the CREATE card, never both) or when nothing was successfully changed. */
  updateSummary: AiUpdateSummary | null;
  /** The original, unfiltered error text `message` was simplified from - null unless it actually differs (nothing to hide behind "Show details" otherwise). Developer/debugging detail only - never shown by default. */
  details: string | null;
  /** Present only for a successful whole-house/design-intent response (see AIPipelineResult.houseSummary) - lets the result card show a structured architectural summary (footprint, room breakdown, element count) instead of only the generic byType/notes text. Null for every other kind of response. */
  houseSummary: HouseDesignSummary | null;
}

export type AiPromptListener = (state: AiPromptState) => void;

/** What AiPromptController delegates the actual work to - `AIService.submit` in the running app, a fake async function in tests. */
export type AiInstructionSubmitter = (instruction: string) => Promise<AIPipelineResult>;

const IDLE_STATE: AiPromptState = {
  status: "idle",
  message: null,
  notes: null,
  summary: null,
  updateSummary: null,
  details: null,
  houseSummary: null
};

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

/** Distinguishes an authentication failure (actionable: sign in again) from a rate limit (wait and retry) from every other technical failure (generic outage). Matched against the FIRST "status NNN" substring in the raw message - the outermost one when a backend proxy has wrapped an upstream provider's own "status NNN" text (see BackendAIProvider.ts/GeminiProvider.ts), which is always the status that actually reached this app. */
const STATUS_CODE_PATTERN = /\bstatus (\d{3})\b/i;

/** A request that never got a response in time - a real client-side timeout (BackendAIProvider.ts's own AbortController) or a raw fetch AbortError, either way distinct from "the server answered with an error". */
const TIMEOUT_PATTERNS: readonly RegExp[] = [/\btimed out\b/i, /\bETIMEDOUT\b/, /\bAbortError\b/];

const SIGN_IN_AGAIN_MESSAGE = "Please sign in again to continue using EAVARA AI.";
const RATE_LIMITED_MESSAGE = "EAVARA AI is receiving a lot of requests right now. Please wait a moment and try again. Your design was not changed.";
const TIMED_OUT_MESSAGE = "The AI service is taking too long to respond. Please try again. Your design was not changed.";
/** Unchanged from before this milestone - pinned by ai/e2e/verify.ts's FRIENDLY_AI_FAILURE_MESSAGE across several existing failure-category tests, so this exact string is never changed casually. */
const UNAVAILABLE_MESSAGE = "AI service temporarily unavailable. Please try again.";
/**
 * The request never reached the server at all (no HTTP status of any
 * kind in the raw message) - a real client-side connectivity failure
 * (offline, DNS, TLS, or a blocked cross-origin request), distinct from
 * "the server answered with an error" (UNAVAILABLE_MESSAGE) or a timeout
 * waiting for a response that WAS in flight. This is the one failure
 * category where Demo Mode (deterministic-only, no backend) is offered -
 * see isNetworkUnreachable()/commandBar.ts's error card.
 */
const NETWORK_UNREACHABLE_MESSAGE = "Unable to connect to the AI server. You can retry, or continue in Demo Mode.";
/** Matches only a connectivity-level failure with no HTTP status attached - see NETWORK_UNREACHABLE_MESSAGE. */
const NETWORK_UNREACHABLE_PATTERNS: readonly RegExp[] = [/fetch failed/i, /failed to fetch/i, /network ?error/i, /\bECONNREFUSED\b/];

/**
 * True only for a genuine connectivity failure (never reached the
 * server) - never for an HTTP error status the server actually sent, a
 * timeout, or an already-friendly message. Used to decide whether the
 * error card offers "Continue in Demo Mode" (see commandBar.ts) - Demo
 * Mode is never offered for a request that DID reach the backend, since
 * that is not "the backend is unreachable", just an error it returned.
 */
export function isNetworkUnreachable(raw: string): boolean {
  return NETWORK_UNREACHABLE_PATTERNS.some((pattern) => pattern.test(raw)) && !STATUS_CODE_PATTERN.test(raw);
}

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
 *
 * Distinguishes WHICH kind of technical failure this was (task: "the UI
 * should clearly communicate the actual category of failure" - never a
 * generic "unavailable" for something the user can actually act on, like
 * signing in again, or a rate limit that will pass on its own): a timeout
 * or abort, an authentication failure (401), a rate limit (429), or every
 * other technical failure (a 4xx/5xx status, a network error, a malformed
 * response) - the last of these keeps the exact same message this project
 * has always shown for it. This app's backend always relays an upstream AI
 * provider failure as its own 502 with the real detail in the body (see
 * backend/src/createServer.ts), so the status this function looks for is
 * whatever is embedded in the message text, not the HTTP status a caller
 * might separately have available.
 */
export function friendlyAiErrorMessage(raw: string): string {
  if (TIMEOUT_PATTERNS.some((pattern) => pattern.test(raw))) {
    return TIMED_OUT_MESSAGE;
  }
  if (isNetworkUnreachable(raw)) {
    return NETWORK_UNREACHABLE_MESSAGE;
  }
  const statusMatch = STATUS_CODE_PATTERN.exec(raw);
  if (statusMatch) {
    const status = Number(statusMatch[1]);
    if (status === 401) {
      return SIGN_IN_AGAIN_MESSAGE;
    }
    if (status === 429) {
      return RATE_LIMITED_MESSAGE;
    }
    if (status >= 400 && status < 600) {
      return UNAVAILABLE_MESSAGE;
    }
  }
  if (TECHNICAL_FAILURE_PATTERNS.some((pattern) => pattern.test(raw))) {
    return UNAVAILABLE_MESSAGE;
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
  element: { singular: "item", plural: "items" },
  // Phase 7: "asset.add" (furniture/fixtures/lighting/decor - see
  // assets/catalog.ts) is now something the AI reliably creates on its
  // own (see ai/README.md "Object references"/"room-aware placement") -
  // it needs its own bucket here, or every AI-placed sofa/bed/table would
  // silently vanish from the result card's breakdown (summarizeCreatedObjects()
  // would still count it in `total`, but CREATED_TYPE_ORDER.filter() drops
  // any key not listed here, so `byType` - what the card actually renders
  // per line - would never mention it).
  asset: { singular: "furnishing", plural: "furnishings" }
};

/** Display order for the result card - rooms first (they read as the headline of a house), "item" (everything else) last. */
const CREATED_TYPE_ORDER = ["room", "wall", "pillar", "beam", "slab", "door", "window", "element", "asset"];

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

/** What a successful, create-free AI response modified - the "Design updated" counterpart to summarizeCreatedObjects()'s "Design generated". */
export interface AiUpdateSummary {
  total: number;
  objectIds: string[];
}

/**
 * Pure and exported for the same reason summarizeCreatedObjects() is.
 * The AI provider is instructed to only ever emit "<type>.add" or
 * "update_object" (see ai/providers/promptSchema.ts's own "Supported
 * commands" line), but CommandExecutor itself accepts any "<type>.update"
 * too (SUPPORTED_ACTIONS includes "update" generally) - so, like
 * summarizeCreatedObjects()'s generic ".add" check, this recognizes
 * either shape rather than hardcoding just "update_object". Deduplicates
 * by objectId: an instruction that edits the same object twice (e.g. two
 * separate property changes) still counts as one modified object, not
 * two.
 */
export function summarizeUpdatedObjects(outcomes: readonly { command: unknown; result: { success: boolean; objectId?: string } }[]): AiUpdateSummary | null {
  const objectIds: string[] = [];
  for (const outcome of outcomes) {
    if (!outcome.result.success || !outcome.result.objectId) {
      continue;
    }
    const type = commandTypeOf(outcome.command);
    if (type !== "update_object" && !type?.endsWith(".update")) {
      continue;
    }
    if (!objectIds.includes(outcome.result.objectId)) {
      objectIds.push(outcome.result.objectId);
    }
  }
  return objectIds.length === 0 ? null : { total: objectIds.length, objectIds };
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

    this.setState({ status: "submitting", message: null, notes: null, summary: null, updateSummary: null, details: null, houseSummary: null });

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
        updateSummary: null,
        details: friendly === raw ? null : raw,
        houseSummary: null
      });
      return;
    }

    const summary = result.success ? summarizeCreatedObjects(result.outcomes) : null;
    // A response that created anything shows the CREATE card - MODIFY is
    // only its own distinct card when nothing was created at all (task:
    // "distinguish between CREATE / MODIFY / ANALYZE").
    const updateSummary = result.success && !summary ? summarizeUpdatedObjects(result.outcomes) : null;
    const rawMessage = summarizeResult(result);
    const friendlyMessage = friendlyAiErrorMessage(rawMessage);
    this.setState({
      status: result.success ? "success" : "error",
      message: friendlyMessage,
      notes: result.notes ?? null,
      summary,
      updateSummary,
      details: friendlyMessage === rawMessage ? null : rawMessage,
      houseSummary: (result.success && result.houseSummary) || null
    });
    if (summary) {
      this.onCreated?.(summary.objectIds);
    } else if (updateSummary) {
      this.onCreated?.(updateSummary.objectIds);
    }
  }

  /**
   * Clears the last result (success or error) back to idle - what the
   * error card's "Dismiss" action uses (task section 15) so a failed
   * attempt doesn't linger once the user has read it. A no-op while a
   * submission is in flight: dismissing a result that hasn't arrived yet
   * makes no sense, and would otherwise race the submission's own
   * `setState` calls.
   */
  reset(): void {
    if (this.state.status === "submitting") {
      return;
    }
    this.setState(IDLE_STATE);
  }

  private setState(next: AiPromptState): void {
    this.state = next;
    for (const listener of this.listeners) {
      listener(next);
    }
  }
}
