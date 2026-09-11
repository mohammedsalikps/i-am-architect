/**
 * Verification for accounts, sessions and project ownership on the
 * backend: the /api/auth routes, the authentication every project and AI
 * request goes through, per-user project storage, the Supabase adapters,
 * and the server's configuration. Same conventions as verify.ts - no test
 * framework, the real server on an ephemeral loopback port - run directly
 * by Node:
 *   node auth.verify.ts
 *
 * Nothing here needs a credential or reaches past loopback. Accounts are
 * InMemoryAuthService's; the Supabase adapters talk to a small in-process
 * fake Supabase (GoTrue + PostgREST, with the migration's Row Level
 * Security rule) through their injected transport - never a real project.
 * The browser side is the real HttpAuthClient, AuthController,
 * HttpProjectRepository and BackendAIProvider.
 *
 * The Supabase keys below are fabricated test strings in the legacy JWT
 * shape (one "anon", one "service_role") - not credentials of any project.
 */
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "./src/createServer.ts";
import type { CreateServerOptions } from "./src/createServer.ts";
import { InMemoryAuthService } from "./src/auth/InMemoryAuthService.ts";
import { SupabaseAuthService } from "./src/auth/SupabaseAuthService.ts";
import { AuthError } from "./src/auth/AuthService.ts";
import { SupabaseProjectRepository, SupabaseProjectStore } from "./src/projects/SupabaseProjectRepository.ts";
import { ProjectStorageUnavailableError } from "./src/projects/ProjectStore.ts";
import type { ProjectStore } from "./src/projects/ProjectStore.ts";
import type { SupabaseFetch, SupabaseHttpResponse } from "./src/supabase/supabaseHttp.ts";
import { isPrivilegedSupabaseKey, parseFrontendOrigins, readServerConfig } from "./src/config.ts";
import { InMemoryProjectStore } from "../src/engine/project/InMemoryProjectRepository.ts";
import { HttpProjectRepository } from "../src/engine/project/HttpProjectRepository.ts";
import type { ProjectFetch } from "../src/engine/project/HttpProjectRepository.ts";
import { ProjectAuthError, ProjectNotFoundError, ProjectValidationError } from "../src/engine/project/ProjectRepository.ts";
import { parseProjectDocument } from "../src/engine/project/projectDocument.ts";
import type { ProjectDocument } from "../src/engine/project/projectDocument.ts";
import { HttpAuthClient } from "../src/engine/auth/HttpAuthClient.ts";
import type { AuthFetch } from "../src/engine/auth/HttpAuthClient.ts";
import { AuthController, SESSION_STORAGE_KEY } from "../src/engine/auth/AuthController.ts";
import type { SessionStorageLike } from "../src/engine/auth/AuthController.ts";
import type { AuthSession } from "../src/engine/auth/types.ts";
import { BackendAIProvider } from "../src/engine/ai/providers/BackendAIProvider.ts";
import type { BackendFetch } from "../src/engine/ai/providers/BackendAIProvider.ts";
import { buildAIProjectContext } from "../src/engine/ai/aiProjectContext.ts";
import { AI_SUPPORTED_OBJECT_TYPES } from "../src/engine/ai/types.ts";
import type { AIProvider } from "../src/engine/ai/AIProvider.ts";
import type { AIProjectSnapshot, AIProviderRequest } from "../src/engine/ai/types.ts";

function assertTrue(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertDeepEqual(actual: unknown, expected: unknown, message: string): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`${message}:\n  expected ${expectedJson}\n  got      ${actualJson}`);
  }
}

async function assertRejects(fn: () => Promise<unknown>, check: (error: unknown) => boolean, message: string): Promise<void> {
  try {
    await fn();
  } catch (error) {
    assertTrue(check(error), `${message}: unexpected error ${String(error)}`);
    return;
  }
  throw new Error(`${message}: expected a rejection`);
}

const FRONTEND_ORIGIN = "http://localhost:5173";
const PASSWORD = "correct horse battery";
const EXPIRED = "Your session expired - sign in again.";
const SIGN_IN_FOR_PROJECTS = "Sign in to save and open projects.";

function fakeJwtKey(role: string): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "HS256", typ: "JWT" })}.${part({ iss: "supabase-test", ref: "example-project", role })}.test-signature`;
}
const ANON_KEY = fakeJwtKey("anon");
const SERVICE_ROLE_KEY = fakeJwtKey("service_role");
const SUPABASE_URL = "https://example-project.supabase.co";
const USER_ID = "3f1c2b7e-8a4d-4c1e-9b2a-5d6e7f809a1b";
const PROJECT_ID = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";

const EMPTY: ProjectDocument = { version: 1, objects: [], assemblies: [] };
const ONE_WALL: ProjectDocument = {
  version: 1,
  objects: [
    {
      id: "wall-3",
      type: "wall",
      position: { x: 0, y: 1.35, z: 0 },
      rotation: 0,
      dimensions: { length: 4, height: 2.7, thickness: 0.2 },
      material: "generic",
      color: "#c9c9c9",
      assemblyId: null
    }
  ],
  assemblies: [{ id: "assembly-1", name: "Ground Floor", objectIds: ["wall-3"], createdAt: 1, updatedAt: 2 }]
};

/**
 * How PostgreSQL's jsonb hands a stored object back: keys reordered,
 * shorter keys first, then bytewise - so {"version","objects","assemblies"}
 * returns as {"objects","version","assemblies"}. The fake Supabase below
 * stores documents this way, as the real one does.
 */
function jsonbOrder<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map(jsonbOrder) as T;
  }
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value).sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(keys.map((key) => [key, jsonbOrder((value as Record<string, unknown>)[key])])) as T;
  }
  return value;
}

/** ONE_WALL as the shared validator writes it - the canonical bytes every repository must hand back. */
const CANONICAL_ONE_WALL: ProjectDocument = (() => {
  const parsed = parseProjectDocument(ONE_WALL);
  if (!parsed.ok) {
    throw new Error(parsed.error);
  }
  return parsed.document;
})();

const SNAPSHOT: AIProjectSnapshot = {
  wallCount: 0,
  pillarCount: 0,
  beamCount: 0,
  slabCount: 0,
  doorCount: 0,
  windowCount: 0,
  assemblyCount: 0,
  selectedObjectId: null,
  objects: [],
  assemblies: []
};

function recordingProvider(): AIProvider & { calls: AIProviderRequest[] } {
  const calls: AIProviderRequest[] = [];
  return {
    calls,
    interpret: (request) => {
      calls.push(request);
      return { commands: [{ type: "wall.add", wall: {} }] };
    }
  };
}

/** A server with sign-in and project storage in memory - what mockBackend.ts (and LOCAL_AUTH=memory) starts. */
function memoryOptions(): CreateServerOptions {
  return {
    provider: recordingProvider(),
    frontendOrigin: FRONTEND_ORIGIN,
    authService: new InMemoryAuthService(),
    projectStore: new InMemoryProjectStore()
  };
}

async function withServer<T>(options: CreateServerOptions, fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const server = createServer(options);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo | null;
  if (!address || typeof address === "string") {
    throw new Error("Expected the server to bind to a TCP port.");
  }
  try {
    return await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

function memoryStorage(): SessionStorageLike & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    }
  };
}

function storedSession(storage: { map: Map<string, string> }): AuthSession | null {
  return JSON.parse(storage.map.get(SESSION_STORAGE_KEY) ?? "null") as AuthSession | null;
}

/**
 * What the browser app builds (see src/main.ts): an AuthController over
 * HttpAuthClient, and the project and AI clients sending requests through
 * AuthController.authorize() - so they carry the user's token.
 */
function browserStack(baseUrl: string, storage = memoryStorage(), now?: () => number) {
  const authFetch: AuthFetch = (url, init) => fetch(url, init);
  const auth = new AuthController({ client: new HttpAuthClient({ baseUrl, fetch: authFetch }), storage, ...(now ? { now } : {}) });
  const projectFetch: ProjectFetch = auth.authorize((url: string, init: Parameters<ProjectFetch>[1]) => fetch(url, init));
  const aiFetch: BackendFetch = auth.authorize((url: string, init: Parameters<BackendFetch>[1]) => fetch(url, init));
  return {
    auth,
    storage,
    projects: new HttpProjectRepository({ baseUrl, fetch: projectFetch }),
    ai: new BackendAIProvider({ baseUrl, fetch: aiFetch })
  };
}

// --- Supabase test doubles: an injected transport, never a network ---

type RecordedRequest = { url: string; method: string; headers: Record<string, string>; body: unknown };

function respond(status: number, body?: unknown): SupabaseHttpResponse {
  const serialized = body === undefined ? undefined : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      if (serialized === undefined) {
        throw new Error("no body");
      }
      return JSON.parse(serialized) as unknown;
    }
  };
}

/** A transport that records every request and answers with `reply`. */
function recordingSupabase(reply: (request: RecordedRequest) => SupabaseHttpResponse) {
  const requests: RecordedRequest[] = [];
  const fetchImpl: SupabaseFetch = async (url, init) => {
    const request: RecordedRequest = {
      url,
      method: init.method,
      headers: { ...init.headers },
      body: init.body === undefined ? undefined : JSON.parse(init.body)
    };
    requests.push(request);
    return reply(request);
  };
  return { fetch: fetchImpl, requests };
}

type FakeRow = { id: string; user_id: string; name: string; document: ProjectDocument; created_at: string; updated_at: string };

/**
 * A tiny in-process stand-in for a Supabase project: GoTrue's
 * /auth/v1 endpoints and PostgREST's /rest/v1/projects. It enforces what
 * the migration does - the anon role alone gets nothing, and a user only
 * ever sees, inserts, updates and deletes rows whose user_id is their own
 * (Row Level Security) - so the real adapters and the real server can be
 * checked against it end to end.
 */
function createFakeSupabase() {
  const accounts = new Map<string, { id: string; email: string; password: string }>();
  const accessTokens = new Map<string, string>();
  const refreshTokens = new Map<string, string>();
  const rows: FakeRow[] = [];
  const requests: RecordedRequest[] = [];
  let tick = 0;
  const timestamp = () => new Date(Date.UTC(2026, 8, 10, 12, 0, tick++)).toISOString().replace("Z", "+00:00");
  const accountById = (id: string | undefined) => [...accounts.values()].find((account) => account.id === id);

  const issue = (account: { id: string; email: string }) => {
    const access = `jwt-${randomUUID()}`;
    const refresh = `refresh-${randomUUID()}`;
    accessTokens.set(access, account.id);
    refreshTokens.set(refresh, account.id);
    return {
      access_token: access,
      token_type: "bearer",
      expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      refresh_token: refresh,
      user: { id: account.id, email: account.email, role: "authenticated" }
    };
  };

  const columns = (row: FakeRow, select: string | null): Record<string, unknown> => {
    const full: Record<string, unknown> = { ...row, object_count: row.document.objects.length, assembly_count: row.document.assemblies.length };
    return select === null ? full : Object.fromEntries(select.split(",").map((column) => [column, full[column]]));
  };

  const fetchImpl: SupabaseFetch = async (url, init) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = init.body === undefined ? undefined : (JSON.parse(init.body) as Record<string, any>);
    requests.push({ url, method: init.method, headers: { ...init.headers }, body });
    if (init.headers.apikey !== ANON_KEY) {
      return respond(401, { message: "Invalid API key" });
    }
    const { pathname, searchParams } = new URL(url);
    const bearer = init.headers.Authorization?.replace(/^Bearer /, "");
    const uid = bearer === undefined ? undefined : accessTokens.get(bearer);

    if (pathname === "/auth/v1/signup") {
      if (accounts.has(body?.email)) {
        return respond(422, { code: 422, error_code: "user_already_exists", msg: "User already registered" });
      }
      const account = { id: randomUUID(), email: String(body?.email), password: String(body?.password) };
      accounts.set(account.email, account);
      return respond(200, issue(account));
    }
    if (pathname === "/auth/v1/token") {
      if (searchParams.get("grant_type") === "password") {
        const account = accounts.get(body?.email);
        return account && account.password === body?.password
          ? respond(200, issue(account))
          : respond(400, { code: 400, error_code: "invalid_credentials", msg: "Invalid login credentials" });
      }
      const account = accountById(refreshTokens.get(body?.refresh_token));
      if (!account) {
        return respond(400, { code: 400, error_code: "refresh_token_not_found", msg: "Invalid Refresh Token: Refresh Token Not Found" });
      }
      refreshTokens.delete(body?.refresh_token);
      return respond(200, issue(account));
    }
    if (pathname === "/auth/v1/user") {
      const account = accountById(uid);
      return account ? respond(200, { id: account.id, email: account.email, role: "authenticated" }) : respond(403, { code: 403, error_code: "bad_jwt", msg: "invalid JWT" });
    }
    if (pathname === "/auth/v1/logout") {
      if (bearer !== undefined) {
        accessTokens.delete(bearer);
        for (const [token, owner] of refreshTokens) {
          if (owner === uid) {
            refreshTokens.delete(token);
          }
        }
      }
      return respond(204);
    }
    if (pathname === "/rest/v1/projects") {
      if (uid === undefined) {
        // No signed-in user: the anon role has no grants on this table.
        return respond(401, { code: "42501", message: "permission denied for table projects" });
      }
      // Row Level Security: (select auth.uid()) = user_id.
      const idFilter = searchParams.get("id");
      const visible = rows.filter((row) => row.user_id === uid && (idFilter === null || idFilter === `eq.${row.id}`));
      const select = searchParams.get("select");
      switch (init.method) {
        case "GET":
          return respond(
            200,
            [...visible].sort((a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0)).map((row) => columns(row, select))
          );
        case "POST": {
          if (body?.user_id !== uid) {
            return respond(403, { code: "42501", message: 'new row violates row-level security policy for table "projects"' });
          }
          const stamp = timestamp();
          const row: FakeRow = { id: randomUUID(), user_id: uid, name: body.name, document: jsonbOrder(body.document), created_at: stamp, updated_at: stamp };
          rows.push(row);
          return respond(201, [columns(row, select)]);
        }
        case "PATCH":
          for (const row of visible) {
            row.name = body?.name;
            row.document = jsonbOrder(body?.document);
            row.updated_at = timestamp();
          }
          return respond(200, visible.map((row) => columns(row, select)));
        case "DELETE":
          for (const row of visible) {
            rows.splice(rows.indexOf(row), 1);
          }
          return respond(200, visible.map((row) => columns(row, select)));
      }
    }
    return respond(404, { message: "not found" });
  };

  return { fetch: fetchImpl, requests, rows };
}

async function run(): Promise<void> {
  let passed = 0;
  let failed = 0;

  async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
    try {
      await fn();
      passed += 1;
      console.log(`  ok - ${name}`);
    } catch (error) {
      failed += 1;
      console.error(`  FAIL - ${name}`);
      console.error(error);
    }
  }

  console.log("Accounts, sessions and project ownership verification\n");

  // --- Accounts and sessions: the real browser classes against the real server ---

  await check("sign up creates an account and signs straight in - the browser keeps the session, and the server knows whose it is", async () => {
    await withServer(memoryOptions(), async (baseUrl) => {
      const { auth, storage } = browserStack(baseUrl);
      await auth.start();
      assertEqual(auth.getState().status, "signed-out", "starts signed out");

      assertTrue(await auth.signUp("  Alice@Example.com ", PASSWORD), `signed up: ${auth.getState().message}`);
      assertEqual(auth.getState().status, "signed-in", "signed in");
      const user = auth.getState().user;
      assertEqual(user?.email, "alice@example.com", "the email is trimmed and lower-cased");
      const session = storedSession(storage);
      assertEqual(session?.user.id, user?.id, "the session is stored for the next page load");

      const res = await fetch(`${baseUrl}/api/auth/session`, { headers: { Authorization: `Bearer ${session?.accessToken}` } });
      assertEqual(res.status, 200, "the server accepts the token");
      assertDeepEqual(await res.json(), { user }, "and says whose it is");

      const again = browserStack(baseUrl);
      assertEqual(await again.auth.signUp("alice@example.com", PASSWORD), false, "the same email can't sign up twice");
      assertTrue(again.auth.getState().message?.includes("already exists"), `and is told so: ${again.auth.getState().message}`);
    });
  });

  await check("sign in: the right password signs in; a wrong password and an unknown email get the same refusal, and nothing is stored", async () => {
    await withServer(memoryOptions(), async (baseUrl) => {
      const setup = browserStack(baseUrl);
      assertTrue(await setup.auth.signUp("frank@example.com", PASSWORD), "account created");
      await setup.auth.signOut();

      const { auth, storage } = browserStack(baseUrl);
      await auth.start();
      assertEqual(await auth.signIn("frank@example.com", "wrong password!"), false, "a wrong password");
      assertEqual(auth.getState().message, "Wrong email or password.", "is refused");
      assertEqual(await auth.signIn("nobody@example.com", PASSWORD), false, "an unknown email");
      assertEqual(auth.getState().message, "Wrong email or password.", "gets the same refusal - accounts aren't revealed");
      assertEqual(storage.map.size, 0, "nothing stored");

      assertTrue(await auth.signIn("FRANK@example.com", PASSWORD), "the right password, in any email case");
      assertEqual(auth.getState().user?.email, "frank@example.com", "signed in as Frank");
      assertEqual(storage.map.size, 1, "the session is stored");
    });
  });

  await check("sign out ends the session on the server as well as in the browser", async () => {
    await withServer(memoryOptions(), async (baseUrl) => {
      const { auth, storage, projects } = browserStack(baseUrl);
      await auth.signUp("grace@example.com", PASSWORD);
      const session = storedSession(storage);
      assertTrue(session, "signed in");

      await auth.signOut();
      assertEqual(auth.getState().status, "signed-out", "signed out");
      assertEqual(auth.getState().message, "Signed out.", "message");
      assertEqual(storage.map.size, 0, "storage cleared");
      const check = await fetch(`${baseUrl}/api/auth/session`, { headers: { Authorization: `Bearer ${session.accessToken}` } });
      assertEqual(check.status, 401, "the old access token no longer works");
      const refresh = await fetch(`${baseUrl}/api/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken: session.refreshToken })
      });
      assertEqual(refresh.status, 401, "nor does its refresh token");
      await assertRejects(
        () => projects.list(),
        (error) => error instanceof ProjectAuthError && error.message === SIGN_IN_FOR_PROJECTS,
        "project requests are refused as signed out"
      );
    });
  });

  await check("current session: a reload restores it from storage and the server confirms it; one the server no longer knows signs out cleanly", async () => {
    const storage = memoryStorage();
    await withServer(memoryOptions(), async (baseUrl) => {
      const first = browserStack(baseUrl, storage);
      await first.auth.signUp("carol@example.com", PASSWORD);

      const reloaded = browserStack(baseUrl, storage);
      assertEqual(reloaded.auth.getState().status, "restoring", "restoring until started");
      await reloaded.auth.start();
      assertEqual(reloaded.auth.getState().status, "signed-in", "signed in again without a password");
      assertEqual(reloaded.auth.getState().user?.email, "carol@example.com", "as Carol");
      assertDeepEqual(await reloaded.projects.list(), [], "and the project routes accept the session");
    });

    // A restarted in-memory server has forgotten every session.
    await withServer(memoryOptions(), async (baseUrl) => {
      const reloaded = browserStack(baseUrl, storage);
      await reloaded.auth.start();
      assertEqual(reloaded.auth.getState().status, "signed-out", "signed out");
      assertEqual(reloaded.auth.getState().message, EXPIRED, "and told why");
      assertEqual(storage.map.size, 0, "the stale session is gone");
    });
  });

  await check("an expiring session is refreshed before a request, transparently; once the session has ended, requests fail as signed out and the user is told", async () => {
    let clock = 1_800_000_000_000;
    const now = () => clock;
    const options = { ...memoryOptions(), authService: new InMemoryAuthService({ now, accessTokenTtlMs: 10 * 60_000 }) };
    await withServer(options, async (baseUrl) => {
      const { auth, storage, projects } = browserStack(baseUrl, memoryStorage(), now);
      await auth.signUp("erin@example.com", PASSWORD);
      const firstToken = storedSession(storage)?.accessToken;
      await projects.create({ name: "Before expiry", document: EMPTY });

      clock += 11 * 60_000;
      assertEqual((await projects.list()).length, 1, "the request after expiry succeeds");
      const secondToken = storedSession(storage)?.accessToken;
      assertTrue(secondToken !== undefined && secondToken !== firstToken, "with a refreshed token, now stored");
      assertEqual(auth.getState().status, "signed-in", "still signed in");

      // The session is ended elsewhere: the request is refused, the refresh fails, and the user is signed out.
      await fetch(`${baseUrl}/api/auth/signout`, { method: "POST", headers: { Authorization: `Bearer ${secondToken}` } });
      await assertRejects(
        () => projects.list(),
        (error) => error instanceof ProjectAuthError && error.message === EXPIRED,
        "the request fails as signed out"
      );
      assertEqual(auth.getState().status, "signed-out", "the user is signed out");
      assertEqual(auth.getState().message, EXPIRED, "and told their session expired");
      assertEqual(storage.map.size, 0, "the stale session is removed");
    });
  });

  // --- Every project request is authenticated, and scoped to its user ---

  await check("every project route requires a valid session - no token, a garbage or non-Bearer token, or an expired one get 401, and storage is never reached", async () => {
    let clock = 1_800_000_000_000;
    let reached = 0;
    const inner = new InMemoryProjectStore();
    const projectStore: ProjectStore = {
      forUser: (user) => {
        reached += 1;
        return inner.forUser(user);
      }
    };
    const options = { ...memoryOptions(), authService: new InMemoryAuthService({ now: () => clock, accessTokenTtlMs: 60_000 }), projectStore };
    await withServer(options, async (baseUrl) => {
      const signup = await fetch(`${baseUrl}/api/auth/signup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "ivan@example.com", password: PASSWORD })
      });
      const { session } = (await signup.json()) as { session: AuthSession };
      clock += 61_000;

      const routes: [string, string][] = [
        ["GET", "/api/projects"],
        ["POST", "/api/projects"],
        ["GET", `/api/projects/${PROJECT_ID}`],
        ["PUT", `/api/projects/${PROJECT_ID}`],
        ["DELETE", `/api/projects/${PROJECT_ID}`]
      ];
      const credentials: [string, Record<string, string>, string][] = [
        ["no token", {}, SIGN_IN_FOR_PROJECTS],
        ["a garbage token", { Authorization: "Bearer not-a-real-token" }, EXPIRED],
        ["a non-Bearer scheme", { Authorization: `Basic ${Buffer.from("ivan:password").toString("base64")}` }, SIGN_IN_FOR_PROJECTS],
        ["an expired token", { Authorization: `Bearer ${session.accessToken}` }, EXPIRED]
      ];
      const body = JSON.stringify({ name: "X", document: EMPTY });
      for (const [method, path] of routes) {
        for (const [label, headers, message] of credentials) {
          const res = await fetch(`${baseUrl}${path}`, {
            method,
            headers: { "Content-Type": "application/json", ...headers },
            ...(method === "POST" || method === "PUT" ? { body } : {})
          });
          assertEqual(res.status, 401, `${method} ${path} with ${label}`);
          assertEqual(res.headers.get("www-authenticate"), "Bearer", `${method} ${path} with ${label}: a Bearer challenge`);
          assertDeepEqual(await res.json(), { error: message, code: "unauthorized" }, `${method} ${path} with ${label}: body`);
        }
      }
    });
    assertEqual(reached, 0, "no unauthenticated request ever reached project storage");
  });

  await check("ownership: each user lists, opens, saves and deletes only their own projects - another user's answers exactly like a missing one", async () => {
    await withServer(memoryOptions(), async (baseUrl) => {
      const alice = browserStack(baseUrl);
      const bob = browserStack(baseUrl);
      assertTrue(await alice.auth.signUp("alice@example.com", PASSWORD), "Alice signed up");
      assertTrue(await bob.auth.signUp("bob@example.com", PASSWORD), "Bob signed up");

      const aliceProject = await alice.projects.create({ name: "Alice's House", document: ONE_WALL });
      const bobProject = await bob.projects.create({ name: "Bob's Shed", document: EMPTY });
      assertEqual(aliceProject.ownerId, alice.auth.getState().user?.id, "Alice owns hers");
      assertEqual(bobProject.ownerId, bob.auth.getState().user?.id, "Bob owns his");
      assertDeepEqual((await alice.projects.list()).map((summary) => summary.name), ["Alice's House"], "Alice lists only hers");
      assertDeepEqual((await bob.projects.list()).map((summary) => summary.name), ["Bob's Shed"], "Bob lists only his");

      assertEqual(await bob.projects.get(aliceProject.id), null, "Bob can't open Alice's project");
      await assertRejects(
        () => bob.projects.save(aliceProject.id, { name: "Mine now", document: EMPTY }),
        (error) => error instanceof ProjectNotFoundError,
        "or overwrite it"
      );
      await assertRejects(() => bob.projects.delete(aliceProject.id), (error) => error instanceof ProjectNotFoundError, "or delete it");
      assertDeepEqual(await alice.projects.get(aliceProject.id), aliceProject, "Alice's project is untouched");

      const bobToken = storedSession(bob.storage)?.accessToken;
      const probe = async (id: string) => {
        const res = await fetch(`${baseUrl}/api/projects/${id}`, { headers: { Authorization: `Bearer ${bobToken}` } });
        return [res.status, ((await res.json()) as { error: string }).error.replace(id, "<id>")];
      };
      assertDeepEqual(await probe(aliceProject.id), await probe(randomUUID()), "someone else's project and a missing one get the same answer");

      await alice.projects.delete(aliceProject.id);
      assertDeepEqual((await bob.projects.list()).map((summary) => summary.name), ["Bob's Shed"], "Alice deleting hers leaves Bob's alone");
    });
  });

  await check("a storage failure answers 500 with no details, and the server's log never contains the user's token", async () => {
    const broken = async (): Promise<never> => {
      throw new Error("connection to the database was lost");
    };
    const projectStore: ProjectStore = { forUser: () => ({ create: broken, save: broken, get: broken, list: broken, delete: broken }) };
    const logged: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    };
    let token = "";
    try {
      await withServer({ ...memoryOptions(), projectStore }, async (baseUrl) => {
        const { auth, storage, projects } = browserStack(baseUrl);
        await auth.signUp("henry@example.com", PASSWORD);
        token = storedSession(storage)?.accessToken ?? "";
        const res = await fetch(`${baseUrl}/api/projects`, { headers: { Authorization: `Bearer ${token}` } });
        assertEqual(res.status, 500, "status");
        assertDeepEqual(await res.json(), { error: "Project storage failed." }, "no internal details");
        await assertRejects(
          () => projects.list(),
          (error) => error instanceof Error && !(error instanceof ProjectAuthError) && error.message.includes("status 500"),
          "the client reports a server failure, not a sign-in problem"
        );
      });
    } finally {
      console.error = originalError;
    }
    assertTrue(logged.some((line) => line.includes("connection to the database was lost")), "the failure is logged");
    assertTrue(token.length > 0 && !logged.some((line) => line.includes(token)), "without the user's token");
  });

  await check("with sign-in configured, the AI endpoint requires a signed-in user - a signed-out request never reaches the provider", async () => {
    const provider = recordingProvider();
    await withServer({ ...memoryOptions(), provider }, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/ai/interpret`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instruction: "Add a wall", projectContext: SNAPSHOT })
      });
      assertEqual(res.status, 401, "signed out");
      assertDeepEqual(await res.json(), { error: "Sign in to use the AI assistant.", code: "unauthorized" }, "body");
      assertEqual(provider.calls.length, 0, "the provider was never called");

      const { auth, ai } = browserStack(baseUrl);
      await auth.signUp("ivy@example.com", PASSWORD);
      const response = await ai.interpret({
        instruction: "Add a wall",
        projectContext: buildAIProjectContext(SNAPSHOT),
        availableObjectTypes: AI_SUPPORTED_OBJECT_TYPES
      });
      assertDeepEqual(response.commands, [{ type: "wall.add", wall: {} }], "signed in, the request is relayed");
      assertEqual(provider.calls.length, 1, "exactly once");
    });
  });

  await check("auth routes: bad credentials 400, huge bodies 413, unknown routes 404, wrong methods 405, no sign-in configured 501; responses are never cached", async () => {
    await withServer(memoryOptions(), async (baseUrl) => {
      const post = (path: string, body: unknown) =>
        fetch(`${baseUrl}${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: typeof body === "string" ? body : JSON.stringify(body)
        });
      const invalid: [unknown, string][] = [
        [{ email: "not-an-email", password: PASSWORD }, "valid email"],
        [{ email: "jo@example.com", password: "short" }, "at least 8"],
        [{ email: "jo@example.com", password: "x".repeat(73) }, "at most 72"],
        [{ email: "jo@example.com" }, '"email" and a "password"'],
        ["not json", "not valid JSON"]
      ];
      for (const path of ["/api/auth/signup", "/api/auth/signin"]) {
        for (const [body, fragment] of invalid) {
          const res = await post(path, body);
          assertEqual(res.status, 400, `${path} ${JSON.stringify(body).slice(0, 40)}`);
          const { error } = (await res.json()) as { error: string };
          assertTrue(error.includes(fragment), `expected "${fragment}", got "${error}"`);
        }
      }
      assertEqual((await post("/api/auth/signin", { email: "jo@example.com", password: "x".repeat(20_000) })).status, 413, "a huge body");
      assertEqual((await post("/api/auth/refresh", {})).status, 400, "refresh without a token");
      assertEqual((await post("/api/auth/refresh", { refreshToken: "never-issued" })).status, 401, "refresh with an unknown token");
      assertEqual((await fetch(`${baseUrl}/api/auth/signin`)).status, 405, "GET on sign-in");
      assertEqual((await post("/api/auth/session", {})).status, 405, "POST on the session check");
      assertEqual((await fetch(`${baseUrl}/api/auth/nope`)).status, 404, "an unknown auth route");
      assertEqual((await fetch(`${baseUrl}/api/auth/session`)).status, 401, "the session check, signed out");
      assertEqual((await post("/api/auth/signout", {})).status, 401, "sign-out without a token");
      const signup = await post("/api/auth/signup", { email: "jo@example.com", password: PASSWORD });
      assertEqual(signup.status, 201, "a valid sign-up");
      assertEqual(signup.headers.get("cache-control"), "no-store", "a response carrying tokens is never cached");
    });
    await withServer({ provider: recordingProvider(), frontendOrigin: FRONTEND_ORIGIN }, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/auth/signin`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "jo@example.com", password: PASSWORD })
      });
      assertEqual(res.status, 501, "no sign-in configured");
    });
  });

  // --- The Supabase adapters (a mocked transport - never a real Supabase project) ---

  await check("SupabaseAuthService speaks Supabase Auth's REST API with the anon key - a user's token only on that user's own requests", async () => {
    let reply: () => SupabaseHttpResponse = () => respond(500);
    const supabase = recordingSupabase(() => reply());
    const service = new SupabaseAuthService({ url: `${SUPABASE_URL}/`, anonKey: ANON_KEY, fetch: supabase.fetch, now: () => 1_000_000 });
    const gotrueSession = {
      access_token: "jwt-alice",
      token_type: "bearer",
      expires_in: 3600,
      expires_at: 1_790_000_000,
      refresh_token: "refresh-alice",
      user: { id: USER_ID, email: "alice@example.com", role: "authenticated", aud: "authenticated" }
    };
    const expected = { accessToken: "jwt-alice", refreshToken: "refresh-alice", expiresAt: 1_790_000_000_000, user: { id: USER_ID, email: "alice@example.com" } };

    reply = () => respond(200, gotrueSession);
    assertDeepEqual(await service.signIn("alice@example.com", PASSWORD), expected, "sign in -> our session shape (expires_at is in seconds)");
    assertDeepEqual(await service.signUp("alice@example.com", PASSWORD), { session: expected }, "sign up, with email confirmation off, signs straight in");
    reply = () => respond(200, { ...gotrueSession, expires_at: undefined });
    assertEqual((await service.refresh("refresh-alice")).expiresAt, 1_000_000 + 3_600_000, "refresh - from expires_in when there's no expires_at");
    reply = () => respond(200, { id: USER_ID, email: "alice@example.com", role: "authenticated" });
    assertDeepEqual(await service.getUser("jwt-alice"), { id: USER_ID, email: "alice@example.com" }, "the token's user");
    reply = () => respond(204);
    await service.signOut("jwt-alice");
    reply = () => respond(200, { id: USER_ID, email: "new@example.com", confirmation_sent_at: "2026-09-10T12:00:00Z" });
    assertDeepEqual(
      await service.signUp("new@example.com", PASSWORD),
      { confirmationRequired: true, email: "new@example.com" },
      "with email confirmation on, the user is asked to confirm first"
    );

    assertDeepEqual(
      supabase.requests.map((request) => `${request.method} ${request.url}`),
      [
        `POST ${SUPABASE_URL}/auth/v1/token?grant_type=password`,
        `POST ${SUPABASE_URL}/auth/v1/signup`,
        `POST ${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`,
        `GET ${SUPABASE_URL}/auth/v1/user`,
        `POST ${SUPABASE_URL}/auth/v1/logout`,
        `POST ${SUPABASE_URL}/auth/v1/signup`
      ],
      "endpoints"
    );
    assertDeepEqual(
      supabase.requests.map((request) => request.body ?? null),
      [
        { email: "alice@example.com", password: PASSWORD },
        { email: "alice@example.com", password: PASSWORD },
        { refresh_token: "refresh-alice" },
        null,
        null,
        { email: "new@example.com", password: PASSWORD }
      ],
      "bodies"
    );
    assertTrue(supabase.requests.every((request) => request.headers.apikey === ANON_KEY), "every request carries the anon key");
    assertDeepEqual(
      supabase.requests.map((request) => request.headers.Authorization ?? null),
      [null, null, null, "Bearer jwt-alice", "Bearer jwt-alice", null],
      "a user token only on the user's own requests - never the anon key as a token"
    );
  });

  await check("SupabaseAuthService turns Supabase's errors into short messages with the right statuses", async () => {
    let reply: () => SupabaseHttpResponse = () => respond(500);
    const service = new SupabaseAuthService({ url: SUPABASE_URL, anonKey: ANON_KEY, fetch: recordingSupabase(() => reply()).fetch });
    const signIn = () => service.signIn("a@example.com", PASSWORD);
    const signUp = () => service.signUp("a@example.com", PASSWORD);
    const cases: [string, () => Promise<unknown>, SupabaseHttpResponse, number, string][] = [
      ["a wrong password", signIn, respond(400, { code: 400, error_code: "invalid_credentials", msg: "Invalid login credentials" }), 401, "Wrong email or password."],
      ["a wrong password (older servers)", signIn, respond(400, { error: "invalid_grant", error_description: "Invalid login credentials" }), 401, "Wrong email or password."],
      ["an unconfirmed email", signIn, respond(400, { code: 400, error_code: "email_not_confirmed", msg: "Email not confirmed" }), 401, "Confirm your email address first"],
      ["an email already registered", signUp, respond(422, { code: 422, error_code: "user_already_exists", msg: "User already registered" }), 409, "already exists"],
      ["a weak password", signUp, respond(422, { code: 422, error_code: "weak_password", msg: "Password should contain at least one digit." }), 400, "at least one digit"],
      ["rate limiting", signIn, respond(429, { msg: "Too many requests" }), 429, "Too many attempts"],
      ["Supabase failing", signIn, respond(503, { message: "upstream error" }), 502, "unavailable"],
      ["a spent refresh token", () => service.refresh("refresh-x"), respond(400, { error_code: "refresh_token_not_found", msg: "Invalid Refresh Token" }), 401, EXPIRED],
      ["an invalid token", () => service.getUser("jwt-x"), respond(403, { error_code: "bad_jwt", msg: "invalid JWT" }), 401, EXPIRED],
      ["a malformed user", () => service.getUser("jwt-x"), respond(200, { id: 5 }), 502, "malformed"],
      ["a malformed session", signIn, respond(200, { access_token: "x" }), 502, "malformed"]
    ];
    for (const [name, operation, response, status, fragment] of cases) {
      reply = () => response;
      await assertRejects(
        operation,
        (error) => error instanceof AuthError && error.status === status && error.message.includes(fragment),
        name
      );
    }
    const unreachable = new SupabaseAuthService({
      url: SUPABASE_URL,
      anonKey: ANON_KEY,
      fetch: async () => {
        throw new Error("getaddrinfo ENOTFOUND example-project.supabase.co");
      }
    });
    await assertRejects(
      () => unreachable.signIn("a@example.com", PASSWORD),
      (error) => error instanceof AuthError && error.status === 502 && error.message.includes("Could not reach the sign-in service"),
      "no connection"
    );
  });

  await check("SupabaseProjectRepository sends the anon key AND the user's own token to PostgREST, maps rows, and treats an empty result as not found", async () => {
    let reply: () => SupabaseHttpResponse = () => respond(200, []);
    const supabase = recordingSupabase(() => reply());
    const repository = new SupabaseProjectRepository({
      url: `${SUPABASE_URL}/`,
      anonKey: ANON_KEY,
      fetch: supabase.fetch,
      userId: USER_ID,
      accessToken: "jwt-alice"
    });
    const row = {
      id: PROJECT_ID,
      user_id: USER_ID,
      name: "Shed",
      created_at: "2026-09-10T12:00:00.123456+00:00",
      updated_at: "2026-09-10T12:00:05+00:00",
      // As PostgreSQL returns it: jsonb has reordered every key.
      document: jsonbOrder(ONE_WALL)
    };
    assertTrue(JSON.stringify(row.document) !== JSON.stringify(CANONICAL_ONE_WALL), "precondition: the stored key order differs from the canonical one");
    const record = {
      id: PROJECT_ID,
      ownerId: USER_ID,
      name: "Shed",
      createdAt: "2026-09-10T12:00:00.123Z",
      updatedAt: "2026-09-10T12:00:05.000Z",
      document: CANONICAL_ONE_WALL
    };

    reply = () => respond(201, [row]);
    assertDeepEqual(
      await repository.create({ name: "Shed", document: ONE_WALL }),
      record,
      "create returns the row as a ProjectRecord - ISO timestamps, and the document back in canonical key order"
    );
    reply = () => respond(200, [row]);
    assertDeepEqual(await repository.get(PROJECT_ID), record, "get");
    assertDeepEqual(await repository.save(PROJECT_ID, { name: "Shed", document: ONE_WALL }), record, "save");
    reply = () => respond(200, [{ id: PROJECT_ID }]);
    await repository.delete(PROJECT_ID);
    reply = () =>
      respond(200, [{ id: PROJECT_ID, name: "Shed", created_at: row.created_at, updated_at: row.updated_at, object_count: 1, assembly_count: 1 }]);
    assertDeepEqual(
      await repository.list(),
      [{ id: PROJECT_ID, name: "Shed", createdAt: record.createdAt, updatedAt: record.updatedAt, objectCount: 1, assemblyCount: 1 }],
      "list"
    );

    const base = `${SUPABASE_URL}/rest/v1/projects`;
    const columns = "id,user_id,name,created_at,updated_at,document";
    assertDeepEqual(
      supabase.requests.map((request) => `${request.method} ${request.url}`),
      [
        `POST ${base}?select=${columns}`,
        `GET ${base}?id=eq.${PROJECT_ID}&select=${columns}`,
        `PATCH ${base}?id=eq.${PROJECT_ID}&select=${columns}`,
        `DELETE ${base}?id=eq.${PROJECT_ID}&select=id`,
        `GET ${base}?select=id,name,created_at,updated_at,object_count,assembly_count&order=updated_at.desc,name.asc`
      ],
      "PostgREST requests"
    );
    assertDeepEqual(supabase.requests[0].body, { user_id: USER_ID, name: "Shed", document: ONE_WALL }, "an insert names its owner - the policy checks it is the token's user");
    assertDeepEqual(supabase.requests[2].body, { name: "Shed", document: ONE_WALL }, "an update never sends an owner");
    for (const request of supabase.requests) {
      assertEqual(request.headers.apikey, ANON_KEY, `${request.method}: the anon key`);
      assertEqual(request.headers.Authorization, "Bearer jwt-alice", `${request.method}: the user's own token, so Row Level Security applies`);
    }
    assertDeepEqual(
      supabase.requests.map((request) => request.headers.Prefer ?? null),
      ["return=representation", null, "return=representation", "return=representation", null],
      "writes ask for the affected rows back"
    );

    // Row Level Security hides other users' rows: an empty result.
    reply = () => respond(200, []);
    assertEqual(await repository.get(PROJECT_ID), null, "no row -> null");
    await assertRejects(() => repository.save(PROJECT_ID, { name: "X", document: EMPTY }), (error) => error instanceof ProjectNotFoundError, "no row updated -> not found");
    await assertRejects(() => repository.delete(PROJECT_ID), (error) => error instanceof ProjectNotFoundError, "no row deleted -> not found");

    const sent = supabase.requests.length;
    assertEqual(await repository.get("not-a-uuid"), null, "an id that can't exist reads as null");
    await assertRejects(() => repository.save("../etc", { name: "X", document: EMPTY }), (error) => error instanceof ProjectNotFoundError, "can't be saved");
    await assertRejects(() => repository.delete("1 or 1=1"), (error) => error instanceof ProjectNotFoundError, "or deleted");
    await assertRejects(() => repository.create({ name: " ", document: EMPTY }), (error) => error instanceof ProjectValidationError, "a blank name");
    await assertRejects(
      () => repository.create({ name: "X", document: { version: 2 } as unknown as ProjectDocument }),
      (error) => error instanceof ProjectValidationError,
      "an unsupported document version"
    );
    assertEqual(supabase.requests.length, sent, "none of those reached the database");
  });

  await check("SupabaseProjectRepository errors: 401 is a sign-in problem, 400 a rejected project, anything else a storage failure", async () => {
    let reply: () => SupabaseHttpResponse = () => respond(500);
    const repository = new SupabaseProjectRepository({
      url: SUPABASE_URL,
      anonKey: ANON_KEY,
      fetch: recordingSupabase(() => reply()).fetch,
      userId: USER_ID,
      accessToken: "jwt-alice"
    });
    reply = () => respond(401, { code: "PGRST301", message: "JWT expired" });
    await assertRejects(() => repository.list(), (error) => error instanceof ProjectAuthError && error.message === EXPIRED, "401 -> ProjectAuthError");
    reply = () => respond(400, { code: "23514", message: 'new row for relation "projects" violates check constraint "projects_document_check"' });
    await assertRejects(
      () => repository.create({ name: "X", document: EMPTY }),
      (error) => error instanceof ProjectValidationError && error.message.includes("projects_document_check"),
      "400 -> ProjectValidationError"
    );
    reply = () => respond(403, { code: "42501", message: "permission denied for table projects" });
    await assertRejects(
      () => repository.list(),
      (error) => error instanceof Error && !(error instanceof ProjectAuthError) && error.message.includes("403"),
      "403 (misconfigured grants) -> a storage failure, not a sign-in problem"
    );
    reply = () => respond(503, { message: "upstream connect error" });
    await assertRejects(() => repository.list(), (error) => error instanceof ProjectStorageUnavailableError, "a gateway error -> storage unavailable (503)");
    reply = () => respond(200, { not: "a list" });
    await assertRejects(() => repository.list(), (error) => error instanceof Error && error.message.includes("malformed"), "a malformed response");
    const unreachable = new SupabaseProjectRepository({
      url: SUPABASE_URL,
      anonKey: ANON_KEY,
      fetch: async () => {
        throw new Error("connect ECONNREFUSED");
      },
      userId: USER_ID,
      accessToken: "jwt-alice"
    });
    await assertRejects(() => unreachable.list(), (error) => error instanceof ProjectStorageUnavailableError, "no connection -> storage unavailable (503)");
  });

  await check("the real server on the Supabase adapters: Row Level Security keeps each user's projects to themselves, with no service-role key anywhere", async () => {
    const supabase = createFakeSupabase();
    const config = { url: SUPABASE_URL, anonKey: ANON_KEY, fetch: supabase.fetch };
    const options: CreateServerOptions = {
      provider: recordingProvider(),
      frontendOrigin: FRONTEND_ORIGIN,
      authService: new SupabaseAuthService(config),
      projectStore: new SupabaseProjectStore(config)
    };
    await withServer(options, async (baseUrl) => {
      const alice = browserStack(baseUrl);
      const bob = browserStack(baseUrl);
      assertTrue(await alice.auth.signUp("alice@example.com", PASSWORD), `Alice signed up: ${alice.auth.getState().message}`);
      assertTrue(await bob.auth.signUp("bob@example.com", PASSWORD), `Bob signed up: ${bob.auth.getState().message}`);
      assertEqual(await bob.auth.signUp("alice@example.com", PASSWORD), false, "an email can't be registered twice");
      assertTrue(await bob.auth.signIn("bob@example.com", PASSWORD), "Bob signs back in");

      const created = await alice.projects.create({ name: "Alice's House", document: ONE_WALL });
      assertEqual(created.ownerId, alice.auth.getState().user?.id, "owned by Alice");
      assertEqual(
        JSON.stringify((await alice.projects.get(created.id))?.document),
        JSON.stringify(CANONICAL_ONE_WALL),
        "the document comes back byte-for-byte canonical - {version, objects, assemblies} - although the database reorders jsonb keys"
      );
      assertTrue(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(created.createdAt), `ISO timestamps, got ${created.createdAt}`);
      const saved = await alice.projects.save(created.id, { name: "Alice's House v2", document: EMPTY });
      assertEqual(saved.createdAt, created.createdAt, "created_at is kept");
      assertTrue(saved.updatedAt > created.updatedAt, "updated_at moves forward");
      await bob.projects.create({ name: "Bob's Shed", document: EMPTY });

      assertDeepEqual((await bob.projects.list()).map((summary) => summary.name), ["Bob's Shed"], "Bob sees only his own project");
      assertEqual(await bob.projects.get(created.id), null, "Bob can't open Alice's project");
      await assertRejects(() => bob.projects.save(created.id, { name: "Mine", document: EMPTY }), (error) => error instanceof ProjectNotFoundError, "or overwrite it");
      await assertRejects(() => bob.projects.delete(created.id), (error) => error instanceof ProjectNotFoundError, "or delete it");
      assertDeepEqual(
        (await alice.projects.list()).map((summary) => [summary.name, summary.objectCount, summary.assemblyCount]),
        [["Alice's House v2", 0, 0]],
        "Alice's project is untouched"
      );

      await alice.auth.signOut();
      await assertRejects(() => alice.projects.list(), (error) => error instanceof ProjectAuthError, "signed out, Alice's requests are refused");
      assertTrue(await alice.auth.signIn("alice@example.com", PASSWORD), "Alice signs back in");
      await alice.projects.delete(created.id);
      assertDeepEqual(supabase.rows.map((row) => row.name), ["Bob's Shed"], "her project is gone from the database; Bob's remains");
    });

    for (const request of supabase.requests) {
      assertEqual(request.headers.apikey, ANON_KEY, `${request.method} ${request.url}: the anon key`);
      assertTrue(!Object.values(request.headers).some((value) => value.includes(SERVICE_ROLE_KEY)), "never a service-role key");
      assertTrue(request.headers.Authorization !== `Bearer ${ANON_KEY}`, "the anon key is never used as a user's token");
      if (request.url.includes("/rest/v1/")) {
        assertTrue(request.headers.Authorization?.startsWith("Bearer jwt-"), `${request.method} ${request.url}: a user's own token`);
      }
    }
  });

  // --- Production behaviour: CORS, request logs, storage outages ---

  await check("CORS: only the configured origins may call the server - any other origin is refused before routing, authentication or storage", async () => {
    let reached = 0;
    const inner = new InMemoryProjectStore();
    const projectStore: ProjectStore = {
      forUser: (user) => {
        reached += 1;
        return inner.forUser(user);
      }
    };
    const allowed = ["https://app.example.com", "http://localhost:5173"];
    await withServer({ ...memoryOptions(), frontendOrigin: allowed, projectStore }, async (baseUrl) => {
      for (const origin of allowed) {
        const preflight = await fetch(`${baseUrl}/api/projects`, { method: "OPTIONS", headers: { Origin: origin, "Access-Control-Request-Method": "GET" } });
        assertEqual(preflight.status, 204, `${origin}: preflight`);
        assertEqual(preflight.headers.get("access-control-allow-origin"), origin, `${origin}: allowed by name - never a wildcard`);
      }
      for (const origin of ["https://evil.example", "https://app.example.com.evil.example", "http://app.example.com", "null"]) {
        const preflight = await fetch(`${baseUrl}/api/projects`, { method: "OPTIONS", headers: { Origin: origin } });
        assertEqual(preflight.status, 403, `${origin}: preflight refused`);
        assertEqual(preflight.headers.get("access-control-allow-origin"), null, `${origin}: no CORS grant`);
        const direct = await fetch(`${baseUrl}/api/projects`, { headers: { Origin: origin, Authorization: "Bearer some-token" } });
        assertEqual(direct.status, 403, `${origin}: a direct request is refused too`);
      }
      const health = await fetch(`${baseUrl}/health`);
      assertEqual(health.status, 200, "a request with no Origin (a health check, curl) is not a browser request and goes through");
      assertEqual(health.headers.get("x-content-type-options"), "nosniff", "nosniff");
      assertDeepEqual(await health.json(), { status: "ok" }, "the health answer carries no configuration or dependency detail");
      const proxied = await fetch(`${baseUrl}/health`, { headers: { "X-Forwarded-Proto": "https" } });
      assertTrue(proxied.headers.get("strict-transport-security")?.includes("max-age="), "HSTS behind an HTTPS proxy");
    });
    assertEqual(reached, 0, "no refused request reached storage");
  });

  await check("request logs: one JSON line per request - route, operation, status, signed-in or not - and never a token, password, email or document", async () => {
    const lines: string[] = [];
    const secrets: string[] = [PASSWORD, "wrong password!", "logged@example.com", "Secret Villa", "wall-3", "forged-token"];
    await withServer({ ...memoryOptions(), requestLog: (line) => lines.push(line) }, async (baseUrl) => {
      const { auth, storage, projects } = browserStack(baseUrl);
      assertTrue(await auth.signUp("logged@example.com", PASSWORD), "signed up");
      const session = storedSession(storage);
      assertTrue(session, "a session");
      secrets.push(session.accessToken, session.refreshToken);
      const created = await projects.create({ name: "Secret Villa", document: ONE_WALL });
      secrets.push(created.id);
      await projects.save(created.id, { name: "Secret Villa", document: ONE_WALL });
      await projects.get(created.id);
      await fetch(`${baseUrl}/api/projects`);
      await fetch(`${baseUrl}/api/projects`, { headers: { Authorization: "Bearer forged-token" } });
      assertEqual(await auth.signIn("logged@example.com", "wrong password!"), false, "a refused sign-in");
    });

    const entries = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    assertDeepEqual(
      entries.map((entry) => `${entry.method} ${entry.route} ${entry.operation} ${entry.status} ${entry.auth}`),
      [
        "POST /api/auth/signup auth.signup 201 user",
        "POST /api/projects projects.create 201 user",
        "PUT /api/projects/:id projects.save 200 user",
        "GET /api/projects/:id projects.get 200 user",
        "GET /api/projects projects.list 401 none",
        "GET /api/projects projects.list 401 invalid",
        "POST /api/auth/signin auth.signin 401 none"
      ],
      "one line per request, ids replaced by :id"
    );
    assertDeepEqual(
      entries.map((entry) => entry.failure ?? null),
      [null, null, null, null, "not signed in", "invalid or expired session", "credentials or session refused"],
      "a short failure reason where there was one"
    );
    assertTrue(entries.every((entry) => typeof entry.time === "string" && typeof entry.ms === "number"), "a time and a duration on every line");
    const text = lines.join("\n");
    for (const secret of secrets) {
      assertTrue(!text.includes(secret), `the log never contains "${secret.slice(0, 12)}…"`);
    }
  });

  await check("storage outage: an unreachable database answers 503 with a try-again message, and the client reports it rather than crashing", async () => {
    const down = async (): Promise<never> => {
      throw new ProjectStorageUnavailableError();
    };
    const projectStore: ProjectStore = { forUser: () => ({ create: down, save: down, get: down, list: down, delete: down }) };
    const logged: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    };
    try {
      await withServer({ ...memoryOptions(), projectStore }, async (baseUrl) => {
        const { auth, projects } = browserStack(baseUrl);
        await auth.signUp("outage@example.com", PASSWORD);
        await assertRejects(
          () => projects.list(),
          (error) =>
            error instanceof Error && !(error instanceof ProjectAuthError) && error.message.includes("503") && error.message.includes("temporarily unavailable"),
          "the client reports the 503 and its reason"
        );
      });
    } finally {
      console.error = originalError;
    }
    assertTrue(logged.some((line) => line.includes("ProjectStorageUnavailableError")), "the outage is logged by name");
  });

  // --- Configuration ---

  await check("config: an OpenAI key and ONE account storage are required; a service-role key is refused; no secret is echoed back", () => {
    const openAI = "sk-test-not-a-real-key";
    const base = { OPENAI_API_KEY: openAI };
    const failures: [string, Record<string, string | undefined>, string][] = [
      ["no OpenAI key", { LOCAL_AUTH: "memory" }, "OPENAI_API_KEY"],
      ["no storage chosen", base, "LOCAL_AUTH=memory"],
      ["only a Supabase URL", { ...base, SUPABASE_URL }, "both SUPABASE_URL and SUPABASE_ANON_KEY"],
      ["only a Supabase key", { ...base, SUPABASE_ANON_KEY: ANON_KEY }, "both SUPABASE_URL and SUPABASE_ANON_KEY"],
      ["a plain-http Supabase URL", { ...base, SUPABASE_URL: "http://example-project.supabase.co", SUPABASE_ANON_KEY: ANON_KEY }, "https://"],
      ["not a URL", { ...base, SUPABASE_URL: "example-project", SUPABASE_ANON_KEY: ANON_KEY }, "not a valid URL"],
      ["a service-role JWT", { ...base, SUPABASE_URL, SUPABASE_ANON_KEY: SERVICE_ROLE_KEY }, "service-role"],
      ["a secret key", { ...base, SUPABASE_URL, SUPABASE_ANON_KEY: "sb_secret_notarealkey" }, "service-role"],
      ["a bad port", { ...base, LOCAL_AUTH: "memory", PORT: "eighty" }, "PORT"],
      ["port zero", { ...base, LOCAL_AUTH: "memory", PORT: "0" }, "PORT"],
      ["a wildcard origin", { ...base, LOCAL_AUTH: "memory", FRONTEND_ORIGIN: "*" }, "wildcards are refused"],
      ["an origin with a path", { ...base, LOCAL_AUTH: "memory", FRONTEND_ORIGIN: "https://app.example.com/editor" }, "no path"],
      ["a plain-http public origin", { ...base, LOCAL_AUTH: "memory", FRONTEND_ORIGIN: "http://app.example.com" }, "https://"],
      ["in-memory accounts in production", { ...base, LOCAL_AUTH: "memory", NODE_ENV: "production" }, "refused when NODE_ENV=production"]
    ];
    for (const [name, env, fragment] of failures) {
      const result = readServerConfig(env);
      assertTrue(!result.ok, `${name}: refused`);
      assertTrue(result.error.includes(fragment), `${name}: expected "${fragment}", got "${result.error}"`);
      for (const secret of [openAI, ANON_KEY, SERVICE_ROLE_KEY, "sb_secret_notarealkey"]) {
        assertTrue(!result.error.includes(secret), `${name}: the message never repeats a key`);
      }
    }

    const memory = readServerConfig({ ...base, LOCAL_AUTH: "memory" });
    assertTrue(memory.ok, "LOCAL_AUTH=memory");
    assertDeepEqual(
      memory.config,
      { openAIApiKey: openAI, port: 8787, frontendOrigins: [FRONTEND_ORIGIN], production: false, storage: { mode: "memory" } },
      "in-memory, with the defaults"
    );

    const hosted = readServerConfig({ ...base, SUPABASE_URL, SUPABASE_ANON_KEY: ANON_KEY, PORT: "9000", FRONTEND_ORIGIN: "https://app.example.com" });
    assertTrue(hosted.ok, "Supabase");
    assertDeepEqual(hosted.config.storage, { mode: "supabase", url: SUPABASE_URL, anonKey: ANON_KEY }, "Supabase, with the anon key");
    assertEqual(hosted.config.port, 9000, "port");
    assertDeepEqual(hosted.config.frontendOrigins, ["https://app.example.com"], "the deployed frontend's origin");
    assertDeepEqual(
      parseFrontendOrigins(" https://app.example.com , http://localhost:5173/ ,https://app.example.com"),
      { ok: true, origins: ["https://app.example.com", "http://localhost:5173"] },
      "a list: trimmed, trailing slash dropped, duplicates removed"
    );
    assertTrue(
      readServerConfig({ ...base, SUPABASE_URL, SUPABASE_ANON_KEY: ANON_KEY, NODE_ENV: "production", FRONTEND_ORIGIN: "https://app.example.com" }).ok,
      "Supabase in production is fine"
    );
    assertTrue(readServerConfig({ ...base, SUPABASE_URL: "http://localhost:54321", SUPABASE_ANON_KEY: ANON_KEY }).ok, "plain http is fine for a local Supabase");
    assertTrue(readServerConfig({ ...base, SUPABASE_URL, SUPABASE_ANON_KEY: "sb_publishable_notarealkey" }).ok, "a publishable key is fine");
    assertTrue(readServerConfig({ ...base, SUPABASE_URL: "", SUPABASE_ANON_KEY: "", LOCAL_AUTH: "memory" }).ok, "blank Supabase values count as unset");

    assertEqual(isPrivilegedSupabaseKey(ANON_KEY), false, "the anon key is not privileged");
    assertEqual(isPrivilegedSupabaseKey(SERVICE_ROLE_KEY), true, "a service-role JWT is");
    assertEqual(isPrivilegedSupabaseKey("sb_secret_x"), true, "so is a secret key");
    assertEqual(isPrivilegedSupabaseKey("not.a-jwt.at-all"), false, "garbage isn't");
  });

  // --- Hosting configuration (read as text) ---

  await check("hosting config: render.yaml and fly.toml build the root Dockerfile and check /health; render.yaml holds no value and leaves PORT to Render; the image never includes a .env file", () => {
    const read = (name: string) => readFileSync(new URL(`../${name}`, import.meta.url), "utf8");

    const render = read("render.yaml");
    assertTrue(/^\s*runtime:\s*docker\s*$/m.test(render), "Render: the Docker runtime");
    assertTrue(/^\s*dockerfilePath:\s*\.\/Dockerfile\s*$/m.test(render), "Render: the root Dockerfile");
    assertTrue(/^\s*dockerContext:\s*\.\s*$/m.test(render), "Render: the repository root as build context");
    assertTrue(/^\s*healthCheckPath:\s*\/health\s*$/m.test(render), "Render: the /health check");
    for (const key of ["OPENAI_API_KEY", "SUPABASE_URL", "SUPABASE_ANON_KEY", "FRONTEND_ORIGIN"]) {
      assertTrue(new RegExp(`-\\s*key:\\s*${key}\\s*\\n\\s*sync:\\s*false\\s*$`, "m").test(render), `render.yaml declares ${key} with sync: false`);
    }
    assertTrue(!/^\s*value:/m.test(render), "render.yaml sets no value at all - Render asks for each");
    assertTrue(!/key:\s*(PORT|LOCAL_AUTH)\b/.test(render), "render.yaml leaves PORT to Render and never enables in-memory accounts");

    const fly = read("fly.toml");
    assertTrue(/dockerfile = "Dockerfile"/.test(fly), "fly.toml: the root Dockerfile");
    assertTrue(/internal_port = 8787/.test(fly) && /path = "\/health"/.test(fly), "fly.toml: port and /health check kept");

    const dockerfile = read("Dockerfile");
    assertDeepEqual(
      [...dockerfile.matchAll(/^COPY\s+(\S+)/gm)].map((match) => match[1]),
      ["package.json", "backend/package.json", "backend/src", "src/engine"],
      "the image copies only these paths"
    );
    assertTrue(/^ENV NODE_ENV=production\s*$/m.test(dockerfile), "the image runs in production mode");
    assertTrue(/^CMD \["node", "backend\/src\/server\.ts"\]\s*$/m.test(dockerfile), "the image starts the server");
    const dockerignore = read(".dockerignore");
    assertTrue(/^\*\*\/\.env\s*$/m.test(dockerignore) && /^\*\*\/\.env\.\*\s*$/m.test(dockerignore), ".dockerignore excludes every .env file");
  });

  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) {
    throw new Error(`${failed} verification check(s) failed`);
  }
}

// See src/engine/ai/verify.ts's matching comment for why this rethrows
// instead of setting `process.exitCode`.
run().catch((error) => {
  console.error(error);
  throw error;
});
