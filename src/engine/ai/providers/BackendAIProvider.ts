import type { AIProvider } from "../AIProvider";
import type { AIProviderRequest, AIProviderResponse } from "../types";

/**
 * A thin `AIProvider` that calls the AI proxy backend's
 * `POST /api/ai/interpret` endpoint (see `backend/`) instead of talking
 * to OpenAI itself. This is deliberately NOT a second implementation of
 * OpenAI's request/response shaping, structured-output schema, or
 * system prompt - all of that already lives exactly once, in
 * `providers/OpenAIProvider.ts`, and now runs server-side (see
 * `backend/src/server.ts`). This class only knows the backend's own
 * wire contract: send `{ instruction, projectContext,
 * availableObjectTypes }`, expect `{ commands, notes? }` back - the
 * exact same `AIProviderRequest`/`AIProviderResponse` shapes
 * `AICommandPipeline` already uses everywhere else.
 *
 * Like every other AIProvider, this class never touches Three.js, any
 * *Store, or the DOM - it only ever sees the read-only
 * AIProjectSnapshot/availableObjectTypes handed to it in
 * AIProviderRequest, and only ever returns structured, plain data.
 * `AICommandPipeline` (not this class) is what turns a successful
 * response into real mutations, exclusively through `CommandExecutor` -
 * this class has no reference to either and cannot reach them.
 *
 * No secret of any kind lives in this file, and it has no concept of an
 * API key - `OPENAI_API_KEY` is read only server-side (see
 * `backend/README.md` "Security posture"). The backend only answers
 * signed-in users: in the app, the injected transport is
 * `AuthController.authorize(fetch)` (see src/main.ts), which adds the
 * user's own session token. This class never sees or builds that header.
 */

/**
 * Minimal structural subset of the standard `fetch` signature this
 * provider needs - not the full DOM `fetch` type, mirroring
 * `OpenAIProvider.ts`'s `OpenAIFetch`/`OpenAIHttpResponse` (see that
 * file for the full reasoning). Deliberately a separate, independent
 * type rather than a shared/imported one - this class has no coupling
 * to `OpenAIProvider.ts` at all, consistent with "provider
 * independence" (see ai/README.md).
 */
export interface BackendHttpResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

/** The injected HTTP transport - see BackendAIProviderOptions.fetch. Accepts an AbortSignal so a real `fetch` can be aborted on timeout (see BackendAIProviderOptions.timeoutMs). */
export type BackendFetch = (
  url: string,
  init: { method: "POST"; headers: Record<string, string>; body: string; signal?: AbortSignal }
) => Promise<BackendHttpResponse>;

export interface BackendAIProviderOptions {
  /**
   * Base URL of the AI proxy backend, e.g. "http://localhost:8787" -
   * REQUIRED, with no built-in default and no same-origin fallback.
   * This project's Vite dev server has no proxy configured for the
   * backend's different port, and the backend's own deployment
   * topology isn't decided yet - see ai/README.md for the full
   * reasoning. A future milestone that actually wires this provider
   * into the running app decides what value to pass here.
   */
  baseUrl: string;
  /**
   * Injected HTTP transport - real (future) usage passes a real
   * `fetch`; every test in this repo passes a mock instead, so no test
   * ever makes a real network call. Deliberately not defaulted to a
   * global `fetch`, so this class can never silently reach for a real
   * network call on its own - same rule `OpenAIProvider` follows.
   */
  fetch: BackendFetch;
  /** Milliseconds to wait for the backend to respond before aborting the request. Defaults to 30000 (30s). */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const INTERPRET_PATH = "/api/ai/interpret";

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function safeText(response: BackendHttpResponse): Promise<string> {
  try {
    const text = await response.text();
    // Truncated defensively - an error body is for a human/log to read, not to grow unbounded.
    return text.length > 500 ? `${text.slice(0, 500)}…` : text;
  } catch {
    return "<no response body>";
  }
}

/** The backend's own `{ "error": "..." }` message when the body is one (e.g. "Sign in to use the AI assistant."), otherwise the body as-is. */
function errorDetail(body: string): string {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed === "object" && parsed !== null && typeof (parsed as { error?: unknown }).error === "string") {
      return (parsed as { error: string }).error;
    }
  } catch {
    // Not JSON - the text itself is the detail.
  }
  return body;
}

export class BackendAIProvider implements AIProvider {
  // Plain field declarations + assignment in the constructor body,
  // deliberately NOT TypeScript parameter-property shorthand - same
  // reasoning as OpenAIProvider.ts/AICommandPipeline.ts: this class is
  // instantiated directly by verify.ts, and Node's native TypeScript
  // support cannot run parameter properties.
  private readonly baseUrl: string;
  private readonly fetchImpl: BackendFetch;
  private readonly timeoutMs: number;

  constructor(options: BackendAIProviderOptions) {
    if (!options || typeof options.baseUrl !== "string" || options.baseUrl.trim().length === 0) {
      throw new Error('BackendAIProvider requires a non-empty "baseUrl" option pointing at the AI proxy backend.');
    }
    if (typeof options.fetch !== "function") {
      throw new Error(
        'BackendAIProvider requires an injected "fetch" transport (a real fetch in the running app, or a mock ' +
          "in tests) - it never falls back to a global fetch."
      );
    }

    // Strip a trailing slash so `${baseUrl}${INTERPRET_PATH}` never produces a doubled "//".
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = options.fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async interpret(request: AIProviderRequest): Promise<AIProviderResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    // Sent verbatim - exactly the existing AIProviderRequest fields the
    // backend expects (see backend/src/createServer.ts), nothing added,
    // nothing OpenAI-specific. projectContext includes the geometry
    // section AICommandPipeline derived; the backend never trusts it - it
    // derives its own from the snapshot fields it sanitizes (see
    // aiProjectContext.ts's parseAIProjectContext).
    const body = JSON.stringify({
      instruction: request.instruction,
      projectContext: request.projectContext,
      availableObjectTypes: request.availableObjectTypes
    });

    let httpResponse: BackendHttpResponse;
    try {
      httpResponse = await this.fetchImpl(`${this.baseUrl}${INTERPRET_PATH}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: controller.signal
      });
    } catch (error) {
      // Error 1 of 4 required by this milestone: a network failure or
      // an aborted/timed-out request - distinguished from a generic
      // network failure by checking whether OUR OWN timer fired.
      if (controller.signal.aborted) {
        throw new Error(`Backend request timed out after ${this.timeoutMs}ms.`);
      }
      throw new Error(`Backend request failed: ${describeError(error)}`);
    } finally {
      clearTimeout(timer);
    }

    if (!httpResponse.ok) {
      // Error 2 of 4: the request reached the backend but it rejected/failed it (400/401/413/502/500 - see backend/README.md).
      const errorBody = await safeText(httpResponse);
      throw new Error(`Backend request failed with status ${httpResponse.status}: ${errorDetail(errorBody)}`);
    }

    let payload: unknown;
    try {
      payload = await httpResponse.json();
    } catch (error) {
      // Error 3 of 4: valid HTTP response, but the body wasn't valid JSON.
      throw new Error(`Backend response was not valid JSON: ${describeError(error)}`);
    }

    if (
      typeof payload !== "object" ||
      payload === null ||
      !Array.isArray((payload as { commands?: unknown }).commands)
    ) {
      // Error 4 of 4: valid JSON, but missing the "commands" array AIProviderResponse requires.
      throw new Error('Backend response was malformed: expected "{ commands: [] }".');
    }

    const { commands, notes } = payload as { commands: unknown[]; notes?: unknown };

    // Unsupported/invalid commands in `commands` are deliberately NOT
    // checked here - they're handed back exactly as `unknown[]`, same
    // as every other provider, for AICommandPipeline's own structural +
    // domain validation to reject. See ai/README.md "Two validation
    // layers, not one".
    return {
      commands,
      notes: typeof notes === "string" ? notes : undefined
    };
  }
}
