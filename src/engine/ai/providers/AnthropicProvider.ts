import Anthropic from "@anthropic-ai/sdk";
import type { AIProvider } from "../AIProvider";
import type { AIProviderRequest, AIProviderResponse } from "../types";
// Explicit .ts extension on this value import lets Node run this file
// directly (providers/verify.ts, the backend). Harmless for Vite.
import { RESPONSE_JSON_SCHEMA, buildContextMessage, buildSystemPrompt } from "./promptSchema.ts";
import { ANTHROPIC_EFFORTS, ANTHROPIC_TIMEOUT_MS, DEFAULT_ANTHROPIC_EFFORT, DEFAULT_ANTHROPIC_MODEL } from "./anthropicSettings.ts";
import type { AnthropicEffort } from "./anthropicSettings.ts";

export { ANTHROPIC_EFFORTS, DEFAULT_ANTHROPIC_EFFORT, DEFAULT_ANTHROPIC_MODEL };
export type { AnthropicEffort };

/**
 * A real (network-backed) AIProvider for Anthropic's Claude, through the
 * official Anthropic TypeScript SDK and the Messages API. Like
 * OpenAIProvider and GeminiProvider it never reads an environment
 * variable or a global itself: the API key and the HTTP transport are
 * injected (the backend passes ANTHROPIC_API_KEY and Node's fetch - see
 * backend/src/server.ts), so no test ever reaches the real API, and the
 * key exists only server-side. See ai/README.md "Security boundary".
 *
 * WHY A TOOL, NOT `output_config.format`. The command schema in
 * promptSchema.ts has well over the 24 optional properties Claude's
 * structured outputs accept per request (and free-form maps it can't
 * express) - a JSON output format would be refused outright. So Claude
 * answers by calling one NON-strict tool, `submit_construction_commands`,
 * whose input schema IS that same command schema, unchanged. Nothing is
 * executed here: the tool call's input is just data, returned as
 * `{ commands, notes }` exactly like the other providers' JSON, and
 * AICommandPipeline + CommandExecutor still validate every command before
 * anything runs (an unsupported or malformed command rejects the whole
 * response). Claude Opus 5.5 rejects a forced `tool_choice`, so the tool
 * is offered with `auto` - which every model accepts - and the prompt asks
 * for it; an answer in plain text instead (a question, or why it can't
 * help) becomes `notes` with no commands - shown to the user, nothing
 * changed.
 *
 * Refusals: `stop_reason: "refusal"` is answered with no commands and a
 * plain note. Server-side fallbacks (`fallbacks: "default"`, which reruns a
 * declined request on another model inside the same call) are OFF by
 * default: the feature is in beta, and a beta the account can't use fails
 * every request with a 400. Opt in with `fallbacks: true`.
 *
 * Observability: `onMessage` receives one summary per answered request -
 * the model that served it, Anthropic's request id, stop reason, token
 * counts and duration. Never the instruction, the context or the answer.
 *
 * Time budget: the browser gives the whole AI request 30 s
 * (BackendAIProvider), so this provider has one overall deadline
 * (`timeoutMs`, default 25 s) across the SDK's own retries - a retry never
 * outlives the browser waiting for it.
 */

/** The SDK's own fetch type - the injected transport. */
export type AnthropicFetch = NonNullable<NonNullable<ConstructorParameters<typeof Anthropic>[0]>["fetch"]>;

export interface AnthropicProviderOptions {
  /**
   * The Anthropic API key. Never read from the environment here - the
   * backend reads ANTHROPIC_API_KEY (backend/src/config.ts) and passes it
   * in. Never construct this class in code that ships to a browser.
   */
  apiKey: string;
  /** Injected HTTP transport: Node's fetch in the backend, a mock in every test. Never defaulted to a global fetch. */
  fetch: AnthropicFetch;
  /** Defaults to Claude Sonnet 5.5 - see DEFAULT_ANTHROPIC_MODEL. */
  model?: string;
  /** How much effort Claude puts into each answer. Defaults to "medium" - see DEFAULT_ANTHROPIC_EFFORT. */
  effort?: AnthropicEffort;
  /** Output cap per request, thinking included. Defaults to 16000. */
  maxTokens?: number;
  /** One overall deadline for the request, retries included, in ms. Defaults to 25000 - under the browser's 30 s. */
  timeoutMs?: number;
  /** Retries the SDK may make for transient failures (429, 5xx, connection errors) within the deadline. Defaults to 2. */
  maxRetries?: number;
  /** Server-side refusal fallbacks (a beta feature). Defaults to false. */
  fallbacks?: boolean;
  /** Overrides the API base URL (a proxy or gateway). */
  baseUrl?: string;
  /** Called once per answered request with what served it - for the backend's log. Never receives user content. */
  onMessage?: (summary: AnthropicMessageSummary) => void;
}

/** One answered request, in metadata only - safe to log. */
export interface AnthropicMessageSummary {
  /** The model that produced the answer, as the API reports it. */
  model: string;
  /** Anthropic's request id ("req_..."), for matching a request in the Claude Console - null if the API sent none. */
  requestId: string | null;
  stopReason: string | null;
  inputTokens: number;
  outputTokens: number;
  /** How many tool calls the answer held (one is expected). */
  toolCalls: number;
  ms: number;
}

const DEFAULT_MAX_TOKENS = 16000;
const DEFAULT_MAX_RETRIES = 2;
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

export const SUBMIT_TOOL_NAME = "submit_construction_commands";

/** The one tool Claude answers through: its input schema is promptSchema.ts's command schema, unchanged (a plain JSON copy - the source is a readonly `as const` literal). */
export const SUBMIT_TOOL: Anthropic.Beta.BetaTool = {
  name: SUBMIT_TOOL_NAME,
  description:
    "Submit the construction commands that carry out the user's instruction - the application validates them, then executes them against its construction engine as one undoable step. Call it exactly once. Use an empty commands array, with the reason in notes, when nothing in the instruction maps to a command.",
  input_schema: JSON.parse(JSON.stringify(RESPONSE_JSON_SCHEMA.schema)) as Anthropic.Beta.BetaTool.InputSchema
};

/** Claude-specific: how to deliver "data matching the response schema" (the shared system prompt's wording). */
const TOOL_INSTRUCTION = `Deliver your response by calling the ${SUBMIT_TOOL_NAME} tool exactly once - its input is the response schema described above. If the instruction can't be carried out with the available commands, call it with an empty commands array and say why in notes.`;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** An API error's message, trimmed - Anthropic's error bodies never contain the request's key. */
function apiErrorDetail(error: InstanceType<typeof Anthropic.APIError>): string {
  const message = error.message;
  return message.length > 300 ? `${message.slice(0, 300)}…` : message;
}

export class AnthropicProvider implements AIProvider {
  // Plain field declarations + assignment in the constructor body,
  // deliberately NOT parameter-property shorthand - providers/verify.ts
  // instantiates this class under Node's type stripping, which can't run it.
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly effort: AnthropicEffort;
  private readonly maxTokens: number;
  private readonly timeoutMs: number;
  private readonly fallbacks: boolean;
  private readonly onMessage: ((summary: AnthropicMessageSummary) => void) | undefined;

  constructor(options: AnthropicProviderOptions) {
    if (!options || typeof options.apiKey !== "string" || options.apiKey.trim().length === 0) {
      throw new Error(
        'AnthropicProvider requires an API key. Pass it explicitly via the "apiKey" option - this class never reads ' +
          'ANTHROPIC_API_KEY (or any other environment variable) itself. See ai/README.md "Security boundary".'
      );
    }
    if (typeof options.fetch !== "function") {
      throw new Error(
        'AnthropicProvider requires an injected "fetch" transport (a real fetch in a trusted server context, or a ' +
          "mock in tests) - it never falls back to a global fetch."
      );
    }
    if (options.effort !== undefined && !ANTHROPIC_EFFORTS.includes(options.effort)) {
      throw new Error(`AnthropicProvider effort must be one of ${ANTHROPIC_EFFORTS.join(", ")}.`);
    }

    this.model = options.model?.trim() || DEFAULT_ANTHROPIC_MODEL;
    this.effort = options.effort ?? DEFAULT_ANTHROPIC_EFFORT;
    this.maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.timeoutMs = options.timeoutMs ?? ANTHROPIC_TIMEOUT_MS;
    this.fallbacks = options.fallbacks ?? false;
    this.onMessage = options.onMessage;
    this.client = new Anthropic({
      apiKey: options.apiKey,
      fetch: options.fetch,
      maxRetries: options.maxRetries ?? DEFAULT_MAX_RETRIES,
      timeout: this.timeoutMs,
      ...(options.baseUrl ? { baseURL: options.baseUrl } : {})
    });
  }

  async interpret(request: AIProviderRequest): Promise<AIProviderResponse> {
    // The construction state is user-authored data (assembly names,
    // labels): it goes in the user turn, never in the system prompt, and
    // the raw instruction is its own block after it - as OpenAIProvider
    // and GeminiProvider send them.
    const params: Anthropic.Beta.MessageCreateParamsNonStreaming = {
      model: this.model,
      max_tokens: this.maxTokens,
      system: [
        { type: "text", text: buildSystemPrompt(request) },
        { type: "text", text: TOOL_INSTRUCTION }
      ],
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: buildContextMessage(request) },
            { type: "text", text: request.instruction }
          ]
        }
      ],
      tools: [SUBMIT_TOOL],
      tool_choice: { type: "auto", disable_parallel_tool_use: true },
      output_config: { effort: this.effort },
      ...(this.fallbacks ? { betas: [FALLBACK_BETA], fallbacks: "default" as const } : {})
    };

    let message: Anthropic.Beta.BetaMessage & { _request_id?: string | null };
    const started = Date.now();
    try {
      // One overall deadline across the SDK's retries (see the class doc).
      message = await this.client.beta.messages.create(params, { signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (error) {
      if (error instanceof Anthropic.APIConnectionTimeoutError || error instanceof Anthropic.APIUserAbortError) {
        throw new Error(`Anthropic request timed out after ${this.timeoutMs}ms.`);
      }
      if (error instanceof Anthropic.APIError && typeof error.status === "number") {
        // A refusal by the API itself: bad key (401), rate limit (429), overloaded (529), bad request (400)...
        throw new Error(`Anthropic request failed with status ${error.status}: ${apiErrorDetail(error)}`);
      }
      // No response at all (network, DNS, TLS).
      throw new Error(`Anthropic request failed: ${describeError(error)}`);
    }

    this.onMessage?.({
      model: message.model,
      requestId: message._request_id ?? null,
      stopReason: message.stop_reason,
      inputTokens: message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
      toolCalls: message.content.filter((block) => block.type === "tool_use").length,
      ms: Date.now() - started
    });

    if (message.stop_reason === "refusal") {
      const category = message.stop_details?.category;
      return {
        commands: [],
        notes: `Claude declined this request${category ? ` (${category})` : ""}, so nothing was changed. Try describing it as a construction instruction.`
      };
    }
    if (message.stop_reason === "max_tokens" || message.stop_reason === "model_context_window_exceeded") {
      return {
        commands: [],
        notes: "Claude's answer was cut off before it finished, so nothing was applied. Try a smaller request, one part at a time."
      };
    }

    const calls = message.content.filter((block): block is Anthropic.Beta.BetaToolUseBlock => block.type === "tool_use");
    const text = message.content
      .filter((block): block is Anthropic.Beta.BetaTextBlock => block.type === "text")
      .map((block) => block.text)
      .join("")
      .trim();

    if (calls.length === 0) {
      if (text.length > 0) {
        // Claude answered in words (a question, or why it can't help) - shown as the result, nothing executed.
        return { commands: [], notes: text };
      }
      throw new Error("Anthropic response was malformed: no tool call and no text.");
    }

    const commands: unknown[] = [];
    const notes: string[] = [];
    let house: unknown;
    for (const call of calls) {
      if (call.name !== SUBMIT_TOOL_NAME) {
        throw new Error(`Anthropic response was malformed: unexpected tool "${call.name}".`);
      }
      const input = call.input;
      if (!isPlainObject(input) || !Array.isArray(input.commands)) {
        throw new Error('Anthropic response was malformed: expected the tool input to be "{ commands: [] }".');
      }
      // Handed on as unknown[] - AICommandPipeline validates every command (shape, type, action), then CommandExecutor (domain rules).
      commands.push(...input.commands);
      if (typeof input.notes === "string" && input.notes.trim().length > 0) {
        notes.push(input.notes.trim());
      }
      if (input.house !== undefined) {
        if (house !== undefined) {
          throw new Error("Anthropic response was malformed: more than one house plan.");
        }
        // A whole-house plan, likewise unvalidated here - AICommandPipeline validates it and the house builder builds it.
        house = input.house;
      }
    }
    return {
      commands,
      notes: notes.length > 0 ? notes.join(" ") : text.length > 0 ? text : undefined,
      ...(house !== undefined ? { house } : {})
    };
  }
}
