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
import { BackendAIProvider } from "../src/engine/ai/providers/BackendAIProvider.ts";
import { MockAIProvider } from "../src/engine/ai/MockAIProvider.ts";
import { buildSimpleHousePlan } from "../src/engine/ai/housePlan.ts";
import { InMemoryProjectRepository } from "../src/engine/project/InMemoryProjectRepository.ts";
import { HttpProjectRepository } from "../src/engine/project/HttpProjectRepository.ts";
import { ProjectNotFoundError, ProjectValidationError } from "../src/engine/project/ProjectRepository.ts";
import type { ProjectDocument } from "../src/engine/project/projectDocument.ts";
import { AI_SUPPORTED_OBJECT_TYPES } from "../src/engine/ai/types.ts";
import { buildAIProjectContext } from "../src/engine/ai/aiProjectContext.ts";
import { analyzeConstructionGeometry } from "../src/engine/ai/geometry/analyzeConstructionGeometry.ts";
import type { AIProvider } from "../src/engine/ai/AIProvider.ts";
import type { AIProviderRequest, AIProviderResponse, AIProjectContext, AIProjectSnapshot } from "../src/engine/ai/types.ts";

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
  selectedObjectId: null,
  objects: [
    {
      id: "wall-1",
      type: "wall",
      position: { x: 0, y: 1.35, z: 0 },
      rotation: 0,
      dimensions: { height: 2.7, length: 4, thickness: 0.2 },
      material: "generic",
      color: "#c9c9c9",
      assemblyIds: []
    }
  ],
  assemblies: []
};

/** What the server hands its provider for validSnapshot: the sanitized snapshot plus geometry the server derived from it. */
const validContext: AIProjectContext = buildAIProjectContext(validSnapshot);

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
      assertDeepEqual(provider.calls[0].projectContext, validContext, "projectContext forwarded unchanged");
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

  // --- Construction context validation ---

  await check("POST /api/ai/interpret strips fields the snapshot doesn't define before the provider sees them", async () => {
    const provider = makeFakeProvider(() => ({ commands: [] }));
    await withServer({ provider, frontendOrigin: FRONTEND_ORIGIN }, async (baseUrl) => {
      const tampered = JSON.parse(JSON.stringify(validSnapshot));
      tampered.injected = "top-level extra";
      tampered.objects[0].mesh = { geometry: "should never reach a provider" };
      tampered.objects[0].position.w = 1;

      const res = await fetch(`${baseUrl}/api/ai/interpret`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instruction: "Build a wall", projectContext: tampered })
      });

      assertEqual(res.status, 200, "extra fields alone are not an error");
      assertDeepEqual(provider.calls[0].projectContext, validContext, "the provider received only the defined fields");
    });
  });

  await check("POST /api/ai/interpret rejects a malformed construction object with 400", async () => {
    const provider = makeFakeProvider(() => ({ commands: [] }));
    await withServer({ provider, frontendOrigin: FRONTEND_ORIGIN }, async (baseUrl) => {
      const tampered = JSON.parse(JSON.stringify(validSnapshot));
      tampered.objects[0].position = { x: "0" };

      const res = await fetch(`${baseUrl}/api/ai/interpret`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instruction: "Build a wall", projectContext: tampered })
      });

      assertEqual(res.status, 400, "status");
      const body = (await res.json()) as { error: string };
      assertTrue(body.error.includes("projectContext.objects[0].position"), `error should name the field, got "${body.error}"`);
      assertEqual(provider.calls.length, 0, "provider should never be called");
    });
  });

  await check("POST /api/ai/interpret rejects a context with no objects list with 400", async () => {
    const provider = makeFakeProvider(() => ({ commands: [] }));
    await withServer({ provider, frontendOrigin: FRONTEND_ORIGIN }, async (baseUrl) => {
      const tampered = JSON.parse(JSON.stringify(validSnapshot));
      delete tampered.objects;

      const res = await fetch(`${baseUrl}/api/ai/interpret`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instruction: "Build a wall", projectContext: tampered })
      });

      assertEqual(res.status, 400, "status");
      assertEqual(provider.calls.length, 0, "provider should never be called");
    });
  });

  await check(
    "the detailed snapshot reaches OpenAI through this unchanged server - real server, real OpenAIProvider, mocked OpenAI transport",
    async () => {
      // Proves no backend change was needed to expose the construction
      // state to the model: the server already hands its provider the
      // parser's full snapshot, and OpenAIProvider now serializes it.
      const openAIRequestBodies: string[] = [];
      const recordingFetch: OpenAIFetch = async (_url, init) => {
        openAIRequestBodies.push(init.body);
        return okChatResponse({ commands: [] });
      };
      const provider = new OpenAIProvider({ apiKey: "sk-test", fetch: recordingFetch });

      await withServer({ provider, frontendOrigin: FRONTEND_ORIGIN }, async (baseUrl) => {
        const res = await fetch(`${baseUrl}/api/ai/interpret`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ instruction: "Add a wall as tall as wall-1", projectContext: validSnapshot })
        });
        assertEqual(res.status, 200, "status");
      });

      assertEqual(openAIRequestBodies.length, 1, "exactly one (mocked) OpenAI request");
      const body = JSON.parse(openAIRequestBodies[0]) as { messages: { role: string; content: string }[] };
      const state = (JSON.parse(body.messages[1].content) as { currentConstructionState: AIProjectContext })
        .currentConstructionState;
      assertDeepEqual(state, validContext, "OpenAI receives the full snapshot the frontend sent, plus server-derived geometry");
      assertEqual(body.messages[2].content, "Add a wall as tall as wall-1", "the instruction is the final message");
      assertTrue(!openAIRequestBodies[0].includes("sk-test"), "the API key is not in the OpenAI request body");
    }
  );

  // --- Geometry: derived by this server, never taken from the client ---

  // Two 4 m walls along X, 6 m apart center to center: wall-1 spans x -2..2, wall-2 spans x 4..8.
  const twoWallSnapshot: AIProjectSnapshot = {
    ...validSnapshot,
    wallCount: 2,
    objects: [
      { ...validSnapshot.objects[0], position: { x: 0, y: 1.5, z: 0 }, dimensions: { height: 3, length: 4, thickness: 0.2 } },
      { ...validSnapshot.objects[0], id: "wall-2", position: { x: 6, y: 1.5, z: 0 }, dimensions: { height: 3, length: 4, thickness: 0.2 } }
    ]
  };
  const expectedWallPair = {
    a: "wall-1",
    b: "wall-2",
    centerDelta: { x: 6, y: 0, z: 0 },
    centerDistance: 6,
    horizontalDistance: 6,
    verticalDistance: 0,
    overlap: { x: false, y: true, z: true, aabb: false },
    gap: { x: 2, y: 0, z: 0 },
    aRelativeToB: { leftOf: true, rightOf: false, inFrontOf: false, behind: false, above: false, below: false }
  };
  /** Wrong in every value, and describing an object that doesn't exist - what a tampering client might send. */
  const fabricatedGeometry = {
    objects: [
      {
        id: "ghost-1",
        type: "wall",
        center: { x: 999, y: 999, z: 999 },
        dimensions: { length: 1 },
        rotation: 0,
        size: { x: 1, y: 1, z: 1 },
        aabb: { min: { x: 998, y: 998, z: 998 }, max: { x: 1000, y: 1000, z: 1000 } }
      }
    ],
    relationships: [
      {
        a: "wall-1",
        b: "wall-2",
        centerDelta: { x: -999, y: 0, z: 0 },
        centerDistance: 999,
        horizontalDistance: 999,
        verticalDistance: 0,
        overlap: { x: true, y: true, z: true, aabb: true },
        gap: { x: 0, y: 0, z: 0 },
        aRelativeToB: { leftOf: false, rightOf: true, inFrontOf: false, behind: false, above: false, below: false }
      }
    ],
    invalidObjects: [{ id: "wall-1", type: "wall", errors: [{ field: "dimensions.length", message: "fabricated" }] }]
  };
  const FABRICATION_MARKERS = ["ghost-1", "999", "fabricated"];

  function postInterpret(baseUrl: string, projectContext: unknown): Promise<Response> {
    return fetch(`${baseUrl}/api/ai/interpret`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ instruction: "Describe wall-1 and wall-2", projectContext })
    });
  }

  await check("the backend derives geometry from the sanitized snapshot and ignores fabricated client geometry", async () => {
    const provider = makeFakeProvider(() => ({ commands: [] }));
    await withServer({ provider, frontendOrigin: FRONTEND_ORIGIN }, async (baseUrl) => {
      const res = await postInterpret(baseUrl, { ...twoWallSnapshot, geometry: fabricatedGeometry });
      assertEqual(res.status, 200, "status");
    });

    assertEqual(provider.calls.length, 1, "the provider was called once");
    const received = provider.calls[0].projectContext;
    assertDeepEqual(received.geometry, analyzeConstructionGeometry(twoWallSnapshot), "the server's own derivation");
    assertDeepEqual(received.geometry.relationships, [expectedWallPair], "correct values: 6 m apart, 2 m clear, wall-1 left of wall-2");
    assertDeepEqual(received, buildAIProjectContext(twoWallSnapshot), "the sanitized snapshot plus geometry derived from it");
    const serialized = JSON.stringify(received);
    for (const marker of FABRICATION_MARKERS) {
      assertTrue(!serialized.includes(marker), `"${marker}" from the fabricated geometry must not reach the provider`);
    }
  });

  await check("regression: fabricated client geometry never reaches OpenAI - the real OpenAIProvider gets server-derived geometry", async () => {
    const openAIRequestBodies: string[] = [];
    const recordingFetch: OpenAIFetch = async (_url, init) => {
      openAIRequestBodies.push(init.body);
      return okChatResponse({ commands: [] });
    };
    const provider = new OpenAIProvider({ apiKey: "sk-test", fetch: recordingFetch });

    await withServer({ provider, frontendOrigin: FRONTEND_ORIGIN }, async (baseUrl) => {
      const res = await postInterpret(baseUrl, { ...twoWallSnapshot, geometry: fabricatedGeometry });
      assertEqual(res.status, 200, "status");
    });

    assertEqual(openAIRequestBodies.length, 1, "exactly one (mocked) OpenAI request");
    const body = JSON.parse(openAIRequestBodies[0]) as { messages: { role: string; content: string }[] };
    const state = (JSON.parse(body.messages[1].content) as { currentConstructionState: AIProjectContext }).currentConstructionState;
    assertDeepEqual(state.geometry, analyzeConstructionGeometry(twoWallSnapshot), "OpenAI saw the server's derivation");
    assertDeepEqual(state.geometry.relationships, [expectedWallPair], "with the correct values");
    for (const marker of FABRICATION_MARKERS) {
      assertTrue(!openAIRequestBodies[0].includes(marker), `"${marker}" must not appear anywhere in the OpenAI request`);
    }
  });

  await check("a missing or malformed client geometry section is not an error - the server derives geometry either way", async () => {
    const provider = makeFakeProvider(() => ({ commands: [] }));
    const variants: unknown[] = ["garbage", 42, null, [], { objects: "not a list" }, { relationships: [{ a: "x" }] }];

    await withServer({ provider, frontendOrigin: FRONTEND_ORIGIN }, async (baseUrl) => {
      for (const geometry of variants) {
        const res = await postInterpret(baseUrl, { ...twoWallSnapshot, geometry });
        assertEqual(res.status, 200, `geometry ${JSON.stringify(geometry)} is accepted`);
      }
      const res = await postInterpret(baseUrl, twoWallSnapshot);
      assertEqual(res.status, 200, "no geometry section at all is accepted");
    });

    assertEqual(provider.calls.length, variants.length + 1, "every request reached the provider");
    for (const call of provider.calls) {
      assertDeepEqual(call.projectContext.geometry, analyzeConstructionGeometry(twoWallSnapshot), "server-derived geometry every time");
    }
  });

  await check("the server reports an object whose geometry can't be derived in geometry.invalidObjects", async () => {
    const provider = makeFakeProvider(() => ({ commands: [] }));
    const withBadWall = JSON.parse(JSON.stringify(twoWallSnapshot));
    withBadWall.objects[1].dimensions.thickness = 0;

    await withServer({ provider, frontendOrigin: FRONTEND_ORIGIN }, async (baseUrl) => {
      const res = await postInterpret(baseUrl, withBadWall);
      assertEqual(res.status, 200, "a zero dimension is still a well-formed snapshot");
    });

    const geometry = provider.calls[0].projectContext.geometry;
    assertDeepEqual(
      geometry.invalidObjects,
      [{ id: "wall-2", type: "wall", errors: [{ field: "dimensions.thickness", message: "Thickness must be a finite number greater than 0." }] }],
      "invalid objects"
    );
    assertDeepEqual(geometry.relationships, [], "no relationship with an object that has no box");
  });

  // --- Contract check: the real frontend provider against this real server ---

  await check(
    "the real BackendAIProvider round-trips against the real server over HTTP, with a stub provider standing in for OpenAI",
    async () => {
      // The one gap the frontend's own end-to-end suite (which injects a
      // mock transport - see src/engine/ai/e2e/) cannot close by itself:
      // proving the request BackendAIProvider actually builds is a request
      // THIS server accepts. Real provider, real HTTP, real routing and
      // request validation - only the AI provider inside the server is a
      // stub, exactly where OpenAI would otherwise sit.
      const provider = makeFakeProvider(() => ({
        commands: [{ type: "wall.add", wall: { length: 4 } }],
        notes: "stubbed"
      }));

      await withServer({ provider, frontendOrigin: FRONTEND_ORIGIN }, async (baseUrl) => {
        const backendProvider = new BackendAIProvider({
          baseUrl,
          fetch: (url, init) => fetch(url, init)
        });

        const response = await backendProvider.interpret({
          instruction: "Build a wall",
          projectContext: validContext,
          availableObjectTypes: AI_SUPPORTED_OBJECT_TYPES
        });

        assertDeepEqual(response.commands, [{ type: "wall.add", wall: { length: 4 } }], "commands round-tripped");
        assertEqual(response.notes, "stubbed", "notes round-tripped");

        assertEqual(provider.calls.length, 1, "the server called its provider exactly once");
        assertEqual(provider.calls[0].instruction, "Build a wall", "instruction survived the round trip");
        assertDeepEqual(provider.calls[0].projectContext, validContext, "snapshot survived the round trip");
      });
    }
  );

  await check("the real BackendAIProvider surfaces this real server's 400 for a rejected request", async () => {
    const provider = makeFakeProvider(() => ({ commands: [] }));

    await withServer({ provider, frontendOrigin: FRONTEND_ORIGIN }, async (baseUrl) => {
      const backendProvider = new BackendAIProvider({ baseUrl, fetch: (url, init) => fetch(url, init) });

      let message = "";
      try {
        await backendProvider.interpret({
          instruction: "   ",
          projectContext: validContext,
          availableObjectTypes: AI_SUPPORTED_OBJECT_TYPES
        });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }

      assertTrue(message.includes("400"), `expected a 400 to surface, got "${message}"`);
      assertEqual(provider.calls.length, 0, "the server never reached its provider");
    });
  });

  // --- A whole house plan through the real server ---

  await check("the real server relays a complete multi-command house plan unchanged - from the keyless MockAIProvider mockBackend.ts runs", async () => {
    // Exactly the combination `npm run mock` starts: the real createServer()
    // with MockAIProvider behind it. No OpenAI code is involved.
    await withServer({ provider: new MockAIProvider(), frontendOrigin: FRONTEND_ORIGIN }, async (baseUrl) => {
      const backendProvider = new BackendAIProvider({ baseUrl, fetch: (url, init) => fetch(url, init) });

      const response = await backendProvider.interpret({
        instruction: "Build a simple 2-bedroom house on a 10m × 8m footprint.",
        projectContext: validContext,
        availableObjectTypes: AI_SUPPORTED_OBJECT_TYPES
      });

      // validSnapshot's wall-1 sits on the origin (x -2..2), and the server
      // derives geometry from the snapshot it sanitized - so the plan moves
      // clear of it, to x = 8.5.
      assertDeepEqual(
        response.commands,
        buildSimpleHousePlan({ length: 10, width: 8, center: { x: 8.5, z: 0 } }),
        "the 12-command plan, placed clear of the existing wall, relayed unchanged"
      );
      assertEqual(response.commands.length, 12, "12 commands");
      assertTrue(response.notes?.includes("clear of the existing objects"), "the provider's notes are relayed too");
    });
  });

  // --- Projects: /api/projects ---

  const emptyDocument: ProjectDocument = { version: 1, objects: [], assemblies: [] };
  const oneWallDocument: ProjectDocument = {
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
  const noProvider = () => makeFakeProvider(() => ({ commands: [] }));

  await check("the real HttpProjectRepository creates, reads, lists and saves projects through this real server", async () => {
    const projectRepository = new InMemoryProjectRepository();
    await withServer({ provider: noProvider(), frontendOrigin: FRONTEND_ORIGIN, projectRepository }, async (baseUrl) => {
      const client = new HttpProjectRepository({ baseUrl, fetch: (url, init) => fetch(url, init) });

      const created = await client.create({ name: "My 2 Bedroom House", document: oneWallDocument });
      assertEqual(created.name, "My 2 Bedroom House", "name");
      assertDeepEqual(created.document, oneWallDocument, "the document round-tripped unchanged");
      assertDeepEqual(await client.get(created.id), created, "read back");

      const saved = await client.save(created.id, { name: "Renamed", document: emptyDocument });
      assertEqual(saved.id, created.id, "the same project");
      assertEqual(saved.name, "Renamed", "renamed");
      assertDeepEqual((await projectRepository.get(created.id))?.document, emptyDocument, "the server's repository holds the saved document");

      const list = await client.list();
      assertDeepEqual(
        list.map((summary) => [summary.id, summary.name, summary.objectCount, summary.assemblyCount]),
        [[created.id, "Renamed", 0, 0]],
        "the list"
      );
      assertEqual(await client.get("does-not-exist"), null, "an unknown id reads as null");

      let notFound = false;
      try {
        await client.save("does-not-exist", { name: "X", document: emptyDocument });
      } catch (error) {
        notFound = error instanceof ProjectNotFoundError;
      }
      assertTrue(notFound, "saving an unknown project is ProjectNotFoundError");
    });
  });

  await check("POST and PUT /api/projects reject an invalid name or document with a clear 400 and store nothing", async () => {
    const projectRepository = new InMemoryProjectRepository();
    await withServer({ provider: noProvider(), frontendOrigin: FRONTEND_ORIGIN, projectRepository }, async (baseUrl) => {
      const send = (method: string, path: string, body: string) =>
        fetch(`${baseUrl}${path}`, { method, headers: { "Content-Type": "application/json" }, body });
      const wall = oneWallDocument.objects[0];
      const cases: [unknown, string][] = [
        [{ name: "", document: emptyDocument }, "non-empty"],
        [{ name: "X" }, "Invalid project document"],
        [{ name: "X", document: { ...oneWallDocument, objects: [{ ...wall, id: "roof-1", type: "roof" }] } }, "not a supported object type"],
        [{ name: "X", document: { ...oneWallDocument, objects: [wall, wall] } }, "duplicate object id"],
        [{ name: "X", document: { ...oneWallDocument, objects: [{ ...wall, dimensions: { length: 0, height: 2.7, thickness: 0.2 } }] } }, "greater than 0"],
        [{ name: "X", document: { ...oneWallDocument, assemblies: [{ ...oneWallDocument.assemblies[0], objectIds: ["wall-99"] }] } }, "is not an object in this project"]
      ];
      for (const [body, fragment] of cases) {
        const res = await send("POST", "/api/projects", JSON.stringify(body));
        assertEqual(res.status, 400, `status for ${JSON.stringify(body).slice(0, 60)}`);
        const json = (await res.json()) as { error: string };
        assertTrue(json.error.includes(fragment), `expected an error mentioning "${fragment}", got "${json.error}"`);
      }
      assertEqual((await send("POST", "/api/projects", "not json")).status, 400, "a non-JSON body");
      assertEqual((await projectRepository.list()).length, 0, "nothing was stored");

      const created = await projectRepository.create({ name: "Keep", document: oneWallDocument });
      const put = await send("PUT", `/api/projects/${created.id}`, JSON.stringify({ name: "Keep", document: { version: 2 } }));
      assertEqual(put.status, 400, "an invalid save is rejected");
      assertDeepEqual((await projectRepository.get(created.id))?.document, oneWallDocument, "and the stored project is untouched");

      let rejected = false;
      try {
        await new HttpProjectRepository({ baseUrl, fetch: (url, init) => fetch(url, init) }).create({
          name: "X",
          document: { version: 2 } as unknown as ProjectDocument
        });
      } catch (error) {
        rejected = error instanceof ProjectValidationError;
      }
      assertTrue(rejected, "the client surfaces a 400 as ProjectValidationError");
    });
  });

  await check("project routes: 404 for an unknown or malformed id, 405 for other methods, CORS allows GET and PUT, 501 without a repository", async () => {
    await withServer({ provider: noProvider(), frontendOrigin: FRONTEND_ORIGIN, projectRepository: new InMemoryProjectRepository() }, async (baseUrl) => {
      assertEqual((await fetch(`${baseUrl}/api/projects/nope`)).status, 404, "unknown id");
      assertEqual((await fetch(`${baseUrl}/api/projects/${encodeURIComponent("../etc/passwd")}`)).status, 404, "malformed id");
      assertEqual((await fetch(`${baseUrl}/api/projects`, { method: "DELETE" })).status, 405, "DELETE isn't offered");
      const preflight = await fetch(`${baseUrl}/api/projects`, { method: "OPTIONS" });
      const methods = preflight.headers.get("access-control-allow-methods") ?? "";
      assertTrue(methods.includes("GET") && methods.includes("PUT"), `CORS allows GET and PUT, got "${methods}"`);
    });
    await withServer({ provider: noProvider(), frontendOrigin: FRONTEND_ORIGIN }, async (baseUrl) => {
      assertEqual((await fetch(`${baseUrl}/api/projects`)).status, 501, "no repository configured");
    });
  });

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
