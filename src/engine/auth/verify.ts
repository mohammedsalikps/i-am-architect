/**
 * Verification for the browser's authentication layer - the credential
 * and session rules in types.ts, HttpAuthClient's wire contract, and
 * AuthController's sign-in state, session storage, refresh and retry.
 * Same approach as every other verify.ts: no test framework, plain
 * assertion helpers, run directly by Node. Run with:
 *   npm run verify
 *
 * No server and no network: the client talks to a mock transport and the
 * controller to a stub AuthClient. backend/auth.verify.ts runs these same
 * classes against the real server.
 *
 * Explicit .ts extensions below are required for Node to resolve these
 * relative imports (see allowImportingTsExtensions in tsconfig.json).
 */
import { AuthRequestError, credentialsProblem, parseSession } from "./types.ts";
import type { AuthClient, AuthSession, AuthUser } from "./types.ts";
import { HttpAuthClient } from "./HttpAuthClient.ts";
import type { AuthFetch, AuthHttpResponse } from "./HttpAuthClient.ts";
import { AuthController, SESSION_STORAGE_KEY } from "./AuthController.ts";
import type { SessionStorageLike } from "./AuthController.ts";

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

function assertSameJson(actual: unknown, expected: unknown, message: string): void {
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

function makeDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const NOW = 1_800_000_000_000;
const HOUR = 60 * 60 * 1000;
const USER: AuthUser = { id: "user-1", email: "ada@example.com" };
const EXPIRED = "Your session expired - sign in again.";

function sessionFor(name: string, expiresAt: number, user: AuthUser = USER): AuthSession {
  return { accessToken: `access-${name}`, refreshToken: `refresh-${name}`, expiresAt, user };
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
  const raw = storage.map.get(SESSION_STORAGE_KEY);
  return raw === undefined ? null : parseSession(JSON.parse(raw));
}

/** An AuthClient that records every call and throws on any call a test didn't set up. */
function stubClient(overrides: Partial<AuthClient> = {}): AuthClient & { calls: string[] } {
  const calls: string[] = [];
  const unexpected =
    (name: string) =>
    async (): Promise<never> => {
      throw new Error(`unexpected ${name} call`);
    };
  const impl: AuthClient = {
    signUp: overrides.signUp ?? unexpected("signUp"),
    signIn: overrides.signIn ?? unexpected("signIn"),
    refresh: overrides.refresh ?? unexpected("refresh"),
    signOut: overrides.signOut ?? unexpected("signOut"),
    getUser: overrides.getUser ?? unexpected("getUser")
  };
  return {
    calls,
    signUp: (email, password) => {
      calls.push(`signUp ${email}`);
      return impl.signUp(email, password);
    },
    signIn: (email, password) => {
      calls.push(`signIn ${email}`);
      return impl.signIn(email, password);
    },
    refresh: (token) => {
      calls.push(`refresh ${token}`);
      return impl.refresh(token);
    },
    signOut: (token) => {
      calls.push(`signOut ${token}`);
      return impl.signOut(token);
    },
    getUser: (token) => {
      calls.push(`getUser ${token}`);
      return impl.getUser(token);
    }
  };
}

/** A controller that starts from `session` in storage - as after a page reload. */
async function restoredController(session: AuthSession, overrides: Partial<AuthClient> = {}, now: () => number = () => NOW) {
  const storage = memoryStorage();
  storage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
  const client = stubClient({ getUser: async () => session.user, ...overrides });
  const controller = new AuthController({ client, storage, now });
  await controller.start();
  return { controller, client, storage };
}

function response(status: number, body?: unknown): AuthHttpResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      if (body === undefined) {
        throw new Error("no body");
      }
      return JSON.parse(JSON.stringify(body)) as unknown;
    }
  };
}

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };

function mockAuthFetch(handler: (call: Call) => AuthHttpResponse): AuthFetch & { calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl: AuthFetch = async (url, init) => {
    const call: Call = { url, method: init.method, headers: { ...init.headers }, body: init.body === undefined ? undefined : JSON.parse(init.body) };
    calls.push(call);
    return handler(call);
  };
  return Object.assign(fetchImpl, { calls });
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

  console.log("Authentication verification\n");

  // --- The rules ---

  await check("credentials: a valid email and 8 to 72 bytes of password - the same rule the backend enforces", () => {
    assertEqual(credentialsProblem("ada@example.com", "12345678"), null, "valid");
    assertEqual(credentialsProblem("  ada@example.com  ", "12345678"), null, "surrounding spaces are ignored");
    assertEqual(credentialsProblem("ada", "12345678"), "Enter a valid email address.", "no @");
    assertEqual(credentialsProblem("a b@example.com", "12345678"), "Enter a valid email address.", "a space");
    assertEqual(credentialsProblem(`${"a".repeat(250)}@example.com`, "12345678"), "Enter a valid email address.", "too long");
    assertEqual(credentialsProblem("ada@example.com", "1234567"), "Use a password of at least 8 characters.", "too short");
    assertEqual(credentialsProblem("ada@example.com", "x".repeat(72)), null, "72 is the most");
    assertEqual(credentialsProblem("ada@example.com", "x".repeat(73)), "Use a shorter password (at most 72 characters).", "73 is too many");
    assertEqual(credentialsProblem("ada@example.com", "é".repeat(40)), "Use a shorter password (at most 72 characters).", "bytes count, not characters");
  });

  await check("parseSession accepts a session and nothing else, and keeps only a session's fields", () => {
    const session = sessionFor("a", NOW + HOUR);
    assertSameJson(parseSession(JSON.parse(JSON.stringify(session))), session, "a session");
    assertSameJson(parseSession({ ...session, extra: 1, user: { ...USER, role: "admin" } }), session, "extra fields are dropped");
    const bad: unknown[] = [
      null,
      "a session",
      {},
      { ...session, accessToken: "" },
      { ...session, refreshToken: undefined },
      { ...session, expiresAt: "soon" },
      { ...session, expiresAt: Number.NaN },
      { ...session, user: { id: 1, email: "ada@example.com" } },
      { ...session, user: null }
    ];
    for (const value of bad) {
      assertEqual(parseSession(value), null, `rejects ${JSON.stringify(value)}`);
    }
  });

  // --- HttpAuthClient ---

  await check("HttpAuthClient speaks the backend's /api/auth contract - and sends a token only where one is needed", async () => {
    const session = sessionFor("a", NOW + HOUR);
    const fetchImpl = mockAuthFetch((call) => {
      if (call.url.endsWith("/signup")) {
        return response(201, { session });
      }
      if (call.url.endsWith("/signin") || call.url.endsWith("/refresh")) {
        return response(200, { session });
      }
      if (call.url.endsWith("/signout")) {
        return response(204);
      }
      return response(200, { user: USER });
    });
    const client = new HttpAuthClient({ baseUrl: "http://localhost:8787/", fetch: fetchImpl });

    assertSameJson(await client.signUp("ada@example.com", "password1"), { session }, "sign up");
    assertSameJson(await client.signIn("ada@example.com", "password1"), session, "sign in");
    assertSameJson(await client.refresh("refresh-a"), session, "refresh");
    await client.signOut("access-a");
    assertSameJson(await client.getUser("access-a"), USER, "the session's user");

    assertSameJson(
      fetchImpl.calls.map((call) => `${call.method} ${call.url}`),
      [
        "POST http://localhost:8787/api/auth/signup",
        "POST http://localhost:8787/api/auth/signin",
        "POST http://localhost:8787/api/auth/refresh",
        "POST http://localhost:8787/api/auth/signout",
        "GET http://localhost:8787/api/auth/session"
      ],
      "routes"
    );
    assertSameJson(
      fetchImpl.calls.map((call) => call.body ?? null),
      [{ email: "ada@example.com", password: "password1" }, { email: "ada@example.com", password: "password1" }, { refreshToken: "refresh-a" }, null, null],
      "bodies"
    );
    assertSameJson(
      fetchImpl.calls.map((call) => call.headers.Authorization ?? null),
      [null, null, null, "Bearer access-a", "Bearer access-a"],
      "a token only for sign-out and the session check"
    );
  });

  await check("HttpAuthClient: confirmation-first sign-up, the server's own messages, malformed sessions, and network failures", async () => {
    const clientWith = (handler: (call: Call) => AuthHttpResponse) => new HttpAuthClient({ baseUrl: "http://localhost:8787", fetch: mockAuthFetch(handler) });
    const refusedWith = (status: number, message: string) => (error: unknown) =>
      error instanceof AuthRequestError && error.status === status && error.message.includes(message);

    assertSameJson(
      await clientWith(() => response(202, { confirmationRequired: true, email: "ada@example.com" })).signUp("ada@example.com", "password1"),
      { confirmationRequired: true, email: "ada@example.com" },
      "202 -> confirm first"
    );
    await assertRejects(
      () => clientWith(() => response(401, { error: "Wrong email or password." })).signIn("ada@example.com", "password1"),
      refusedWith(401, "Wrong email or password."),
      "401 on sign in"
    );
    await assertRejects(
      () => clientWith(() => response(409, { error: "An account with this email already exists - sign in instead." })).signUp("ada@example.com", "password1"),
      refusedWith(409, "already exists"),
      "409 on sign up"
    );
    await assertRejects(() => clientWith(() => response(401, { error: EXPIRED })).refresh("refresh-a"), refusedWith(401, EXPIRED), "401 on refresh");
    await assertRejects(() => clientWith(() => response(401, { error: EXPIRED })).getUser("access-a"), refusedWith(401, EXPIRED), "401 on the session check");
    await assertRejects(
      () => clientWith(() => response(200, { session: { accessToken: 1 } })).signIn("ada@example.com", "password1"),
      refusedWith(502, "malformed session"),
      "a malformed session"
    );
    await assertRejects(
      () =>
        clientWith(() => {
          throw new Error("Failed to fetch");
        }).signIn("ada@example.com", "password1"),
      refusedWith(0, "Could not reach the sign-in server: Failed to fetch"),
      "a network failure is status 0"
    );
    await clientWith(() => response(401, { error: EXPIRED })).signOut("access-a"); // already signed out - not an error
    for (const options of [
      { baseUrl: "", fetch: mockAuthFetch(() => response(200)) },
      { baseUrl: "http://localhost:8787", fetch: undefined as unknown as AuthFetch }
    ]) {
      let threw = false;
      try {
        new HttpAuthClient(options);
      } catch {
        threw = true;
      }
      assertTrue(threw, "a base URL and a transport are required");
    }
  });

  // --- AuthController ---

  await check("AuthController: nothing stored starts signed out; a corrupt stored session is ignored; storage that throws doesn't break sign-in", async () => {
    const empty = new AuthController({ client: stubClient(), storage: memoryStorage() });
    assertEqual(empty.getState().status, "restoring", "restoring until started");
    await empty.start();
    assertEqual(empty.getState().status, "signed-out", "signed out");
    assertEqual(empty.isSignedIn(), false, "isSignedIn");
    assertEqual(await empty.accessToken(), null, "no token");

    const corruptStorage = memoryStorage();
    corruptStorage.map.set(SESSION_STORAGE_KEY, "{not json");
    const corrupt = new AuthController({ client: stubClient(), storage: corruptStorage });
    await corrupt.start();
    assertEqual(corrupt.getState().status, "signed-out", "a corrupt session is ignored");

    const blocked: SessionStorageLike = {
      getItem: () => {
        throw new Error("storage blocked");
      },
      setItem: () => {
        throw new Error("storage blocked");
      },
      removeItem: () => {
        throw new Error("storage blocked");
      }
    };
    const controller = new AuthController({
      client: stubClient({ signIn: async () => sessionFor("a", NOW + HOUR), signOut: async () => undefined }),
      storage: blocked,
      now: () => NOW
    });
    await controller.start();
    assertEqual(controller.getState().status, "signed-out", "blocked storage starts signed out");
    assertTrue(await controller.signIn("ada@example.com", "password1"), "signs in anyway - for this page only");
    assertEqual(await controller.accessToken(), "access-a", "with a usable token");
    await controller.signOut();
    assertEqual(controller.getState().status, "signed-out", "and signs out");
  });

  await check("AuthController.signIn / signUp: credentials are checked before anything is sent; the session is kept; refusals are reported", async () => {
    const storage = memoryStorage();
    const client = stubClient({
      signIn: async (_email, password) => {
        if (password !== "password1") {
          throw new AuthRequestError(401, "Wrong email or password.");
        }
        return sessionFor("in", NOW + HOUR);
      },
      signUp: async (email) =>
        email === "new@example.com" ? { session: sessionFor("up", NOW + HOUR, { id: "user-2", email }) } : { confirmationRequired: true, email },
      signOut: async () => undefined
    });
    const controller = new AuthController({ client, storage, now: () => NOW });
    await controller.start();
    const seen: string[] = [];
    controller.subscribe((state) => seen.push(state.status));

    assertEqual(await controller.signIn("not-an-email", "password1"), false, "an invalid email");
    assertEqual(controller.getState().message, "Enter a valid email address.", "says why");
    assertEqual(client.calls.length, 0, "and nothing was sent");

    assertEqual(await controller.signIn("ada@example.com", "wrong-password"), false, "a wrong password");
    assertEqual(controller.getState().status, "signed-out", "still signed out");
    assertEqual(controller.getState().message, "Wrong email or password.", "with the server's message");
    assertEqual(storedSession(storage), null, "nothing stored");

    assertTrue(await controller.signIn(" ada@example.com ", "password1"), "the right password");
    assertEqual(client.calls[client.calls.length - 1], "signIn ada@example.com", "the email is sent trimmed");
    assertEqual(controller.getState().status, "signed-in", "signed in");
    assertSameJson(controller.getState().user, USER, "as the session's user");
    assertSameJson(storedSession(storage), sessionFor("in", NOW + HOUR), "the session is stored for the next page load");
    assertTrue(seen.includes("working"), "the UI saw the request in flight");

    await controller.signOut();
    assertTrue(await controller.signUp("new@example.com", "password1"), "sign up signs straight in");
    assertEqual(controller.getState().user?.id, "user-2", "as the new user");

    await controller.signOut();
    assertEqual(await controller.signUp("confirm@example.com", "password1"), false, "an account that needs confirming first");
    assertEqual(controller.getState().status, "signed-out", "isn't signed in yet");
    assertEqual(controller.getState().message, "Check confirm@example.com to confirm your account, then sign in.", "and is told what to do");
  });

  await check("AuthController.start: a stored session is confirmed with the server, refreshed if it has expired, and dropped if the server refuses it", async () => {
    const valid = await restoredController(sessionFor("a", NOW + HOUR));
    assertEqual(valid.controller.getState().status, "signed-in", "a valid session is restored");
    assertSameJson(valid.client.calls, ["getUser access-a"], "after one check with the server");

    const expired = await restoredController(sessionFor("a", NOW - 1000), { refresh: async () => sessionFor("b", NOW + HOUR) });
    assertEqual(expired.controller.getState().status, "signed-in", "an expired session is refreshed");
    assertSameJson(expired.client.calls, ["refresh refresh-a", "getUser access-b"], "refreshed first, then checked");
    assertEqual(storedSession(expired.storage)?.accessToken, "access-b", "the new session is stored");

    const refused = await restoredController(sessionFor("a", NOW + HOUR), {
      getUser: async () => {
        throw new AuthRequestError(401, EXPIRED);
      },
      refresh: async () => sessionFor("c", NOW + HOUR)
    });
    assertEqual(refused.controller.getState().status, "signed-in", "a refused token is refreshed once");
    assertEqual(storedSession(refused.storage)?.accessToken, "access-c", "and the new one kept");

    const ended = await restoredController(sessionFor("a", NOW + HOUR), {
      getUser: async () => {
        throw new AuthRequestError(401, EXPIRED);
      },
      refresh: async () => {
        throw new AuthRequestError(401, EXPIRED);
      }
    });
    assertEqual(ended.controller.getState().status, "signed-out", "a session the server has ended signs out");
    assertEqual(ended.controller.getState().message, EXPIRED, "saying so");
    assertEqual(storedSession(ended.storage), null, "and it's removed from storage");

    const offline = await restoredController(sessionFor("a", NOW + HOUR), {
      getUser: async () => {
        throw new AuthRequestError(0, "Could not reach the sign-in server: Failed to fetch");
      }
    });
    assertEqual(offline.controller.getState().status, "signed-in", "an unreachable server keeps the session - every request is checked anyway");
    assertEqual(offline.controller.getState().message, "Couldn't reach the server to confirm your session.", "with a note");
  });

  await check("AuthController.signOut clears the session here and tells the server - and is signed out even when the server can't be reached", async () => {
    const reachable = await restoredController(sessionFor("a", NOW + HOUR), { signOut: async () => undefined });
    await reachable.controller.signOut();
    assertEqual(reachable.controller.getState().status, "signed-out", "signed out");
    assertEqual(reachable.controller.getState().message, "Signed out.", "message");
    assertEqual(storedSession(reachable.storage), null, "storage cleared");
    assertTrue(reachable.client.calls.includes("signOut access-a"), "the server was told");
    assertEqual(await reachable.controller.accessToken(), null, "no token any more");

    const unreachable = await restoredController(sessionFor("a", NOW + HOUR), {
      signOut: async () => {
        throw new AuthRequestError(0, "Could not reach the sign-in server");
      }
    });
    await unreachable.controller.signOut();
    assertEqual(unreachable.controller.getState().status, "signed-out", "signed out anyway");
    assertEqual(storedSession(unreachable.storage), null, "storage cleared anyway");
  });

  await check("authorize(): every request carries the token, which is refreshed shortly before it expires; no token while signed out", async () => {
    let clock = NOW;
    const { controller, client, storage } = await restoredController(sessionFor("a", NOW + HOUR), { refresh: async () => sessionFor("b", clock + HOUR) }, () => clock);
    const sent: (string | null)[] = [];
    const authorized = controller.authorize(async (_url: string, init: { headers: Record<string, string> }) => {
      sent.push(init.headers.Authorization ?? null);
      return { status: 200 };
    });

    await authorized("/api/projects", { headers: { "Content-Type": "application/json" } });
    assertEqual(sent[0], "Bearer access-a", "the current token");

    clock = NOW + HOUR - 30_000; // 30 s before it expires
    await authorized("/api/projects", { headers: {} });
    assertEqual(sent[1], "Bearer access-b", "refreshed first when it's about to expire");
    assertEqual(client.calls.filter((call) => call.startsWith("refresh")).length, 1, "one refresh");
    assertEqual(storedSession(storage)?.accessToken, "access-b", "the refreshed session is stored");

    const signedOut = new AuthController({ client: stubClient(), storage: memoryStorage() });
    await signedOut.start();
    const anonymous: (string | null)[] = [];
    await signedOut.authorize(async (_url: string, init: { headers: Record<string, string> }) => {
      anonymous.push(init.headers.Authorization ?? null);
      return { status: 401 };
    })("/api/projects", { headers: {} });
    assertSameJson(anonymous, [null], "signed out: no token, and a 401 isn't retried");
  });

  await check("authorize(): a 401 refreshes once and retries - concurrent 401s share one refresh; a failed refresh signs out", async () => {
    const gate = makeDeferred<void>();
    let unauthorized = 0;
    let refreshes = 0;
    const { controller, storage } = await restoredController(sessionFor("a", NOW + HOUR), {
      refresh: async () => {
        refreshes += 1;
        await gate.promise;
        return sessionFor("b", NOW + HOUR);
      }
    });
    const send = async (_url: string, init: { headers: Record<string, string> }) => {
      if (init.headers.Authorization === "Bearer access-a") {
        unauthorized += 1;
        if (unauthorized === 2) {
          gate.resolve();
        }
        return { status: 401, token: init.headers.Authorization };
      }
      return { status: 200, token: init.headers.Authorization };
    };
    const authorized = controller.authorize(send);
    const [first, second] = await Promise.all([authorized("/a", { headers: {} }), authorized("/b", { headers: {} })]);
    assertEqual(first.status, 200, "the first request succeeds on retry");
    assertEqual(second.status, 200, "and so does the second");
    assertEqual(first.token, "Bearer access-b", "with the refreshed token");
    assertEqual(refreshes, 1, "one refresh for both");
    assertEqual(storedSession(storage)?.accessToken, "access-b", "stored");

    const failing = await restoredController(sessionFor("a", NOW + HOUR), {
      refresh: async () => {
        throw new AuthRequestError(401, EXPIRED);
      }
    });
    let calls = 0;
    const result = await failing.controller.authorize(async () => {
      calls += 1;
      return { status: 401 };
    })("/api/projects", { headers: {} });
    assertEqual(result.status, 401, "the 401 is returned to the caller");
    assertEqual(calls, 1, "and not retried without a new token");
    assertEqual(failing.controller.getState().status, "signed-out", "the user is signed out");
    assertEqual(failing.controller.getState().message, EXPIRED, "and told why");
    assertEqual(storedSession(failing.storage), null, "the stale session is removed");
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
