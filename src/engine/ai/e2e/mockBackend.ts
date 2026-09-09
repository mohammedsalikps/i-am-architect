import type { BackendFetch, BackendHttpResponse } from "../providers/BackendAIProvider";
import type { AIProjectSnapshot } from "../types";

/**
 * A controlled stand-in for the AI proxy backend, used by the
 * end-to-end suite (see e2e/verify.ts). It is deliberately NOT a dumb
 * "always return this JSON" stub: it enforces the same request contract
 * the real endpoint does (`POST <base>/api/ai/interpret`, JSON body
 * with a non-empty `instruction` plus a complete `projectContext`), and
 * answers with the same status codes - so if BackendAIProvider ever
 * drifted from what backend/src/createServer.ts accepts, the E2E checks
 * fail rather than quietly passing against a permissive fake.
 *
 * That contract fidelity is verified from the other side too: a check
 * in backend/verify.ts runs the REAL BackendAIProvider against the REAL
 * backend server over real HTTP (with a stub AIProvider standing in for
 * OpenAI), proving the shape this file accepts is the shape the real
 * server accepts.
 *
 * Nothing here can reach the network: it is a plain function satisfying
 * BackendFetch, and BackendAIProvider never falls back to a global
 * fetch (see its constructor). No OpenAI code, key, or endpoint is
 * involved at any point.
 */

/** One request this mock received, decoded into the fields tests actually assert on. */
export interface RecordedBackendRequest {
  url: string;
  method: string;
  instruction: string;
  projectContext: AIProjectSnapshot;
  availableObjectTypes: unknown;
}

/** What a test wants the mock backend to answer with for a given request. */
export type MockBackendReply =
  | { kind: "ok"; commands: unknown[]; notes?: string }
  /** A non-2xx response, mirroring the real backend's 400/413/502/500 paths. */
  | { kind: "status"; status: number; error: string }
  /** A transport-level failure (server unreachable), mirroring a real `fetch` rejection. */
  | { kind: "networkError"; message: string }
  /** A 200 whose body isn't the agreed `{ commands: [] }` shape. */
  | { kind: "malformedBody"; body: unknown };

export type MockBackendHandler = (request: RecordedBackendRequest) => MockBackendReply | Promise<MockBackendReply>;

export interface MockBackend {
  /** Pass this straight to `new BackendAIProvider({ fetch })`. */
  fetch: BackendFetch;
  /** Every request that reached the mock, in order - lets tests assert the snapshot sent and count requests. */
  requests: RecordedBackendRequest[];
}

const INTERPRET_PATH = "/api/ai/interpret";

const SNAPSHOT_COUNT_FIELDS = [
  "wallCount",
  "pillarCount",
  "beamCount",
  "slabCount",
  "doorCount",
  "windowCount",
  "assemblyCount"
] as const;

function jsonResponse(status: number, body: unknown): BackendHttpResponse {
  const serialized = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => JSON.parse(serialized),
    text: async () => serialized
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Mirrors backend/src/createServer.ts's own request validation - same rules, same 400 response shape. */
function validateRequestBody(body: unknown): string | null {
  if (!isPlainObject(body)) {
    return "Request body must be a JSON object.";
  }
  if (typeof body.instruction !== "string" || body.instruction.trim().length === 0) {
    return '"instruction" is required and must be a non-empty string.';
  }
  const projectContext = body.projectContext;
  if (!isPlainObject(projectContext)) {
    return '"projectContext" is required and must be an object.';
  }
  for (const field of SNAPSHOT_COUNT_FIELDS) {
    if (typeof projectContext[field] !== "number" || !Number.isFinite(projectContext[field])) {
      return `"projectContext.${field}" is required and must be a number.`;
    }
  }
  const selectedObjectId = projectContext.selectedObjectId;
  if (selectedObjectId !== null && typeof selectedObjectId !== "string") {
    return '"projectContext.selectedObjectId" must be a string or null.';
  }
  if (body.availableObjectTypes !== undefined) {
    const types = body.availableObjectTypes;
    if (!Array.isArray(types) || !types.every((entry) => typeof entry === "string")) {
      return '"availableObjectTypes" must be an array of strings when provided.';
    }
  }
  return null;
}

/**
 * Builds a mock backend. `handler` decides the reply per request - a
 * test can return commands, an error status, a transport failure, or a
 * malformed body, and can inspect the decoded request to do so.
 */
export function createMockBackend(handler: MockBackendHandler): MockBackend {
  const requests: RecordedBackendRequest[] = [];

  const fetchImpl: BackendFetch = async (url, init) => {
    // Contract check 1: the provider must POST to the real endpoint path.
    if (init.method !== "POST" || !url.endsWith(INTERPRET_PATH)) {
      return jsonResponse(404, { error: `Not found: ${init.method} ${url}` });
    }

    // Contract check 2: the body must be JSON the real backend would parse.
    let body: unknown;
    try {
      body = JSON.parse(init.body);
    } catch (error) {
      return jsonResponse(400, {
        error: `Request body is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
      });
    }

    // Contract check 3: the body must satisfy the real backend's own field rules.
    const validationError = validateRequestBody(body);
    if (validationError) {
      return jsonResponse(400, { error: validationError });
    }

    const typedBody = body as {
      instruction: string;
      projectContext: AIProjectSnapshot;
      availableObjectTypes?: unknown;
    };
    const recorded: RecordedBackendRequest = {
      url,
      method: init.method,
      instruction: typedBody.instruction,
      projectContext: typedBody.projectContext,
      availableObjectTypes: typedBody.availableObjectTypes
    };
    requests.push(recorded);

    const reply = await handler(recorded);
    switch (reply.kind) {
      case "ok":
        return jsonResponse(200, reply.notes === undefined ? { commands: reply.commands } : { commands: reply.commands, notes: reply.notes });
      case "status":
        return jsonResponse(reply.status, { error: reply.error });
      case "malformedBody":
        return jsonResponse(200, reply.body);
      case "networkError":
        // A real `fetch` rejects rather than resolving when it can't reach the server.
        throw new Error(reply.message);
    }
  };

  return { fetch: fetchImpl, requests };
}
