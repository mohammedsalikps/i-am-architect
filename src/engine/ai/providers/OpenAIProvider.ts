import type { AIProvider } from "../AIProvider";
import type { AIProviderRequest, AIProviderResponse } from "../types";
import { RESPONSE_JSON_SCHEMA, buildContextMessage, buildSystemPrompt } from "./promptSchema.ts";

/**
 * The first real (network-backed) AIProvider implementation - talks to
 * OpenAI's Chat Completions API. See ai/README.md's "Security boundary"
 * section before wiring this up anywhere: this class deliberately never
 * reads `OPENAI_API_KEY` (or any other environment variable) itself,
 * and nothing in this application currently constructs it with a real
 * API key or a real network transport - see that section for why, and
 * for what a safe deployment of this class actually requires.
 *
 * Like every other AIProvider, this class never touches Three.js, any
 * *Store, or the DOM - it only ever sees the read-only
 * AIProjectSnapshot/availableObjectTypes handed to it in
 * AIProviderRequest, and only ever returns structured, plain data.
 * AICommandPipeline (not this class) is what turns that into real
 * mutations, exclusively through CommandExecutor.
 *
 * The command schema, system prompt, and construction/geometry context
 * projection this class sends are defined once, provider-neutrally, in
 * `promptSchema.ts` - shared with `GeminiProvider.ts` so both real
 * providers ask a model for exactly the same thing. This file's own
 * responsibility is only OpenAI's wire format: `messages`, a chat
 * completion's `response_format`, and parsing
 * `choices[0].message.content` back into `{ commands, notes }`.
 */

/**
 * Minimal structural subset of the standard `fetch` signature this
 * provider needs - deliberately not the full DOM `Response` type, so
 * this file has no dependency on the "DOM" lib and can be typed and
 * tested identically whether the real transport ends up being a
 * server-side `fetch`, a different HTTP client wrapped to match this
 * shape, or (in every test in this repo) a mock. A real `fetch`'s
 * `Response` already satisfies this structurally, so no adapter is
 * needed wherever a real transport is eventually supplied.
 */
export interface OpenAIHttpResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

/** The injected HTTP transport - see OpenAIProviderOptions.fetch. */
export type OpenAIFetch = (
  url: string,
  init: { method: "POST"; headers: Record<string, string>; body: string }
) => Promise<OpenAIHttpResponse>;

export interface OpenAIProviderOptions {
  /**
   * The OpenAI API key. This class NEVER reads `process.env`,
   * `import.meta.env`, or any other environment/global source itself -
   * see ai/README.md "Security boundary". Callers are responsible for
   * sourcing this value from the `OPENAI_API_KEY` environment variable
   * in a trusted, server-side context only, and must never construct
   * this class with a real key inside code that ships to a browser.
   */
  apiKey: string;
  /**
   * Injected HTTP transport - real (trusted, server-side) usage passes
   * a real `fetch`; every test in this repo passes a mock instead, so
   * no test ever makes a real network call. Deliberately not defaulted
   * to a global `fetch`, so this class can never silently reach for a
   * real network call on its own.
   */
  fetch: OpenAIFetch;
  /** Defaults to a small, inexpensive chat model - override for a different one. */
  model?: string;
  /** Defaults to OpenAI's public Chat Completions endpoint - override to point at a proxy/gateway instead. */
  baseUrl?: string;
}

const DEFAULT_MODEL = "gpt-4o-mini";
const DEFAULT_BASE_URL = "https://api.openai.com/v1/chat/completions";

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function safeText(response: OpenAIHttpResponse): Promise<string> {
  try {
    const text = await response.text();
    // Truncated defensively - an error body is for a human/log to read, not to grow unbounded.
    return text.length > 500 ? `${text.slice(0, 500)}…` : text;
  } catch {
    return "<no response body>";
  }
}

/** Pulls `choices[0].message.content` out of an OpenAI Chat Completions payload, or null if the shape doesn't match. */
function extractMessageContent(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    return null;
  }
  const message = (choices[0] as { message?: unknown }).message;
  if (typeof message !== "object" || message === null) {
    return null;
  }
  const content = (message as { content?: unknown }).content;
  return typeof content === "string" ? content : null;
}

export class OpenAIProvider implements AIProvider {
  // Plain field declarations + assignment in the constructor body,
  // deliberately NOT TypeScript parameter-property shorthand - same
  // reasoning as AICommandPipeline.ts: this class is instantiated
  // directly by ai/providers/verify.ts, and Node's native TypeScript
  // support cannot run parameter properties.
  private readonly apiKey: string;
  private readonly fetchImpl: OpenAIFetch;
  private readonly model: string;
  private readonly baseUrl: string;

  constructor(options: OpenAIProviderOptions) {
    if (!options || typeof options.apiKey !== "string" || options.apiKey.trim().length === 0) {
      throw new Error(
        'OpenAIProvider requires an API key. Pass it explicitly via the "apiKey" option - this class never reads ' +
          'OPENAI_API_KEY (or any other environment variable) itself. See ai/README.md "Security boundary".'
      );
    }
    if (typeof options.fetch !== "function") {
      throw new Error(
        'OpenAIProvider requires an injected "fetch" transport (a real fetch in a trusted server context, or a ' +
          "mock in tests) - it never falls back to a global fetch."
      );
    }

    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetch;
    this.model = options.model ?? DEFAULT_MODEL;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  }

  async interpret(request: AIProviderRequest): Promise<AIProviderResponse> {
    const body = JSON.stringify({
      model: this.model,
      messages: [
        { role: "system", content: buildSystemPrompt(request) },
        { role: "user", content: buildContextMessage(request) },
        { role: "user", content: request.instruction }
      ],
      response_format: { type: "json_schema", json_schema: RESPONSE_JSON_SCHEMA },
      temperature: 0
    });

    let httpResponse: OpenAIHttpResponse;
    try {
      httpResponse = await this.fetchImpl(this.baseUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`
        },
        body
      });
    } catch (error) {
      // Error 1 of 4 required by requirement 10: the request itself failed (network error, transport threw, etc.).
      throw new Error(`OpenAI request failed: ${describeError(error)}`);
    }

    if (!httpResponse.ok) {
      // Error 2 of 4: the request reached OpenAI but it rejected it (bad key, rate limit, bad request, ...).
      const errorBody = await safeText(httpResponse);
      throw new Error(`OpenAI request failed with status ${httpResponse.status}: ${errorBody}`);
    }

    let payload: unknown;
    try {
      payload = await httpResponse.json();
    } catch (error) {
      // Error 3 of 4 (part a): the HTTP body itself wasn't valid JSON.
      throw new Error(`OpenAI response was not valid JSON: ${describeError(error)}`);
    }

    const content = extractMessageContent(payload);
    if (content === null) {
      // Error 3 of 4 (part b): valid JSON, but not shaped like a Chat Completions response.
      throw new Error("OpenAI response was malformed: expected choices[0].message.content to be a string.");
    }

    let parsedContent: unknown;
    try {
      parsedContent = JSON.parse(content);
    } catch (error) {
      // Error 3 of 4 (part c): the model's own message content wasn't valid JSON.
      throw new Error(`OpenAI response content was not valid JSON: ${describeError(error)}`);
    }

    if (
      typeof parsedContent !== "object" ||
      parsedContent === null ||
      !Array.isArray((parsedContent as { commands?: unknown }).commands)
    ) {
      // Error 3 of 4 (part d): valid JSON, but missing the "commands" array RESPONSE_JSON_SCHEMA requires.
      throw new Error('OpenAI response content was malformed: expected "{ commands: [] }".');
    }

    const { commands, notes } = parsedContent as { commands: unknown[]; notes?: unknown };

    // Error 4 of 4 ("the model returns unsupported commands") is deliberately NOT
    // checked here - `commands` is handed back exactly as `unknown[]`, same as
    // every other provider, and AICommandPipeline's own structural + domain
    // validation (which already has dedicated, tested error messages for
    // malformed shape / unsupported object type / unsupported command type)
    // is what rejects it. Duplicating that logic in this file would risk the
    // two disagreeing - see ai/README.md "Two validation layers, not one".
    return {
      commands,
      notes: typeof notes === "string" ? notes : undefined
    };
  }
}
