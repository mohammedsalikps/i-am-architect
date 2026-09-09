/**
 * Lightweight in-memory verification for this directory's two real
 * (network-backed) AIProvider implementations - OpenAIProvider (talks
 * to OpenAI directly) and BackendAIProvider (talks to the AI proxy
 * backend under backend/ - see its own section below). Same approach as
 * every other verify.ts in this project: no test framework, plain
 * assertion helpers, run directly by Node. Run with:
 *   npm run verify
 * or directly:
 *   node src/engine/ai/providers/verify.ts
 *
 * Every check below constructs its provider with a hand-rolled mock
 * `fetch` function - never the real global `fetch`, never a real
 * secret of any kind, and neither provider ever falls back to a global
 * transport on its own (see each class's constructor). That combination
 * is what guarantees this file makes zero real network calls: nothing
 * here has a code path capable of reaching api.openai.com OR a real AI
 * proxy backend. Every mock fetch call is also counted, and every check
 * that expects exactly one request asserts that count.
 *
 * Explicit .ts extensions below are required for Node's native
 * TypeScript support to resolve these relative imports (see
 * allowImportingTsExtensions in tsconfig.json) - this file is run
 * directly by Node, not bundled by Vite.
 */
// "node:fs"/"node:url" below are typed by src/node-builtins.d.ts, a
// minimal shared ambient shim - see that file's own header comment for
// why it exists instead of an @types/node dependency.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { OpenAIProvider } from "./OpenAIProvider.ts";
import type { OpenAIFetch, OpenAIHttpResponse } from "./OpenAIProvider.ts";
import { BackendAIProvider } from "./BackendAIProvider.ts";
import type { BackendFetch, BackendHttpResponse } from "./BackendAIProvider.ts";
import { AICommandPipeline } from "../AICommandPipeline.ts";
import type { CommandExecutorLike } from "../AICommandPipeline.ts";
import { AI_SUPPORTED_OBJECT_TYPES } from "../types.ts";
import type { AIProjectSnapshot } from "../types.ts";
import type { CommandResult } from "../../commands/types.ts";

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

async function assertRejects(fn: () => Promise<unknown>, messageIncludes: string, context: string): Promise<void> {
  try {
    await fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    assertTrue(message.includes(messageIncludes), `${context}: expected error message to include "${messageIncludes}", got "${message}"`);
    return;
  }
  throw new Error(`${context}: expected a rejection, but none occurred`);
}

const emptySnapshot: AIProjectSnapshot = {
  wallCount: 0,
  pillarCount: 0,
  beamCount: 0,
  slabCount: 0,
  doorCount: 0,
  windowCount: 0,
  assemblyCount: 0,
  selectedObjectId: null
};

type MockFetchCall = { url: string; init: { method: "POST"; headers: Record<string, string>; body: string } };

/**
 * A hand-rolled OpenAIFetch mock - records every call and delegates the
 * actual response to `handler`. This is the ONLY transport any check in
 * this file ever supplies to OpenAIProvider, and it never touches the
 * network - `handler` returns/resolves a plain in-memory object.
 */
function makeMockFetch(
  handler: (call: MockFetchCall) => OpenAIHttpResponse | Promise<OpenAIHttpResponse>
): OpenAIFetch & { calls: MockFetchCall[] } {
  const calls: MockFetchCall[] = [];
  const fetchImpl = async (
    url: string,
    init: { method: "POST"; headers: Record<string, string>; body: string }
  ): Promise<OpenAIHttpResponse> => {
    const call = { url, init };
    calls.push(call);
    return handler(call);
  };
  return Object.assign(fetchImpl, { calls });
}

/** A well-formed OpenAI Chat Completions HTTP response wrapping `content` as the model's message content. */
function okChatResponse(content: unknown): OpenAIHttpResponse {
  const serialized = JSON.stringify(content);
  return {
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content: serialized } }] }),
    text: async () => serialized
  };
}

/** A CommandExecutorLike spy - mirrors the one in ai/verify.ts. */
function makeExecutorSpy(
  resultFor: (input: unknown) => CommandResult = () => ({ success: true, message: "ok" })
): CommandExecutorLike & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    execute(input: unknown): CommandResult {
      calls.push(input);
      return resultFor(input);
    }
  };
}

// --- BackendAIProvider-specific helpers ---

type MockBackendFetchCall = {
  url: string;
  init: { method: "POST"; headers: Record<string, string>; body: string; signal?: AbortSignal };
};

/** Mirrors makeMockFetch above, for BackendFetch instead of OpenAIFetch - a hand-rolled mock that never touches the network. */
function makeMockBackendFetch(
  handler: (call: MockBackendFetchCall) => BackendHttpResponse | Promise<BackendHttpResponse>
): BackendFetch & { calls: MockBackendFetchCall[] } {
  const calls: MockBackendFetchCall[] = [];
  const fetchImpl: BackendFetch = async (url, init) => {
    const call = { url, init };
    calls.push(call);
    return handler(call);
  };
  return Object.assign(fetchImpl, { calls });
}

/** A well-formed backend HTTP response wrapping `body` (an `{ commands, notes? }`-shaped object) as JSON. */
function okBackendResponse(body: unknown): BackendHttpResponse {
  const serialized = JSON.stringify(body);
  return {
    ok: true,
    status: 200,
    json: async () => JSON.parse(serialized),
    text: async () => serialized
  };
}

/**
 * A BackendFetch that respects an AbortSignal the way a real `fetch`
 * does - resolves after `delayMs` unless aborted first, in which case
 * it rejects immediately with an AbortError-shaped error. Lets the
 * timeout check below be fast and deterministic (BackendAIProvider's
 * own short `timeoutMs` fires well before `delayMs` ever would), rather
 * than actually waiting out a long delay.
 */
function makeSlowBackendFetch(delayMs: number): BackendFetch {
  return (_url, init) =>
    new Promise<BackendHttpResponse>((resolve, reject) => {
      const timer = setTimeout(() => resolve(okBackendResponse({ commands: [] })), delayMs);
      init.signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new DOMException("The operation was aborted.", "AbortError"));
      });
    });
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

  console.log("OpenAIProvider verification\n");

  // --- Missing API key / missing transport ---

  await check("OpenAIProvider throws a clear error when constructed without an API key", () => {
    let threw = false;
    try {
      new OpenAIProvider({ apiKey: "", fetch: makeMockFetch(() => okChatResponse({ commands: [] })) });
    } catch (error) {
      threw = true;
      const message = error instanceof Error ? error.message : String(error);
      assertTrue(message.includes("API key"), 'error message should mention "API key"');
    }
    assertTrue(threw, "constructing without an API key should throw");
  });

  await check("OpenAIProvider throws a clear error when constructed with only whitespace as the API key", () => {
    let threw = false;
    try {
      new OpenAIProvider({ apiKey: "   ", fetch: makeMockFetch(() => okChatResponse({ commands: [] })) });
    } catch {
      threw = true;
    }
    assertTrue(threw, "constructing with a whitespace-only API key should throw");
  });

  await check("OpenAIProvider throws a clear error when constructed without a fetch transport", () => {
    let threw = false;
    try {
      new OpenAIProvider({ apiKey: "sk-test" } as unknown as ConstructorParameters<typeof OpenAIProvider>[0]);
    } catch (error) {
      threw = true;
      const message = error instanceof Error ? error.message : String(error);
      assertTrue(message.includes("fetch"), 'error message should mention "fetch"');
    }
    assertTrue(threw, "constructing without a fetch transport should throw");
  });

  // --- Request shaping ---

  await check("OpenAIProvider sends the instruction and structured response_format in the request", async () => {
    const mockFetch = makeMockFetch(() => okChatResponse({ commands: [{ type: "wall.add", wall: {} }] }));
    const provider = new OpenAIProvider({ apiKey: "sk-test", fetch: mockFetch });

    await provider.interpret({
      instruction: "Create a wall",
      projectContext: emptySnapshot,
      availableObjectTypes: AI_SUPPORTED_OBJECT_TYPES
    });

    assertEqual(mockFetch.calls.length, 1, "exactly one request should have been made");
    const call = mockFetch.calls[0];
    assertEqual(call.init.method, "POST", "request method");
    assertEqual(call.init.headers.Authorization, "Bearer sk-test", "Authorization header");
    assertEqual(call.init.headers["Content-Type"], "application/json", "Content-Type header");

    const body = JSON.parse(call.init.body) as {
      messages: { role: string; content: string }[];
      response_format: { type: string };
    };
    assertEqual(body.messages[1].role, "user", "user message role");
    assertEqual(body.messages[1].content, "Create a wall", "user message content is the raw instruction");
    assertEqual(body.response_format.type, "json_schema", "structured output mode");
  });

  // --- Response parsing: single and multi-command, all six object types ---

  await check("OpenAIProvider parses a well-formed structured response into a command", async () => {
    const mockFetch = makeMockFetch(() => okChatResponse({ commands: [{ type: "wall.add", wall: { length: 5 } }] }));
    const provider = new OpenAIProvider({ apiKey: "sk-test", fetch: mockFetch });

    const response = await provider.interpret({
      instruction: "Create a 5 meter wall",
      projectContext: emptySnapshot,
      availableObjectTypes: AI_SUPPORTED_OBJECT_TYPES
    });

    assertDeepEqual(response.commands, [{ type: "wall.add", wall: { length: 5 } }], "parsed commands");
  });

  await check("OpenAIProvider supports all six object types across one multi-command response", async () => {
    const commands = [
      { type: "wall.add", wall: {} },
      { type: "pillar.add", pillar: {} },
      { type: "beam.add", beam: {} },
      { type: "slab.add", slab: {} },
      { type: "door.add", door: {} },
      { type: "window.add", window: {} }
    ];
    const mockFetch = makeMockFetch(() => okChatResponse({ commands }));
    const provider = new OpenAIProvider({ apiKey: "sk-test", fetch: mockFetch });

    const response = await provider.interpret({
      instruction: "Create a wall, a pillar, a beam, a slab, a door, and a window",
      projectContext: emptySnapshot,
      availableObjectTypes: AI_SUPPORTED_OBJECT_TYPES
    });

    assertEqual(response.commands.length, 6, "commands.length");
    assertDeepEqual(response.commands, commands, "commands, in order");
  });

  await check("OpenAIProvider preserves the model's notes field", async () => {
    const mockFetch = makeMockFetch(() =>
      okChatResponse({ commands: [{ type: "wall.add", wall: {} }], notes: "assumed default dimensions" })
    );
    const provider = new OpenAIProvider({ apiKey: "sk-test", fetch: mockFetch });

    const response = await provider.interpret({
      instruction: "Create a wall",
      projectContext: emptySnapshot,
      availableObjectTypes: AI_SUPPORTED_OBJECT_TYPES
    });

    assertEqual(response.notes, "assumed default dimensions", "notes");
  });

  // --- Required error cases (requirement: missing key / failed request / malformed response) ---

  await check("OpenAIProvider throws when the HTTP request itself fails", async () => {
    const mockFetch: OpenAIFetch = async () => {
      throw new Error("ECONNRESET");
    };
    const provider = new OpenAIProvider({ apiKey: "sk-test", fetch: mockFetch });

    await assertRejects(
      () =>
        provider.interpret({
          instruction: "Create a wall",
          projectContext: emptySnapshot,
          availableObjectTypes: AI_SUPPORTED_OBJECT_TYPES
        }),
      "OpenAI request failed",
      "network failure"
    );
  });

  await check("OpenAIProvider throws with the status code when OpenAI returns a non-OK response", async () => {
    const mockFetch = makeMockFetch(() => ({
      ok: false,
      status: 401,
      json: async () => ({ error: "invalid_api_key" }),
      text: async () => "invalid_api_key"
    }));
    const provider = new OpenAIProvider({ apiKey: "sk-bad", fetch: mockFetch });

    await assertRejects(
      () =>
        provider.interpret({
          instruction: "Create a wall",
          projectContext: emptySnapshot,
          availableObjectTypes: AI_SUPPORTED_OBJECT_TYPES
        }),
      "401",
      "non-OK HTTP status"
    );
  });

  await check("OpenAIProvider throws when the HTTP body is not valid JSON", async () => {
    const mockFetch = makeMockFetch(() => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError("Unexpected token");
      },
      text: async () => "not json"
    }));
    const provider = new OpenAIProvider({ apiKey: "sk-test", fetch: mockFetch });

    await assertRejects(
      () =>
        provider.interpret({
          instruction: "Create a wall",
          projectContext: emptySnapshot,
          availableObjectTypes: AI_SUPPORTED_OBJECT_TYPES
        }),
      "not valid JSON",
      "malformed HTTP body"
    );
  });

  await check("OpenAIProvider throws when the response is missing choices[0].message.content", async () => {
    const mockFetch = makeMockFetch(() => ({
      ok: true,
      status: 200,
      json: async () => ({ choices: [] }),
      text: async () => "{}"
    }));
    const provider = new OpenAIProvider({ apiKey: "sk-test", fetch: mockFetch });

    await assertRejects(
      () =>
        provider.interpret({
          instruction: "Create a wall",
          projectContext: emptySnapshot,
          availableObjectTypes: AI_SUPPORTED_OBJECT_TYPES
        }),
      "malformed",
      "missing choices/message/content"
    );
  });

  await check("OpenAIProvider throws when the model's message content is not valid JSON", async () => {
    const mockFetch = makeMockFetch(() => ({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: "not-json{" } }] }),
      text: async () => "not-json{"
    }));
    const provider = new OpenAIProvider({ apiKey: "sk-test", fetch: mockFetch });

    await assertRejects(
      () =>
        provider.interpret({
          instruction: "Create a wall",
          projectContext: emptySnapshot,
          availableObjectTypes: AI_SUPPORTED_OBJECT_TYPES
        }),
      "content was not valid JSON",
      "malformed message content"
    );
  });

  await check('OpenAIProvider throws when parsed content is missing a "commands" array', async () => {
    const mockFetch = makeMockFetch(() => okChatResponse({ somethingElse: true }));
    const provider = new OpenAIProvider({ apiKey: "sk-test", fetch: mockFetch });

    await assertRejects(
      () =>
        provider.interpret({
          instruction: "Create a wall",
          projectContext: emptySnapshot,
          availableObjectTypes: AI_SUPPORTED_OBJECT_TYPES
        }),
      'expected "{ commands: [] }"',
      "missing commands array"
    );
  });

  // --- End-to-end integration through the real AICommandPipeline ---

  await check(
    "AICommandPipeline executes OpenAIProvider output end-to-end via a mocked transport, making exactly one request",
    async () => {
      const mockFetch = makeMockFetch(() =>
        okChatResponse({ commands: [{ type: "wall.add", wall: {} }, { type: "pillar.add", pillar: {} }] })
      );
      const provider = new OpenAIProvider({ apiKey: "sk-test", fetch: mockFetch });
      const executor = makeExecutorSpy();
      const pipeline = new AICommandPipeline(provider, executor);

      const result = await pipeline.run("Create a wall and a pillar", emptySnapshot);

      assertTrue(result.success, "result.success");
      assertEqual(mockFetch.calls.length, 1, "exactly one (mocked) OpenAI request should have been made");
      assertEqual(executor.calls.length, 2, "both commands should have reached CommandExecutor");
      assertDeepEqual(executor.calls[0], { type: "wall.add", wall: {} }, "first command");
      assertDeepEqual(executor.calls[1], { type: "pillar.add", pillar: {} }, "second command");
    }
  );

  await check("AICommandPipeline surfaces an OpenAIProvider request failure as a provider-stage pipeline error", async () => {
    const mockFetch = makeMockFetch(() => ({
      ok: false,
      status: 500,
      json: async () => ({}),
      text: async () => "internal_error"
    }));
    const provider = new OpenAIProvider({ apiKey: "sk-test", fetch: mockFetch });
    const executor = makeExecutorSpy();
    const pipeline = new AICommandPipeline(provider, executor);

    const result = await pipeline.run("Create a wall", emptySnapshot);

    assertEqual(result.success, false, "result.success");
    assertEqual(result.errors[0].stage, "provider", "error stage");
    assertTrue(result.errors[0].message.includes("500"), "error message should include the HTTP status");
    assertEqual(executor.calls.length, 0, "executor should never be called");
  });

  await check(
    "AICommandPipeline rejects an unsupported command from OpenAIProvider the same way it rejects any other provider's",
    async () => {
      const mockFetch = makeMockFetch(() => okChatResponse({ commands: [{ type: "roof.add", roof: {} }] }));
      const provider = new OpenAIProvider({ apiKey: "sk-test", fetch: mockFetch });
      const executor = makeExecutorSpy();
      const pipeline = new AICommandPipeline(provider, executor);

      const result = await pipeline.run("Create a roof", emptySnapshot);

      assertEqual(result.success, false, "result.success");
      assertEqual(result.errors[0].stage, "validation", "error stage");
      assertTrue(result.errors[0].message.includes("Unsupported object type"), "error message");
      assertEqual(executor.calls.length, 0, "executor should never be called");
    }
  );

  // --- BackendAIProvider ---

  console.log("\nBackendAIProvider verification\n");

  await check("BackendAIProvider throws a clear error when constructed without a baseUrl", () => {
    let threw = false;
    try {
      new BackendAIProvider({ baseUrl: "", fetch: makeMockBackendFetch(() => okBackendResponse({ commands: [] })) });
    } catch (error) {
      threw = true;
      const message = error instanceof Error ? error.message : String(error);
      assertTrue(message.includes("baseUrl"), 'error message should mention "baseUrl"');
    }
    assertTrue(threw, "constructing without a baseUrl should throw");
  });

  await check("BackendAIProvider throws a clear error when constructed without a fetch transport", () => {
    let threw = false;
    try {
      new BackendAIProvider({ baseUrl: "http://localhost:8787" } as unknown as ConstructorParameters<
        typeof BackendAIProvider
      >[0]);
    } catch (error) {
      threw = true;
      const message = error instanceof Error ? error.message : String(error);
      assertTrue(message.includes("fetch"), 'error message should mention "fetch"');
    }
    assertTrue(threw, "constructing without a fetch transport should throw");
  });

  await check("BackendAIProvider sends a POST to <baseUrl>/api/ai/interpret with the exact provider contract as the body", async () => {
    const mockFetch = makeMockBackendFetch(() => okBackendResponse({ commands: [{ type: "wall.add", wall: {} }] }));
    const provider = new BackendAIProvider({ baseUrl: "http://localhost:8787", fetch: mockFetch });

    await provider.interpret({
      instruction: "Create a wall",
      projectContext: emptySnapshot,
      availableObjectTypes: AI_SUPPORTED_OBJECT_TYPES
    });

    assertEqual(mockFetch.calls.length, 1, "exactly one request should have been made");
    const call = mockFetch.calls[0];
    assertEqual(call.url, "http://localhost:8787/api/ai/interpret", "request URL");
    assertEqual(call.init.method, "POST", "request method");
    assertEqual(call.init.headers["Content-Type"], "application/json", "Content-Type header");
    assertEqual(call.init.headers.Authorization, undefined, "no Authorization header should ever be sent");

    assertDeepEqual(
      JSON.parse(call.init.body),
      { instruction: "Create a wall", projectContext: emptySnapshot, availableObjectTypes: AI_SUPPORTED_OBJECT_TYPES },
      "request body is exactly { instruction, projectContext, availableObjectTypes }"
    );
  });

  await check("BackendAIProvider strips a trailing slash from baseUrl before building the request URL", async () => {
    const mockFetch = makeMockBackendFetch(() => okBackendResponse({ commands: [] }));
    const provider = new BackendAIProvider({ baseUrl: "http://localhost:8787/", fetch: mockFetch });

    await provider.interpret({
      instruction: "Create a wall",
      projectContext: emptySnapshot,
      availableObjectTypes: AI_SUPPORTED_OBJECT_TYPES
    });

    assertEqual(mockFetch.calls[0].url, "http://localhost:8787/api/ai/interpret", "no doubled slash");
  });

  await check("BackendAIProvider parses a well-formed backend response into commands", async () => {
    const mockFetch = makeMockBackendFetch(() =>
      okBackendResponse({ commands: [{ type: "pillar.add", pillar: {} }], notes: "used default dimensions" })
    );
    const provider = new BackendAIProvider({ baseUrl: "http://localhost:8787", fetch: mockFetch });

    const response = await provider.interpret({
      instruction: "Add a pillar",
      projectContext: emptySnapshot,
      availableObjectTypes: AI_SUPPORTED_OBJECT_TYPES
    });

    assertDeepEqual(response, { commands: [{ type: "pillar.add", pillar: {} }], notes: "used default dimensions" }, "response");
  });

  await check("BackendAIProvider throws with the status code and body when the backend returns a non-OK response", async () => {
    const mockFetch = makeMockBackendFetch(() => ({
      ok: false,
      status: 502,
      json: async () => ({ error: "Backend request failed with status 401: invalid_api_key" }),
      text: async () => "Backend request failed with status 401: invalid_api_key"
    }));
    const provider = new BackendAIProvider({ baseUrl: "http://localhost:8787", fetch: mockFetch });

    await assertRejects(
      () =>
        provider.interpret({
          instruction: "Create a wall",
          projectContext: emptySnapshot,
          availableObjectTypes: AI_SUPPORTED_OBJECT_TYPES
        }),
      "502",
      "non-OK HTTP status"
    );
  });

  await check("BackendAIProvider throws when the backend's response body is not valid JSON", async () => {
    const mockFetch = makeMockBackendFetch(() => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError("Unexpected token");
      },
      text: async () => "not json"
    }));
    const provider = new BackendAIProvider({ baseUrl: "http://localhost:8787", fetch: mockFetch });

    await assertRejects(
      () =>
        provider.interpret({
          instruction: "Create a wall",
          projectContext: emptySnapshot,
          availableObjectTypes: AI_SUPPORTED_OBJECT_TYPES
        }),
      "not valid JSON",
      "malformed HTTP body"
    );
  });

  await check('BackendAIProvider throws when the response is missing a "commands" array', async () => {
    const mockFetch = makeMockBackendFetch(() => okBackendResponse({ somethingElse: true }));
    const provider = new BackendAIProvider({ baseUrl: "http://localhost:8787", fetch: mockFetch });

    await assertRejects(
      () =>
        provider.interpret({
          instruction: "Create a wall",
          projectContext: emptySnapshot,
          availableObjectTypes: AI_SUPPORTED_OBJECT_TYPES
        }),
      'expected "{ commands: [] }"',
      "missing commands array"
    );
  });

  await check("BackendAIProvider throws when the underlying fetch fails (network failure)", async () => {
    const mockFetch: BackendFetch = async () => {
      throw new Error("ECONNREFUSED");
    };
    const provider = new BackendAIProvider({ baseUrl: "http://localhost:8787", fetch: mockFetch });

    await assertRejects(
      () =>
        provider.interpret({
          instruction: "Create a wall",
          projectContext: emptySnapshot,
          availableObjectTypes: AI_SUPPORTED_OBJECT_TYPES
        }),
      "Backend request failed",
      "network failure"
    );
  });

  await check("BackendAIProvider aborts and throws a clear timeout error when the backend is too slow", async () => {
    // The mock resolves after 5000ms if never aborted; timeoutMs is 20,
    // so BackendAIProvider's own timer must abort it well before that -
    // this check would take 5s to pass instead of milliseconds if the
    // abort wiring were broken.
    const provider = new BackendAIProvider({
      baseUrl: "http://localhost:8787",
      fetch: makeSlowBackendFetch(5000),
      timeoutMs: 20
    });

    await assertRejects(
      () =>
        provider.interpret({
          instruction: "Create a wall",
          projectContext: emptySnapshot,
          availableObjectTypes: AI_SUPPORTED_OBJECT_TYPES
        }),
      "timed out after 20ms",
      "timeout"
    );
  });

  await check(
    "BackendAIProvider's source contains no OpenAI API key, secret, or Authorization header logic",
    () => {
      const sourcePath = fileURLToPath(new URL("./BackendAIProvider.ts", import.meta.url));
      const source = readFileSync(sourcePath, "utf8");

      // Checks for actual risky *usage* (an env/global read, a header
      // actually being built, a key-shaped literal, an "apiKey" field
      // this provider has no business having) - NOT a bare mention of
      // "OPENAI_API_KEY"/"Authorization" as English words, which this
      // file's own doc comments legitimately use to explain that
      // neither is present. A substring-only check would flag that
      // explanatory prose as a false positive.
      assertTrue(!source.includes("process.env"), 'source must not reference "process.env"');
      assertTrue(!source.includes("import.meta.env"), 'source must not reference "import.meta.env"');
      assertTrue(
        !/["']?Authorization["']?\s*:/i.test(source),
        "source must not construct an Authorization header (an actual object/header key, not just the word in prose)"
      );
      assertTrue(!/sk-[a-zA-Z0-9]/.test(source), "source must not contain an OpenAI-key-shaped literal");
      assertTrue(
        !/\bapiKey\b/.test(source),
        'source must not reference an "apiKey" identifier - this provider has no concept of one'
      );
    }
  );

  await check(
    "AICommandPipeline executes BackendAIProvider output end-to-end via a mocked transport, making exactly one request",
    async () => {
      const mockFetch = makeMockBackendFetch(() =>
        okBackendResponse({ commands: [{ type: "wall.add", wall: {} }, { type: "beam.add", beam: {} }] })
      );
      const provider = new BackendAIProvider({ baseUrl: "http://localhost:8787", fetch: mockFetch });
      const executor = makeExecutorSpy();
      const pipeline = new AICommandPipeline(provider, executor);

      const result = await pipeline.run("Create a wall and a beam", emptySnapshot);

      assertTrue(result.success, "result.success");
      assertEqual(mockFetch.calls.length, 1, "exactly one (mocked) backend request should have been made");
      assertEqual(executor.calls.length, 2, "both commands should have reached CommandExecutor");
      assertDeepEqual(executor.calls[0], { type: "wall.add", wall: {} }, "first command");
      assertDeepEqual(executor.calls[1], { type: "beam.add", beam: {} }, "second command");
    }
  );

  await check("AICommandPipeline surfaces a BackendAIProvider failure as a provider-stage pipeline error", async () => {
    const mockFetch = makeMockBackendFetch(() => ({
      ok: false,
      status: 502,
      json: async () => ({}),
      text: async () => "upstream failure"
    }));
    const provider = new BackendAIProvider({ baseUrl: "http://localhost:8787", fetch: mockFetch });
    const executor = makeExecutorSpy();
    const pipeline = new AICommandPipeline(provider, executor);

    const result = await pipeline.run("Create a wall", emptySnapshot);

    assertEqual(result.success, false, "result.success");
    assertEqual(result.errors[0].stage, "provider", "error stage");
    assertTrue(result.errors[0].message.includes("502"), "error message should include the HTTP status");
    assertEqual(executor.calls.length, 0, "executor should never be called");
  });

  await check(
    "AICommandPipeline rejects an unsupported command from BackendAIProvider the same way it rejects any other provider's",
    async () => {
      const mockFetch = makeMockBackendFetch(() => okBackendResponse({ commands: [{ type: "roof.add", roof: {} }] }));
      const provider = new BackendAIProvider({ baseUrl: "http://localhost:8787", fetch: mockFetch });
      const executor = makeExecutorSpy();
      const pipeline = new AICommandPipeline(provider, executor);

      const result = await pipeline.run("Create a roof", emptySnapshot);

      assertEqual(result.success, false, "result.success");
      assertEqual(result.errors[0].stage, "validation", "error stage");
      assertTrue(result.errors[0].message.includes("Unsupported object type"), "error message");
      assertEqual(executor.calls.length, 0, "executor should never be called");
    }
  );

  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) {
    throw new Error(`${failed} verification check(s) failed`);
  }
}

// See ai/verify.ts's matching comment for why this rethrows instead of
// setting `process.exitCode` - in short, an unhandled rejection already
// exits Node with a non-zero code, and `process` isn't typed here
// without @types/node.
run().catch((error) => {
  console.error(error);
  throw error;
});
