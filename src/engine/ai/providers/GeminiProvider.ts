import type { AIProvider } from "../AIProvider";
import type { AIProviderRequest, AIProviderResponse } from "../types";
import { RESPONSE_JSON_SCHEMA, buildContextMessage, buildSystemPrompt } from "./promptSchema.ts";

/**
 * A second real (network-backed) AIProvider implementation - talks to
 * Google's Gemini API (`generateContent`) directly over HTTP, the same
 * way OpenAIProvider.ts talks to OpenAI's Chat Completions API: no
 * `@google/genai` (or any other) SDK dependency - this project's backend
 * has zero runtime npm dependencies today (see Dockerfile), and this
 * class keeps that true. Like OpenAIProvider, it never reads
 * `process.env` or any other environment/global itself - the API key and
 * the HTTP transport (`fetch`) are both passed in explicitly via its
 * constructor. See ai/README.md "Security boundary", which applies to
 * this class exactly as it does to OpenAIProvider.
 *
 * Like every other AIProvider, this class never touches Three.js, any
 * *Store, or the DOM - it only ever sees the read-only
 * AIProjectSnapshot/availableObjectTypes handed to it in
 * AIProviderRequest, and only ever returns structured, plain data.
 * AICommandPipeline (not this class) is what turns that into real
 * mutations, exclusively through CommandExecutor.
 *
 * The command schema, system prompt, and construction/geometry context
 * this class sends are the exact same ones OpenAIProvider sends - both
 * import them from `promptSchema.ts` rather than each defining its own,
 * so a model always sees equivalent information regardless of which
 * provider is configured (see backend/src/config.ts's AI_PROVIDER). This
 * file's own responsibility is only Gemini's wire format:
 * `systemInstruction`/`contents`, `generationConfig.responseSchema`, and
 * parsing `candidates[0].content.parts[].text` back into
 * `{ commands, notes }` - Gemini-specific response objects never leak
 * past `interpret()`.
 */

/**
 * Minimal structural subset of the standard `fetch` signature this
 * provider needs - mirrors OpenAIProvider.ts's `OpenAIFetch`/
 * `OpenAIHttpResponse` (see that file for the full reasoning).
 * Deliberately a separate, independent type rather than a shared/
 * imported one - this class has no coupling to OpenAIProvider.ts beyond
 * the provider-neutral `promptSchema.ts`, consistent with "provider
 * independence" (see ai/README.md).
 */
export interface GeminiHttpResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

/** The injected HTTP transport - see GeminiProviderOptions.fetch. */
export type GeminiFetch = (
  url: string,
  init: { method: "POST"; headers: Record<string, string>; body: string }
) => Promise<GeminiHttpResponse>;

export interface GeminiProviderOptions {
  /**
   * The Gemini API key (from https://aistudio.google.com/apikey). This
   * class NEVER reads `process.env`, `import.meta.env`, or any other
   * environment/global source itself - see ai/README.md "Security
   * boundary". Callers are responsible for sourcing this value from the
   * `GEMINI_API_KEY` environment variable in a trusted, server-side
   * context only, and must never construct this class with a real key
   * inside code that ships to a browser.
   */
  apiKey: string;
  /**
   * Injected HTTP transport - real (trusted, server-side) usage passes
   * a real `fetch`; every test in this repo passes a mock instead, so
   * no test ever makes a real network call. Deliberately not defaulted
   * to a global `fetch`, so this class can never silently reach for a
   * real network call on its own.
   */
  fetch: GeminiFetch;
  /** Defaults to a small, inexpensive current Gemini model - override for a different one. */
  model?: string;
  /** Defaults to Gemini's public generateContent endpoint base - override to point at a proxy/gateway instead. */
  baseUrl?: string;
}

const DEFAULT_MODEL = "gemini-3.6-flash";
const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models";

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function safeText(response: GeminiHttpResponse): Promise<string> {
  try {
    const text = await response.text();
    // Truncated defensively - an error body is for a human/log to read, not to grow unbounded.
    return text.length > 500 ? `${text.slice(0, 500)}…` : text;
  } catch {
    return "<no response body>";
  }
}

/**
 * A provider-neutral JSON Schema node, as produced by promptSchema.ts's
 * RESPONSE_JSON_SCHEMA - the small subset this file actually reads.
 */
interface JsonSchemaNode {
  type?: string | readonly string[];
  description?: string;
  properties?: Record<string, JsonSchemaNode>;
  items?: JsonSchemaNode;
  enum?: readonly string[];
  required?: readonly string[];
  additionalProperties?: JsonSchemaNode | boolean;
}

const GEMINI_TYPES: Record<string, string> = {
  object: "OBJECT",
  array: "ARRAY",
  string: "STRING",
  number: "NUMBER",
  integer: "INTEGER",
  boolean: "BOOLEAN"
};

/**
 * Adapts promptSchema.ts's provider-neutral JSON Schema into Gemini's
 * `responseSchema` (an OpenAPI-3.0 subset - uppercase type names, and no
 * `additionalProperties`/union `type`). Two fields in RESPONSE_JSON_SCHEMA
 * are open-ended dictionaries with a fixed value type -
 * `element.dimensions`/`changes.dimensions` (`additionalProperties: {
 * type: "number" }`) and `element.params` (`additionalProperties: {
 * type: ["number", "string"] }`) - Gemini's schema has no equivalent for
 * "any key, this value type", and no equivalent for a value that may be
 * one of several types. For exactly those two shapes this function falls
 * back to an unconstrained OBJECT (or STRING, for a `type` union) rather
 * than a stricter equivalent that doesn't exist: this only loosens what
 * Gemini itself is asked to shape its own output as. It does not loosen
 * what the application accepts - AICommandPipeline's structural
 * validation and each store's own domain validation (CommandExecutor)
 * are the actual, unchanged source of truth for every command Gemini (or
 * any other provider) returns; see ai/README.md "Two validation layers,
 * not one". The system prompt (shared, unchanged) still tells the model
 * in prose what belongs in "dimensions"/"params" either way.
 */
function toGeminiSchema(node: JsonSchemaNode): Record<string, unknown> {
  const type = node.type;
  // typeof, not Array.isArray: TS doesn't reliably narrow a readonly
  // array out of a `string | readonly string[]` union via Array.isArray.
  if (type !== undefined && typeof type !== "string") {
    return { type: "STRING" };
  }
  if (node.additionalProperties) {
    return { type: "OBJECT" };
  }
  const out: Record<string, unknown> = {};
  if (type) {
    out.type = GEMINI_TYPES[type] ?? "STRING";
  }
  if (node.description) {
    out.description = node.description;
  }
  if (node.enum) {
    out.enum = node.enum;
  }
  if (node.required) {
    out.required = node.required;
  }
  if (node.items) {
    out.items = toGeminiSchema(node.items);
  }
  if (node.properties) {
    out.properties = Object.fromEntries(Object.entries(node.properties).map(([key, value]) => [key, toGeminiSchema(value)]));
  }
  return out;
}

/** Gemini's own request/response shapes - kept private to this file (see the class header: nothing Gemini-specific leaks past interpret()). */
interface GeminiPart {
  text?: string;
}
interface GeminiCandidate {
  content?: { parts?: GeminiPart[] };
  finishReason?: string;
}
interface GeminiGenerateContentResponse {
  candidates?: GeminiCandidate[];
  promptFeedback?: { blockReason?: string };
}

function isGenerateContentResponse(payload: unknown): payload is GeminiGenerateContentResponse {
  return typeof payload === "object" && payload !== null;
}

/** Joins every text part of the first candidate - Gemini can split one JSON response across several parts. */
function extractCandidateText(payload: GeminiGenerateContentResponse): string | null {
  const parts = payload.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts) || parts.length === 0) {
    return null;
  }
  const text = parts
    .map((part) => (typeof part.text === "string" ? part.text : ""))
    .join("")
    .trim();
  return text.length > 0 ? text : null;
}

export class GeminiProvider implements AIProvider {
  // Plain field declarations + assignment in the constructor body,
  // deliberately NOT TypeScript parameter-property shorthand - same
  // reasoning as OpenAIProvider.ts/AICommandPipeline.ts: this class is
  // instantiated directly by ai/providers/verify.ts, and Node's native
  // TypeScript support cannot run parameter properties.
  private readonly apiKey: string;
  private readonly fetchImpl: GeminiFetch;
  private readonly model: string;
  private readonly baseUrl: string;

  constructor(options: GeminiProviderOptions) {
    if (!options || typeof options.apiKey !== "string" || options.apiKey.trim().length === 0) {
      throw new Error(
        'GeminiProvider requires an API key. Pass it explicitly via the "apiKey" option - this class never reads ' +
          'GEMINI_API_KEY (or any other environment variable) itself. See ai/README.md "Security boundary".'
      );
    }
    if (typeof options.fetch !== "function") {
      throw new Error(
        'GeminiProvider requires an injected "fetch" transport (a real fetch in a trusted server context, or a ' +
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
      systemInstruction: { role: "system", parts: [{ text: buildSystemPrompt(request) }] },
      // Two parts of one user turn, not two turns - the context and the
      // instruction are each their own part, same separation of concerns
      // as OpenAIProvider's two separate user messages.
      contents: [{ role: "user", parts: [{ text: buildContextMessage(request) }, { text: request.instruction }] }],
      generationConfig: {
        temperature: 0,
        responseMimeType: "application/json",
        responseSchema: toGeminiSchema(RESPONSE_JSON_SCHEMA.schema)
      }
    });

    let httpResponse: GeminiHttpResponse;
    try {
      httpResponse = await this.fetchImpl(`${this.baseUrl}/${this.model}:generateContent`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // The header form, not a "?key=" query parameter: an API key
          // never belongs in a URL (logs, proxies, browser history all
          // capture it) - see Google's own documented alternative to the
          // query-parameter form.
          "x-goog-api-key": this.apiKey
        },
        body
      });
    } catch (error) {
      // Error 1 of 4 required by requirement 10: the request itself failed (network error, transport threw, etc.).
      throw new Error(`Gemini request failed: ${describeError(error)}`);
    }

    if (!httpResponse.ok) {
      // Error 2 of 4: the request reached Gemini but it rejected it (bad key, rate limit, bad request, ...).
      const errorBody = await safeText(httpResponse);
      throw new Error(`Gemini request failed with status ${httpResponse.status}: ${errorBody}`);
    }

    let payload: unknown;
    try {
      payload = await httpResponse.json();
    } catch (error) {
      // Error 3 of 4 (part a): the HTTP body itself wasn't valid JSON.
      throw new Error(`Gemini response was not valid JSON: ${describeError(error)}`);
    }

    if (!isGenerateContentResponse(payload)) {
      // Error 3 of 4 (part b): valid JSON, but not shaped like a generateContent response.
      throw new Error("Gemini response was malformed: expected a JSON object.");
    }

    const content = extractCandidateText(payload);
    if (content === null) {
      // Error 3 of 4 (part c): no usable candidate text - most often the
      // prompt or the response was blocked, which Gemini reports without
      // any candidates at all rather than as an HTTP error.
      const blockReason = payload.promptFeedback?.blockReason;
      const finishReason = payload.candidates?.[0]?.finishReason;
      const reason = blockReason
        ? `blocked: ${blockReason}`
        : finishReason
          ? `finishReason: ${finishReason}`
          : "no candidates in the response";
      throw new Error(`Gemini returned no usable content (${reason}).`);
    }

    let parsedContent: unknown;
    try {
      parsedContent = JSON.parse(content);
    } catch (error) {
      // Error 3 of 4 (part d): the model's own text wasn't valid JSON.
      throw new Error(`Gemini response content was not valid JSON: ${describeError(error)}`);
    }

    if (
      typeof parsedContent !== "object" ||
      parsedContent === null ||
      !Array.isArray((parsedContent as { commands?: unknown }).commands)
    ) {
      // Error 3 of 4 (part e): valid JSON, but missing the "commands" array RESPONSE_JSON_SCHEMA requires.
      throw new Error('Gemini response content was malformed: expected "{ commands: [] }".');
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
