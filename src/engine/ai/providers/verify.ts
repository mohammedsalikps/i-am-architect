/**
 * Lightweight in-memory verification for OpenAIProvider - request
 * shaping, response parsing, every required error case (missing key,
 * failed request, malformed response), and end-to-end integration
 * through the real AICommandPipeline. Same approach as every other
 * verify.ts in this project: no test framework, plain assertion
 * helpers, run directly by Node. Run with:
 *   npm run verify
 * or directly:
 *   node src/engine/ai/providers/verify.ts
 *
 * Every check below constructs OpenAIProvider with a hand-rolled mock
 * `fetch` function (see makeMockFetch()) - never the real global
 * `fetch`, never a real API key, and OpenAIProvider itself never falls
 * back to a global transport (see OpenAIProvider.ts's constructor).
 * That combination is what guarantees this file makes zero real network
 * calls: nothing here has a code path capable of reaching
 * api.openai.com. Every mock fetch call is also counted, and every
 * check that expects exactly one request asserts that count - see
 * "no real API request" checks below.
 *
 * Explicit .ts extensions below are required for Node's native
 * TypeScript support to resolve these relative imports (see
 * allowImportingTsExtensions in tsconfig.json) - this file is run
 * directly by Node, not bundled by Vite.
 */
import { OpenAIProvider } from "./OpenAIProvider.ts";
import type { OpenAIFetch, OpenAIHttpResponse } from "./OpenAIProvider.ts";
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
