/**
 * Lightweight in-memory + real-HTTP-over-loopback verification for the
 * AI proxy backend. Same "no test framework, plain assertion helpers,
 * run directly by Node" convention as every verify.ts under src/. Run
 * with (from inside backend/, after `npm install`):
 *   npm run verify
 * or directly:
 *   node verify.ts
 *
 * Every check binds the real server (createServer()) to an EPHEMERAL
 * local port (`.listen(0)`) and talks to it over 127.0.0.1 using
 * Node's built-in `fetch` - a genuine HTTP round-trip through this
 * server's real request-handling code, not a mock of Node's `http`
 * primitives. That is NOT a "real API call" in the sense this project
 * cares about: it never leaves the loopback interface, and it is
 * calling code THIS repository owns and controls, not OpenAI.
 *
 * The actual OpenAI boundary (whether a real network call could ever
 * happen) is controlled entirely by what `provider` each check injects:
 *   - Most checks use FakeProvider (below) - it has no HTTP code at
 *     all, so there is no way for it to reach any network.
 *   - A few checks construct a REAL OpenAIProvider (proving this
 *     backend genuinely reuses the existing, tested OpenAI-calling
 *     logic - see "OpenAIProvider integration" below) but ALWAYS with
 *     a hand-rolled mock `fetch`, exactly like
 *     src/engine/ai/providers/verify.ts - never the real global
 *     `fetch`, never a real API key. `OpenAIProvider` itself has no
 *     fallback to a global transport (see its constructor), so this
 *     combination makes a real OpenAI request structurally impossible
 *     here.
 *
 * Explicit .ts extensions below are required for Node's native
 * TypeScript support to resolve these relative imports (see
 * allowImportingTsExtensions in tsconfig.json) - this file is run
 * directly by Node, not bundled or compiled.
 */
import type { AddressInfo } from "node:net";
import { createServer } from "./src/createServer.ts";
import type { CreateServerOptions } from "./src/createServer.ts";
import { OpenAIProvider } from "../src/engine/ai/providers/OpenAIProvider.ts";
import type { OpenAIFetch, OpenAIHttpResponse } from "../src/engine/ai/providers/OpenAIProvider.ts";
import { AI_SUPPORTED_OBJECT_TYPES } from "../src/engine/ai/types.ts";
import type { AIProvider } from "../src/engine/ai/AIProvider.ts";
import type { AIProviderRequest, AIProviderResponse, AIProjectSnapshot } from "../src/engine/ai/types.ts";

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
    throw new Error(`${message}: expected ${expectedJson}, got ${actualJson}`);
  }
}

const FRONTEND_ORIGIN = "http://localhost:5173";

const validSnapshot: AIProjectSnapshot = {
  wallCount: 1,
  pillarCount: 0,
  beamCount: 0,
  slabCount: 0,
  doorCount: 0,
  windowCount: 0,
  assemblyCount: 0,
  selectedObjectId: null
};

/** A hand-rolled, HTTP-free AIProvider stand-in - records every request it receives and returns/throws whatever the test configures. Used for every check that isn't specifically about proving OpenAIProvider reuse. */
function makeFakeProvider(
  handler: (request: AIProviderRequest) => AIProviderResponse
): AIProvider & { calls: AIProviderRequest[] } {
  const calls: AIProviderRequest[] = [];
  return {
    calls,
    interpret(request: AIProviderRequest): AIProviderResponse {
      calls.push(request);
      return handler(request);
    }
  };
}

function makeThrowingProvider(message: string): AIProvider {
  return {
    interpret(): never {
      throw new Error(message);
    }
  };
}

/**
 * Mirrors makeMockFetch in src/engine/ai/providers/verify.ts - a
 * hand-rolled OpenAIFetch that never touches the network. Tracks calls
 * via an array (not a `callCount` getter) deliberately: `Object.assign`
 * copies a getter's *current value* once, as a plain data property - it
 * does not carry the accessor itself over to the target, so a getter
 * added this way silently stops updating. An array reference doesn't
 * have that problem: `Object.assign` copies the reference, and mutating
 * the same array afterward (`calls.push(...)`) is visible through it.
 */
function makeMockFetch(
  handler: () => OpenAIHttpResponse | Promise<OpenAIHttpResponse>
): OpenAIFetch & { calls: unknown[] } {
  const calls: unknown[] = [];
  const fetchImpl = async (): Promise<OpenAIHttpResponse> => {
    calls.push(null);
    return handler();
  };
  return Object.assign(fetchImpl, { calls });
}

function okChatResponse(content: unknown): OpenAIHttpResponse {
  const serialized = JSON.stringify(content);
  return {
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content: serialized } }] }),
    text: async () => serialized
  };
}

/** Starts a real server on an ephemeral loopback port, runs `fn` against its base URL, then always tears the server down - even if `fn` throws. */
async function withServer<T>(options: CreateServerOptions, fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const server = createServer(options);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const address = server.address() as AddressInfo | null;
  if (!address || typeof address === "string") {
    throw new Error("Expected the server to bind to a TCP port.");
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    return await fn(baseUrl);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
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

  console.log("AI proxy backend verification\n");

  // --- Routing basics ---

  await check("GET /health returns 200 { status: 'ok' }", async () => {
    const provider = makeFakeProvider(() => ({ commands: [] }));
    await withServer({ provider, frontendOrigin: FRONTEND_ORIGIN }, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/health`);
      assertEqual(res.status, 200, "status");
      assertDeepEqual(await res.json(), { status: "ok" }, "body");
    });
  });

  await check("OPTIONS preflight returns 204 with the configured CORS origin", async () => {
    const provider = makeFakeProvider(() => ({ commands: [] }));
    await withServer({ provider, frontendOrigin: FRONTEND_ORIGIN }, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/ai/interpret`, { method: "OPTIONS" });
      assertEqual(res.status, 204, "status");
      assertEqual(res.headers.get("Access-Control-Allow-Origin"), FRONTEND_ORIGIN, "CORS origin header");
    });
  });

  await check("an unknown route returns 404", async () => {
    const provider = makeFakeProvider(() => ({ commands: [] }));
    await withServer({ provider, frontendOrigin: FRONTEND_ORIGIN }, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/nope`);
      assertEqual(res.status, 404, "status");
    });
  });

  // --- Request validation (400s) ---

  await check("POST /api/ai/interpret with a non-JSON body returns 400", async () => {
    const provider = makeFakeProvider(() => ({ commands: [] }));
    await withServer({ provider, frontendOrigin: FRONTEND_ORIGIN }, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/ai/interpret`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not json{"
      });
      assertEqual(res.status, 400, "status");
      assertEqual(provider.calls.length, 0, "provider should never be called");
    });
  });

  await check("POST /api/ai/interpret with a missing instruction returns 400", async () => {
    const provider = makeFakeProvider(() => ({ commands: [] }));
    await withServer({ provider, frontendOrigin: FRONTEND_ORIGIN }, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/ai/interpret`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectContext: validSnapshot })
      });
      assertEqual(res.status, 400, "status");
      const body = (await res.json()) as { error: string };
      assertTrue(body.error.includes("instruction"), "error should mention instruction");
      assertEqual(provider.calls.length, 0, "provider should never be called");
    });
  });

  await check("POST /api/ai/interpret with a whitespace-only instruction returns 400", async () => {
    const provider = makeFakeProvider(() => ({ commands: [] }));
    await withServer({ provider, frontendOrigin: FRONTEND_ORIGIN }, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/ai/interpret`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instruction: "   ", projectContext: validSnapshot })
      });
      assertEqual(res.status, 400, "status");
      assertEqual(provider.calls.length, 0, "provider should never be called");
    });
  });

  await check("POST /api/ai/interpret with a malformed projectContext returns 400", async () => {
    const provider = makeFakeProvider(() => ({ commands: [] }));
    await withServer({ provider, frontendOrigin: FRONTEND_ORIGIN }, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/ai/interpret`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instruction: "Create a wall", projectContext: { wallCount: "not a number" } })
      });
      assertEqual(res.status, 400, "status");
      assertEqual(provider.calls.length, 0, "provider should never be called");
    });
  });

  await check("POST /api/ai/interpret with a non-array availableObjectTypes returns 400", async () => {
    const provider = makeFakeProvider(() => ({ commands: [] }));
    await withServer({ provider, frontendOrigin: FRONTEND_ORIGIN }, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/ai/interpret`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          instruction: "Create a wall",
          projectContext: validSnapshot,
          availableObjectTypes: "wall"
        })
      });
      assertEqual(res.status, 400, "status");
    });
  });

  await check("POST /api/ai/interpret with a body over the size cap returns 413", async () => {
    const provider = makeFakeProvider(() => ({ commands: [] }));
    await withServer({ provider, frontendOrigin: FRONTEND_ORIGIN }, async (baseUrl) => {
      const oversized = JSON.stringify({
        instruction: "Create a wall",
        projectContext: validSnapshot,
        padding: "x".repeat(1_100_000)
      });
      const res = await fetch(`${baseUrl}/api/ai/interpret`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: oversized
      });
      assertEqual(res.status, 413, "status");
      assertEqual(provider.calls.length, 0, "provider should never be called");
    });
  });

  // --- Successful proxying ---

  await check("POST /api/ai/interpret relays a well-formed request to the provider and returns its response", async () => {
    const provider = makeFakeProvider(() => ({ commands: [{ type: "wall.add", wall: {} }], notes: "ok" }));
    await withServer({ provider, frontendOrigin: FRONTEND_ORIGIN }, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/ai/interpret`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instruction: "Create a wall", projectContext: validSnapshot })
      });

      assertEqual(res.status, 200, "status");
      assertDeepEqual(await res.json(), { commands: [{ type: "wall.add", wall: {} }], notes: "ok" }, "body");
      assertEqual(provider.calls.length, 1, "provider should be called exactly once");
      assertEqual(provider.calls[0].instruction, "Create a wall", "instruction forwarded");
      assertDeepEqual(provider.calls[0].projectContext, validSnapshot, "projectContext forwarded unchanged");
    });
  });

  await check("POST /api/ai/interpret defaults availableObjectTypes to AI_SUPPORTED_OBJECT_TYPES when omitted", async () => {
    const provider = makeFakeProvider(() => ({ commands: [] }));
    await withServer({ provider, frontendOrigin: FRONTEND_ORIGIN }, async (baseUrl) => {
      await fetch(`${baseUrl}/api/ai/interpret`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instruction: "Create a wall", projectContext: validSnapshot })
      });
      assertDeepEqual(provider.calls[0].availableObjectTypes, AI_SUPPORTED_OBJECT_TYPES, "default availableObjectTypes");
    });
  });

  await check("POST /api/ai/interpret respects a caller-supplied availableObjectTypes", async () => {
    const provider = makeFakeProvider(() => ({ commands: [] }));
    await withServer({ provider, frontendOrigin: FRONTEND_ORIGIN }, async (baseUrl) => {
      await fetch(`${baseUrl}/api/ai/interpret`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          instruction: "Create a wall",
          projectContext: validSnapshot,
          availableObjectTypes: ["wall"]
        })
      });
      assertDeepEqual(provider.calls[0].availableObjectTypes, ["wall"], "supplied availableObjectTypes");
    });
  });

  await check(
    "the backend never re-validates or reshapes provider output - an unsupported command from the provider is still relayed as-is",
    async () => {
      const provider = makeFakeProvider(() => ({ commands: [{ type: "roof.add", roof: {} }] }));
      await withServer({ provider, frontendOrigin: FRONTEND_ORIGIN }, async (baseUrl) => {
        const res = await fetch(`${baseUrl}/api/ai/interpret`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ instruction: "Create a roof", projectContext: validSnapshot })
        });
        assertEqual(res.status, 200, "status - this server does not reject it");
        assertDeepEqual(await res.json(), { commands: [{ type: "roof.add", roof: {} }] }, "relayed unchanged");
      });
    }
  );

  // --- Provider failure propagation ---

  await check("POST /api/ai/interpret surfaces a provider failure as 502 with a clear error message", async () => {
    const provider = makeThrowingProvider("upstream boom");
    await withServer({ provider, frontendOrigin: FRONTEND_ORIGIN }, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/ai/interpret`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instruction: "Create a wall", projectContext: validSnapshot })
      });
      assertEqual(res.status, 502, "status");
      const body = (await res.json()) as { error: string };
      assertTrue(body.error.includes("upstream boom"), "error message should include the provider's message");
    });
  });

  // --- OpenAIProvider integration (proves the existing OpenAI logic is genuinely reused) ---

  await check(
    "POST /api/ai/interpret works end-to-end through a REAL OpenAIProvider with a mocked transport, making exactly one (mocked) request",
    async () => {
      const mockFetch = makeMockFetch(() => okChatResponse({ commands: [{ type: "pillar.add", pillar: {} }] }));
      const provider = new OpenAIProvider({ apiKey: "sk-test", fetch: mockFetch });

      await withServer({ provider, frontendOrigin: FRONTEND_ORIGIN }, async (baseUrl) => {
        const res = await fetch(`${baseUrl}/api/ai/interpret`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ instruction: "Add a pillar", projectContext: validSnapshot })
        });

        assertEqual(res.status, 200, "status");
        assertDeepEqual(await res.json(), { commands: [{ type: "pillar.add", pillar: {} }] }, "body");
        assertEqual(mockFetch.calls.length, 1, "exactly one (mocked) OpenAI request should have been made");
      });
    }
  );

  await check(
    "POST /api/ai/interpret surfaces a real OpenAIProvider upstream failure (mocked non-OK response) as 502, with zero real network calls",
    async () => {
      const mockFetch = makeMockFetch(() => ({
        ok: false,
        status: 401,
        json: async () => ({ error: "invalid_api_key" }),
        text: async () => "invalid_api_key"
      }));
      const provider = new OpenAIProvider({ apiKey: "sk-bad", fetch: mockFetch });

      await withServer({ provider, frontendOrigin: FRONTEND_ORIGIN }, async (baseUrl) => {
        const res = await fetch(`${baseUrl}/api/ai/interpret`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ instruction: "Create a wall", projectContext: validSnapshot })
        });

        assertEqual(res.status, 502, "status");
        const body = (await res.json()) as { error: string };
        assertTrue(body.error.includes("401"), "error message should include the upstream status code");
        assertEqual(mockFetch.calls.length, 1, "exactly one (mocked) OpenAI request should have been made");
      });
    }
  );

  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) {
    throw new Error(`${failed} verification check(s) failed`);
  }
}

// See src/engine/ai/verify.ts's matching comment for why this rethrows
// instead of setting `process.exitCode` - in short, an unhandled
// rejection already exits Node with a non-zero code.
run().catch((error) => {
  console.error(error);
  throw error;
});
