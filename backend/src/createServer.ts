import { createServer as createHttpServer } from "node:http";
import type { IncomingMessage, ServerResponse, Server } from "node:http";
import type { AIProvider } from "../../src/engine/ai/AIProvider.ts";
import { AI_SUPPORTED_OBJECT_TYPES } from "../../src/engine/ai/types.ts";
import type { AIProjectSnapshot } from "../../src/engine/ai/types.ts";
import type { ObjectType } from "../../src/engine/objects/types.ts";

/**
 * The AI proxy backend's HTTP layer. This is the ONLY new "mutation
 * path" this milestone introduces, and it doesn't mutate anything at
 * all: it accepts `{ instruction, projectContext, availableObjectTypes
 * }`, calls `options.provider.interpret(...)` (a real `OpenAIProvider`
 * in production - see server.ts - or a test double here), and relays
 * back exactly what the provider returned (`{ commands, notes }`),
 * unvalidated and unexecuted.
 *
 * `CommandExecutor` is never imported here, and nothing under
 * `src/engine/commands/` is either - this server never turns a command
 * into a real mutation. That still happens exactly where it always has:
 * client-side, inside `AICommandPipeline.run()`, which structurally
 * validates every command and only then calls `CommandExecutor.execute()`.
 * A future client-side `AIProvider` that calls this endpoint (not built
 * in this milestone - see backend/README.md) would hand this response
 * straight to the existing `AICommandPipeline`, completely unchanged -
 * "CommandExecutor is the only mutation path" stays true with this
 * server in the loop for exactly the same reason it stayed true when
 * `OpenAIProvider` was added: nothing new between the provider and
 * `CommandExecutor` skips validation.
 */

export interface CreateServerOptions {
  /**
   * Anything implementing the existing `AIProvider` interface - real
   * usage passes a real `OpenAIProvider` constructed in server.ts
   * (with the real API key and a real `fetch`, both server-side only);
   * every check in verify.ts passes a test double instead. This file
   * has no idea which, and no OpenAI-specific code at all - that's
   * "provider independence" (see ai/README.md) extended one layer out.
   */
  provider: AIProvider;
  /**
   * The single origin allowed to call this proxy
   * (Access-Control-Allow-Origin). NOT an authentication mechanism -
   * see backend/README.md "Security posture" for why this endpoint is
   * otherwise open in this milestone, and what a real deployment needs
   * to add.
   */
  frontendOrigin: string;
}

// Generous for this endpoint's small JSON payloads, small enough to
// bound memory use from an unbounded (or malicious) request body -
// simple, dependency-free hardening appropriate for an endpoint that
// (in this milestone) has no other abuse protection.
const MAX_BODY_BYTES = 1_000_000;

function setCommonHeaders(res: ServerResponse, frontendOrigin: string): void {
  res.setHeader("Access-Control-Allow-Origin", frontendOrigin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  // Tells caches/CDNs the response varies by Origin - correct hygiene
  // whenever Access-Control-Allow-Origin reflects a specific origin.
  res.setHeader("Vary", "Origin");
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(payload);
}

type BodyReadResult = { ok: true; value: unknown } | { ok: false; status: number; error: string };

async function readJsonBody(req: IncomingMessage): Promise<BodyReadResult> {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of req as AsyncIterable<Buffer>) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) {
      return { ok: false, status: 413, error: "Request body too large." };
    }
    chunks.push(chunk);
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  if (raw.trim().length === 0) {
    return { ok: false, status: 400, error: "Request body is empty." };
  }

  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch (error) {
    return {
      ok: false,
      status: 400,
      error: `Request body is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

type ParsedInterpretRequest =
  | {
      ok: true;
      instruction: string;
      projectContext: AIProjectSnapshot;
      availableObjectTypes: readonly ObjectType[];
    }
  | { ok: false; error: string };

const SNAPSHOT_COUNT_FIELDS = [
  "wallCount",
  "pillarCount",
  "beamCount",
  "slabCount",
  "doorCount",
  "windowCount",
  "assemblyCount"
] as const;

/**
 * Loosely validates the request body has the shape an AIProviderRequest
 * needs. Deliberately NOT a replacement for AICommandPipeline's own
 * structural/domain validation, which still runs client-side on
 * whatever this endpoint returns (see the file header) - this only
 * decides "is this even worth relaying to the provider", the same way
 * AICommandPipeline itself rejects an empty instruction before ever
 * calling a provider.
 */
function parseInterpretRequest(body: unknown): ParsedInterpretRequest {
  if (!isPlainObject(body)) {
    return { ok: false, error: "Request body must be a JSON object." };
  }

  const instruction = body.instruction;
  if (typeof instruction !== "string" || instruction.trim().length === 0) {
    return { ok: false, error: '"instruction" is required and must be a non-empty string.' };
  }

  const projectContext = body.projectContext;
  if (!isPlainObject(projectContext)) {
    return { ok: false, error: '"projectContext" is required and must be an object.' };
  }
  for (const field of SNAPSHOT_COUNT_FIELDS) {
    if (!isFiniteNumber(projectContext[field])) {
      return { ok: false, error: `"projectContext.${field}" is required and must be a number.` };
    }
  }
  const selectedObjectId = projectContext.selectedObjectId;
  if (selectedObjectId !== null && typeof selectedObjectId !== "string") {
    return { ok: false, error: '"projectContext.selectedObjectId" must be a string or null.' };
  }

  let availableObjectTypes: readonly ObjectType[] = AI_SUPPORTED_OBJECT_TYPES;
  if (body.availableObjectTypes !== undefined) {
    const raw = body.availableObjectTypes;
    if (!Array.isArray(raw) || !raw.every((entry) => typeof entry === "string")) {
      return { ok: false, error: '"availableObjectTypes" must be an array of strings when provided.' };
    }
    availableObjectTypes = raw as ObjectType[];
  }

  return {
    ok: true,
    instruction,
    projectContext: {
      wallCount: projectContext.wallCount as number,
      pillarCount: projectContext.pillarCount as number,
      beamCount: projectContext.beamCount as number,
      slabCount: projectContext.slabCount as number,
      doorCount: projectContext.doorCount as number,
      windowCount: projectContext.windowCount as number,
      assemblyCount: projectContext.assemblyCount as number,
      selectedObjectId: (selectedObjectId as string | null | undefined) ?? null
    },
    availableObjectTypes
  };
}

async function handleRequest(req: IncomingMessage, res: ServerResponse, options: CreateServerOptions): Promise<void> {
  const method = req.method ?? "GET";
  const url = req.url ?? "/";

  setCommonHeaders(res, options.frontendOrigin);

  if (method === "OPTIONS") {
    // CORS preflight - no body, no route logic.
    res.writeHead(204);
    res.end();
    return;
  }

  if (method === "GET" && url === "/health") {
    sendJson(res, 200, { status: "ok" });
    return;
  }

  if (method === "POST" && url === "/api/ai/interpret") {
    const bodyResult = await readJsonBody(req);
    if (!bodyResult.ok) {
      sendJson(res, bodyResult.status, { error: bodyResult.error });
      return;
    }

    const parsed = parseInterpretRequest(bodyResult.value);
    if (!parsed.ok) {
      sendJson(res, 400, { error: parsed.error });
      return;
    }

    try {
      const response = await options.provider.interpret({
        instruction: parsed.instruction,
        projectContext: parsed.projectContext,
        availableObjectTypes: parsed.availableObjectTypes
      });
      // Relayed exactly as the provider returned it - see the file
      // header for why this server never re-validates or reshapes it.
      sendJson(res, 200, response);
    } catch (error) {
      // OpenAIProvider's own error messages (see providers/OpenAIProvider.ts)
      // are already clean, key-free strings safe to relay to the client -
      // this is the "clear error" this endpoint owes its caller for an
      // upstream failure (missing key never reaches here - server.ts
      // refuses to start without one; a failed request, a malformed
      // response, or an OpenAI-side error all surface as this generic
      // upstream-failure path). 502 (Bad Gateway): this server is a
      // proxy, and the failure happened calling *its* upstream.
      const message = error instanceof Error ? error.message : String(error);
      sendJson(res, 502, { error: message });
    }
    return;
  }

  sendJson(res, 404, { error: `Not found: ${method} ${url}` });
}

/** Builds (but does not start) the AI proxy backend's HTTP server. Call `.listen(port)` on the result. */
export function createServer(options: CreateServerOptions): Server {
  return createHttpServer((req, res) => {
    handleRequest(req, res, options).catch((error: unknown) => {
      // Anything that reaches here is a bug in this file, not a normal
      // request-level failure (those are all handled inside
      // handleRequest itself) - never crash the process over one bad
      // request, and never leak internal error details to the client.
      console.error("Unexpected error handling request:", error);
      if (!res.headersSent) {
        sendJson(res, 500, { error: "Internal server error." });
      } else {
        res.end();
      }
    });
  });
}
