import { createServer as createHttpServer } from "node:http";
import type { IncomingMessage, ServerResponse, Server } from "node:http";
import type { AIProvider } from "../../src/engine/ai/AIProvider.ts";
import { AI_SUPPORTED_OBJECT_TYPES } from "../../src/engine/ai/types.ts";
import type { AIProjectContext } from "../../src/engine/ai/types.ts";
import { parseAIProjectContext } from "../../src/engine/ai/aiProjectContext.ts";
import type { ObjectType } from "../../src/engine/objects/types.ts";
import {
  ProjectAuthError,
  ProjectNotFoundError,
  ProjectValidationError,
  parseProjectInput
} from "../../src/engine/project/ProjectRepository.ts";
import { AuthError, parseCredentials } from "./auth/AuthService.ts";
import type { AuthService, AuthUser } from "./auth/AuthService.ts";
import type { ProjectStore } from "./projects/ProjectStore.ts";

/**
 * The backend's HTTP layer. It has three jobs, and executes construction
 * commands for none of them:
 *
 * - `/api/auth/*` signs users up, in and out, refreshes their sessions,
 *   and says who a token belongs to - all through the injected
 *   `AuthService` (Supabase Auth in production, in memory for local
 *   development and tests).
 * - `POST /api/ai/interpret` accepts `{ instruction, projectContext,
 *   availableObjectTypes }`, calls `options.provider.interpret(...)` (a
 *   real `OpenAIProvider` in production - see server.ts - or a test
 *   double here), and relays back exactly what the provider returned
 *   (`{ commands, notes }`), unvalidated and unexecuted.
 * - `/api/projects` stores and returns the signed-in user's project
 *   documents through a `ProjectRepository` scoped to that user (see
 *   `ProjectStore`). Every document is validated with the shared
 *   parseProjectDocument() before it is stored; the browser validates it
 *   again before loading it.
 *
 * Identity is checked HERE, on every request, from the
 * `Authorization: Bearer <access token>` header - never taken from a
 * request body. The browser holds nothing but the user's own session
 * tokens: no Supabase key, no OpenAI key.
 *
 * `CommandExecutor` is never imported here, and nothing under
 * `src/engine/commands/` is either - this server never turns a command
 * into a real mutation. That still happens exactly where it always has:
 * client-side, inside `AICommandPipeline.run()`, which structurally
 * validates every command and only then calls `CommandExecutor.execute()`.
 * The frontend's `BackendAIProvider` hands this endpoint's response
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
   * The single origin allowed to call this server
   * (Access-Control-Allow-Origin). NOT an authentication mechanism -
   * that is the `authService`'s job.
   */
  frontendOrigin: string;
  /**
   * Who is signed in. server.ts passes a `SupabaseAuthService` (or an
   * `InMemoryAuthService` with LOCAL_AUTH=memory); mockBackend.ts the
   * in-memory one. With one, `/api/auth/*` is served and
   * `/api/ai/interpret` requires a signed-in user. Without one,
   * `/api/auth/*` and `/api/projects` answer 501 and the AI endpoint is
   * open - only tests construct a server that way.
   */
  authService?: AuthService;
  /**
   * Where signed-in users' projects are kept - an `InMemoryProjectStore`
   * or a `SupabaseProjectStore`. Without one (or without an
   * `authService`), `/api/projects` answers 501.
   */
  projectStore?: ProjectStore;
}

// Generous for this endpoint's small JSON payloads, small enough to
// bound memory use from an unbounded (or malicious) request body.
const MAX_BODY_BYTES = 1_000_000;
/** Credentials and refresh tokens are tiny. */
const MAX_AUTH_BODY_BYTES = 16_384;
const MAX_TOKEN_LENGTH = 8_192;

const PROJECTS_PATH = "/api/projects";
/** Project ids are UUIDs (or test ids) - letters, digits, dashes and underscores. */
const PROJECT_ID = /^[A-Za-z0-9_-]{1,100}$/;

const AUTH_PATH = "/api/auth";
const AUTH_ROUTES = ["/signup", "/signin", "/refresh", "/signout", "/session"];

const SIGN_IN_FOR_PROJECTS = "Sign in to save and open projects.";
const SIGN_IN_FOR_AI = "Sign in to use the AI assistant.";
const SESSION_EXPIRED = "Your session expired - sign in again.";

function setCommonHeaders(res: ServerResponse, frontendOrigin: string): void {
  res.setHeader("Access-Control-Allow-Origin", frontendOrigin);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  // Tells caches/CDNs the response varies by Origin - correct hygiene
  // whenever Access-Control-Allow-Origin reflects a specific origin.
  res.setHeader("Vary", "Origin");
  // Responses can carry session tokens and private projects - never cache them.
  res.setHeader("Cache-Control", "no-store");
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(payload);
}

function sendNoContent(res: ServerResponse): void {
  res.writeHead(204);
  res.end();
}

function sendUnauthorized(res: ServerResponse, message: string): void {
  res.setHeader("WWW-Authenticate", "Bearer");
  sendJson(res, 401, { error: message, code: "unauthorized" });
}

/** Logs a failure by name and message only - never a header, token, or request body. */
function logFailure(context: string, error: unknown): void {
  console.error(`${context}:`, error instanceof Error ? `${error.name}: ${error.message}` : String(error));
}

type BodyReadResult = { ok: true; value: unknown } | { ok: false; status: number; error: string };

async function readJsonBody(req: IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<BodyReadResult> {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of req as AsyncIterable<Buffer>) {
    total += chunk.length;
    if (total > maxBytes) {
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

/** The token in "Authorization: Bearer <token>", or null when there isn't a well-formed one. */
function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== "string") {
    return null;
  }
  const match = /^Bearer\s+([A-Za-z0-9._~+/=-]+)$/i.exec(header.trim());
  return match && match[1].length <= MAX_TOKEN_LENGTH ? match[1] : null;
}

/**
 * Who sent this request - checked with the AuthService on every request.
 * Answers the request itself (401, or 502 when the identity provider
 * can't be reached) and returns null when there is no valid session.
 */
async function authenticate(
  req: IncomingMessage,
  res: ServerResponse,
  authService: AuthService,
  signedOutMessage: string
): Promise<{ user: AuthUser; token: string } | null> {
  const token = bearerToken(req);
  if (!token) {
    sendUnauthorized(res, signedOutMessage);
    return null;
  }
  try {
    return { user: await authService.getUser(token), token };
  } catch (error) {
    if (error instanceof AuthError && error.status === 401) {
      sendUnauthorized(res, SESSION_EXPIRED);
      return null;
    }
    if (error instanceof AuthError) {
      sendJson(res, error.status >= 500 ? 502 : error.status, { error: error.message });
      return null;
    }
    logFailure("Checking a session failed", error);
    sendJson(res, 502, { error: "Could not check your session - try again." });
    return null;
  }
}

type ParsedInterpretRequest =
  | {
      ok: true;
      instruction: string;
      projectContext: AIProjectContext;
      availableObjectTypes: readonly ObjectType[];
    }
  | { ok: false; error: string };

/**
 * Loosely validates the request body has the shape an AIProviderRequest
 * needs. Deliberately NOT a replacement for AICommandPipeline's own
 * structural/domain validation, which still runs client-side on
 * whatever this endpoint returns (see the file header) - this only
 * decides "is this even worth relaying to the provider", the same way
 * AICommandPipeline itself rejects an empty instruction before ever
 * calling a provider.
 *
 * `projectContext` goes through the shared parseAIProjectContext()
 * (src/engine/ai/aiProjectContext.ts) - the same function the frontend's
 * end-to-end mock backend uses. It checks and sanitizes the snapshot
 * fields (any field a client adds beyond AIProjectSnapshot's is dropped),
 * then derives the geometry section from that sanitized snapshot with the
 * same analyzeConstructionGeometry() the browser runs. Whatever geometry
 * the client sent is never read: the provider only ever sees geometry
 * this server computed.
 */
function parseInterpretRequest(body: unknown): ParsedInterpretRequest {
  if (!isPlainObject(body)) {
    return { ok: false, error: "Request body must be a JSON object." };
  }

  const instruction = body.instruction;
  if (typeof instruction !== "string" || instruction.trim().length === 0) {
    return { ok: false, error: '"instruction" is required and must be a non-empty string.' };
  }

  const context = parseAIProjectContext(body.projectContext);
  if (!context.ok) {
    return { ok: false, error: context.error };
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
    projectContext: context.context,
    availableObjectTypes
  };
}

/**
 * `/api/auth/*`:
 *
 * - `POST /signup` `{ email, password }` - 201 `{ session }`, or 202
 *   `{ confirmationRequired, email }` when the email must be confirmed first.
 * - `POST /signin` `{ email, password }` - 200 `{ session }`.
 * - `POST /refresh` `{ refreshToken }` - 200 `{ session }`.
 * - `POST /signout` (Bearer) - 204.
 * - `GET /session` (Bearer) - 200 `{ user }`.
 *
 * A refused request gets the AuthError's status and message; the
 * identity provider's own responses never reach the browser.
 */
async function handleAuthRequest(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  path: string,
  authService: AuthService | undefined
): Promise<void> {
  if (!authService) {
    sendJson(res, 501, { error: "Sign-in is not configured on this server." });
    return;
  }
  const route = path.slice(AUTH_PATH.length);
  if (!AUTH_ROUTES.includes(route)) {
    sendJson(res, 404, { error: `Not found: ${method} ${path}` });
    return;
  }
  if (method !== (route === "/session" ? "GET" : "POST")) {
    sendJson(res, 405, { error: `${method} is not allowed on ${path}.` });
    return;
  }

  try {
    if (route === "/session") {
      const auth = await authenticate(req, res, authService, "Not signed in.");
      if (auth) {
        sendJson(res, 200, { user: auth.user });
      }
      return;
    }

    if (route === "/signout") {
      const token = bearerToken(req);
      if (!token) {
        sendUnauthorized(res, "Not signed in.");
        return;
      }
      await authService.signOut(token);
      sendNoContent(res);
      return;
    }

    const body = await readJsonBody(req, MAX_AUTH_BODY_BYTES);
    if (!body.ok) {
      sendJson(res, body.status, { error: body.error });
      return;
    }

    if (route === "/refresh") {
      const refreshToken = isPlainObject(body.value) ? body.value.refreshToken : undefined;
      if (typeof refreshToken !== "string" || refreshToken.length === 0 || refreshToken.length > MAX_TOKEN_LENGTH) {
        sendJson(res, 400, { error: '"refreshToken" is required.' });
        return;
      }
      sendJson(res, 200, { session: await authService.refresh(refreshToken) });
      return;
    }

    const credentials = parseCredentials(body.value);
    if (!credentials.ok) {
      sendJson(res, 400, { error: credentials.error });
      return;
    }
    if (route === "/signin") {
      sendJson(res, 200, { session: await authService.signIn(credentials.email, credentials.password) });
      return;
    }
    const outcome = await authService.signUp(credentials.email, credentials.password);
    if ("session" in outcome) {
      sendJson(res, 201, { session: outcome.session });
    } else {
      sendJson(res, 202, { confirmationRequired: true, email: outcome.email });
    }
  } catch (error) {
    if (error instanceof AuthError) {
      if (error.status === 401) {
        sendUnauthorized(res, error.message);
      } else {
        sendJson(res, error.status, { error: error.message });
      }
      return;
    }
    logFailure("Auth request failed", error);
    sendJson(res, 502, { error: "The sign-in service could not be reached - try again." });
  }
}

/** The id in "/api/projects/<id>", or null if it isn't a well-formed project id. */
function projectIdFrom(path: string): string | null {
  let id: string;
  try {
    id = decodeURIComponent(path.slice(PROJECTS_PATH.length + 1));
  } catch {
    return null;
  }
  return PROJECT_ID.test(id) ? id : null;
}

/**
 * `/api/projects` - list, create, read, save and delete the SIGNED-IN
 * USER'S projects. The user is authenticated first (401 otherwise), and
 * the repository is scoped to them: another user's project answers 404,
 * exactly like one that doesn't exist. Every body is checked with the
 * shared parseProjectInput() (a name, and a document that passes
 * parseProjectDocument()) before the repository sees it.
 */
async function handleProjectRequest(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  path: string,
  options: CreateServerOptions
): Promise<void> {
  if (!options.projectStore || !options.authService) {
    sendJson(res, 501, { error: "Project storage is not configured on this server." });
    return;
  }
  const auth = await authenticate(req, res, options.authService, SIGN_IN_FOR_PROJECTS);
  if (!auth) {
    return;
  }
  const repository = options.projectStore.forUser(auth.user, auth.token);

  try {
    if (path === PROJECTS_PATH) {
      if (method === "GET") {
        sendJson(res, 200, { projects: await repository.list() });
        return;
      }
      if (method === "POST") {
        const body = await readJsonBody(req);
        if (!body.ok) {
          sendJson(res, body.status, { error: body.error });
          return;
        }
        const parsed = parseProjectInput(body.value);
        if (!parsed.ok) {
          sendJson(res, 400, { error: parsed.error });
          return;
        }
        sendJson(res, 201, { project: await repository.create(parsed.input) });
        return;
      }
      sendJson(res, 405, { error: `${method} is not allowed on ${PROJECTS_PATH}.` });
      return;
    }

    const id = projectIdFrom(path);
    if (id === null) {
      sendJson(res, 404, { error: "No such project." });
      return;
    }

    if (method === "GET") {
      const record = await repository.get(id);
      if (!record) {
        sendJson(res, 404, { error: `No saved project with id "${id}".` });
        return;
      }
      sendJson(res, 200, { project: record });
      return;
    }
    if (method === "PUT") {
      const body = await readJsonBody(req);
      if (!body.ok) {
        sendJson(res, body.status, { error: body.error });
        return;
      }
      const parsed = parseProjectInput(body.value);
      if (!parsed.ok) {
        sendJson(res, 400, { error: parsed.error });
        return;
      }
      sendJson(res, 200, { project: await repository.save(id, parsed.input) });
      return;
    }
    if (method === "DELETE") {
      await repository.delete(id);
      sendNoContent(res);
      return;
    }
    sendJson(res, 405, { error: `${method} is not allowed on a project.` });
  } catch (error) {
    if (error instanceof ProjectNotFoundError) {
      sendJson(res, 404, { error: error.message });
      return;
    }
    if (error instanceof ProjectValidationError) {
      sendJson(res, 400, { error: error.message });
      return;
    }
    if (error instanceof ProjectAuthError) {
      sendUnauthorized(res, error.message);
      return;
    }
    // A storage failure - never leak its details to the client.
    logFailure("Project storage failed", error);
    sendJson(res, 500, { error: "Project storage failed." });
  }
}

async function handleRequest(req: IncomingMessage, res: ServerResponse, options: CreateServerOptions): Promise<void> {
  const method = req.method ?? "GET";
  const url = req.url ?? "/";
  const path = url.split("?")[0];

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

  if (path.startsWith(`${AUTH_PATH}/`)) {
    await handleAuthRequest(req, res, method, path, options.authService);
    return;
  }

  if (path === PROJECTS_PATH || path.startsWith(`${PROJECTS_PATH}/`)) {
    await handleProjectRequest(req, res, method, path, options);
    return;
  }

  if (method === "POST" && url === "/api/ai/interpret") {
    // A signed-in user is required before anything is read or relayed -
    // an unauthenticated request never spends the provider's quota.
    if (options.authService && !(await authenticate(req, res, options.authService, SIGN_IN_FOR_AI))) {
      return;
    }

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

  sendJson(res, 404, { error: `Not found: ${method} ${path}` });
}

/** Builds (but does not start) the backend's HTTP server. Call `.listen(port)` on the result. */
export function createServer(options: CreateServerOptions): Server {
  return createHttpServer((req, res) => {
    handleRequest(req, res, options).catch((error: unknown) => {
      // Anything that reaches here is a bug in this file, not a normal
      // request-level failure (those are all handled inside
      // handleRequest itself) - never crash the process over one bad
      // request, and never leak internal error details to the client.
      logFailure("Unexpected error handling request", error);
      if (!res.headersSent) {
        sendJson(res, 500, { error: "Internal server error." });
      } else {
        res.end();
      }
    });
  });
}
