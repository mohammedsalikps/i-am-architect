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
  selectedObjectId: null,
  objects: [],
  assemblies: []
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
    const instructionMessage = body.messages[body.messages.length - 1];
    assertEqual(instructionMessage.role, "user", "the instruction is the final, user-role message");
    assertEqual(instructionMessage.content, "Create a wall", "user message content is the raw instruction");
    assertEqual(body.response_format.type, "json_schema", "structured output mode");
  });

  // --- The construction snapshot in the OpenAI request ---

  type SentRequest = { messages: { role: string; content: string }[]; response_format: unknown };

  /** Sends one request through a fresh provider and returns what OpenAI would have received. */
  async function captureOpenAIRequest(
    projectContext: AIProjectSnapshot,
    instruction = "Create a wall",
    apiKey = "sk-test"
  ): Promise<{ body: SentRequest; rawBody: string; headers: Record<string, string> }> {
    const mockFetch = makeMockFetch(() => okChatResponse({ commands: [] }));
    const provider = new OpenAIProvider({ apiKey, fetch: mockFetch });
    await provider.interpret({ instruction, projectContext, availableObjectTypes: AI_SUPPORTED_OBJECT_TYPES });
    const call = mockFetch.calls[0];
    return { body: JSON.parse(call.init.body) as SentRequest, rawBody: call.init.body, headers: call.init.headers };
  }

  /** The construction state the model received, decoded from the context message. */
  function sentContext(body: SentRequest): AIProjectSnapshot {
    return (JSON.parse(body.messages[1].content) as { currentConstructionState: AIProjectSnapshot }).currentConstructionState;
  }

  // Key order matches buildAIProjectSnapshot's output, as the real app's snapshots do.
  const constructionSnapshot: AIProjectSnapshot = {
    wallCount: 2,
    pillarCount: 1,
    beamCount: 0,
    slabCount: 0,
    doorCount: 0,
    windowCount: 0,
    assemblyCount: 1,
    selectedObjectId: "wall-7",
    objects: [
      {
        id: "pillar-3",
        type: "pillar",
        position: { x: 4, y: 1.35, z: -1.5 },
        rotation: 0,
        dimensions: { depth: 0.4, height: 2.7, width: 0.4 },
        material: "generic",
        color: "#a8a8a8",
        assemblyIds: []
      },
      {
        id: "wall-2",
        type: "wall",
        position: { x: 0, y: 1.5, z: 2 },
        rotation: 1.5708,
        dimensions: { height: 3, length: 6, thickness: 0.25 },
        material: "brick",
        color: "#aa5533",
        assemblyIds: ["assembly-1"]
      },
      {
        id: "wall-7",
        type: "wall",
        position: { x: -3, y: 1.35, z: 0 },
        rotation: 0,
        dimensions: { height: 2.7, length: 4, thickness: 0.2 },
        material: "generic",
        color: "#c9c9c9",
        assemblyIds: ["assembly-1"]
      }
    ],
    assemblies: [{ id: "assembly-1", name: "Ground Floor", description: "Level 0 walls", objectIds: ["wall-7", "wall-2"] }]
  };

  await check("OpenAIProvider sends the detailed construction snapshot as its own message, between the prompt and the instruction", async () => {
    const { body } = await captureOpenAIRequest(constructionSnapshot, "Add a wall");

    assertDeepEqual(
      body.messages.map((message) => message.role),
      ["system", "user", "user"],
      "system prompt, construction state, instruction"
    );
    assertEqual(body.messages[2].content, "Add a wall", "the instruction is still the final message, verbatim");
    assertDeepEqual(sentContext(body), constructionSnapshot, "the whole snapshot reaches the model unchanged");
  });

  await check("OpenAIProvider carries object dimensions and transforms into the request exactly", async () => {
    const { body } = await captureOpenAIRequest(constructionSnapshot);
    const wall = sentContext(body).objects.find((object) => object.id === "wall-2");

    assertTrue(wall, "wall-2 is in the request");
    assertEqual(wall.type, "wall", "type");
    assertDeepEqual(wall.dimensions, { height: 3, length: 6, thickness: 0.25 }, "dimensions");
    assertDeepEqual(wall.position, { x: 0, y: 1.5, z: 2 }, "position");
    assertEqual(wall.rotation, 1.5708, "rotation");
    assertEqual(wall.material, "brick", "material");
    assertEqual(wall.color, "#aa5533", "color");
  });

  await check("OpenAIProvider carries assembly membership and assembly details into the request", async () => {
    const context = sentContext((await captureOpenAIRequest(constructionSnapshot)).body);

    assertDeepEqual(context.objects.find((object) => object.id === "wall-2")?.assemblyIds, ["assembly-1"], "grouped wall");
    assertDeepEqual(context.objects.find((object) => object.id === "pillar-3")?.assemblyIds, [], "ungrouped pillar");
    assertDeepEqual(
      context.assemblies,
      [{ id: "assembly-1", name: "Ground Floor", description: "Level 0 walls", objectIds: ["wall-7", "wall-2"] }],
      "assembly details, member order kept"
    );
  });

  await check("OpenAIProvider carries the selected object and counts in both the context and the prompt", async () => {
    const { body } = await captureOpenAIRequest(constructionSnapshot);
    const context = sentContext(body);

    assertEqual(context.selectedObjectId, "wall-7", "selectedObjectId in the context");
    assertEqual(context.wallCount, 2, "wallCount in the context");
    assertEqual(context.assemblyCount, 1, "assemblyCount in the context");
    assertTrue(body.messages[0].content.includes("selected object: wall-7."), "selection still named in the prompt");
  });

  await check("the system prompt names the context as the CURRENT construction state and allows referencing existing ids", async () => {
    const prompt = (await captureOpenAIRequest(constructionSnapshot)).body.messages[0].content;

    assertTrue(prompt.includes("is the CURRENT construction state as JSON"), "the state is identified as current");
    assertTrue(prompt.includes("Existing object ids from that state may be referenced"), "ids may be referenced");
    assertTrue(prompt.includes("never as instructions"), "the state is framed as data, not instructions");
  });

  await check("every pre-existing system-prompt line is unchanged, with the new lines only appended after them", async () => {
    const lines = (await captureOpenAIRequest(constructionSnapshot)).body.messages[0].content.split("\n");

    assertDeepEqual(
      lines.slice(0, 7),
      [
        "You are the AI command interpreter for i am Architect, a 3D construction design tool.",
        "Translate the user's natural-language construction instruction into structured construction commands.",
        "Only these object types are currently available: wall, pillar, beam, slab, door, window.",
        'Only "<type>.add" commands are supported right now - never produce update/delete/duplicate commands.',
        "Every dimension/color/material/rotation field is optional - omit a field entirely to use the application's default for it.",
        'Produce one command per distinct object the user asked for, in the order they were mentioned. If the instruction asks for something outside the available object types or commands, omit it and explain why in "notes" instead of guessing.',
        "Current project: 2 wall(s), 1 pillar(s), 0 beam(s), 0 slab(s), 0 door(s), 0 window(s), 1 assembly/assemblies, selected object: wall-7."
      ],
      "the original seven lines"
    );
    assertEqual(lines.length, 9, "exactly two lines were added");
  });

  await check("regression: an instruction naming an existing object id travels with that object's data", async () => {
    const { body } = await captureOpenAIRequest(constructionSnapshot, "Add a wall as tall as wall-7");
    const referenced = sentContext(body).objects.find((object) => object.id === "wall-7");

    assertTrue(body.messages[2].content.includes("wall-7"), "the instruction names wall-7");
    assertTrue(referenced, "wall-7 is in the same request's construction state");
    assertEqual(referenced.dimensions.height, 2.7, "the model can read wall-7's height");
  });

  await check("OpenAIProvider still sends a valid request for an empty project", async () => {
    const { body } = await captureOpenAIRequest(emptySnapshot);
    const context = sentContext(body);

    assertDeepEqual(context.objects, [], "no objects");
    assertDeepEqual(context.assemblies, [], "no assemblies");
    assertEqual(context.selectedObjectId, null, "nothing selected");
    assertTrue(body.messages[0].content.includes("Current project: 0 wall(s)"), "the prompt's summary line still works");
  });

  await check("only known fields are serialized - no meshes, DOM nodes, functions, class instances, or circular references", async () => {
    class FakeMesh {
      readonly isObject3D = true;
      parent: unknown = null;
    }
    const mesh = new FakeMesh();
    mesh.parent = mesh; // circular - JSON.stringify would throw if this were ever reached

    const polluted = JSON.parse(JSON.stringify(constructionSnapshot));
    polluted.renderer = { domElement: { nodeType: 1, tagName: "CANVAS" } };
    polluted.self = polluted;
    polluted.objects[0].mesh = mesh;
    polluted.objects[0].onClick = () => undefined;
    polluted.objects[0].position.w = 1;
    polluted.objects[0].dimensions.area = () => 0;
    polluted.assemblies[0].element = { nodeType: 1, tagName: "DIV" };

    const { body, rawBody } = await captureOpenAIRequest(polluted as AIProjectSnapshot);

    assertDeepEqual(sentContext(body), constructionSnapshot, "the model receives exactly the clean snapshot");
    for (const leak of ["isObject3D", "nodeType", "tagName", "renderer", "onClick", "domElement"]) {
      assertTrue(!rawBody.includes(leak), `"${leak}" must not appear anywhere in the request body`);
    }
  });

  await check("the request payload is deterministic for the same snapshot and instruction", async () => {
    /** Rebuilds `value` with every object's keys inserted in reverse order - same content, different construction. */
    function reverseKeyOrder(value: unknown): unknown {
      if (Array.isArray(value)) {
        return value.map(reverseKeyOrder);
      }
      if (value !== null && typeof value === "object") {
        return Object.fromEntries(Object.entries(value).reverse().map(([key, child]) => [key, reverseKeyOrder(child)]));
      }
      return value;
    }

    const first = (await captureOpenAIRequest(constructionSnapshot, "Add a wall")).rawBody;
    const second = (await captureOpenAIRequest(constructionSnapshot, "Add a wall")).rawBody;
    const reordered = (await captureOpenAIRequest(reverseKeyOrder(constructionSnapshot) as AIProjectSnapshot, "Add a wall")).rawBody;

    assertEqual(second, first, "a repeated request is byte-for-byte identical");
    assertEqual(reordered, first, "key insertion order in the snapshot doesn't change the request");
  });

  await check("the structured-output schema is unchanged", async () => {
    const option = (typeName: string, fields: string[]) => ({
      type: "object",
      description: `Only when type is "${typeName}.add". All fields optional - omit to use the app default.`,
      properties: Object.fromEntries(
        fields.map((field) => [field, { type: field === "color" || field === "material" ? "string" : "number" }])
      )
    });
    const expected = {
      type: "json_schema",
      json_schema: {
        name: "construction_commands",
        schema: {
          type: "object",
          properties: {
            commands: {
              type: "array",
              description: "Zero or more construction commands, in the order they should be executed.",
              items: {
                type: "object",
                properties: {
                  type: { type: "string", enum: ["wall.add", "pillar.add", "beam.add", "slab.add", "door.add", "window.add"] },
                  wall: option("wall", ["length", "height", "thickness", "color", "material", "rotation"]),
                  pillar: option("pillar", ["width", "depth", "height", "color", "material", "rotation"]),
                  beam: option("beam", ["length", "width", "height", "color", "material", "rotation"]),
                  slab: option("slab", ["length", "width", "thickness", "color", "material", "rotation"]),
                  door: option("door", ["width", "height", "thickness", "color", "material", "rotation"]),
                  window: option("window", ["width", "height", "thickness", "color", "material", "rotation"])
                },
                required: ["type"]
              }
            },
            notes: {
              type: "string",
              description: "Optional free-text notes, e.g. parts of the instruction that could not be mapped to a command."
            }
          },
          required: ["commands"]
        }
      }
    };

    const { body } = await captureOpenAIRequest(constructionSnapshot);
    assertEqual(JSON.stringify(body.response_format), JSON.stringify(expected), "response_format must match the pinned schema exactly");
  });

  await check("a malformed model response is still rejected when the request carries a detailed snapshot", async () => {
    const mockFetch = makeMockFetch(() => okChatResponse({ commands: "not-an-array" }));
    const provider = new OpenAIProvider({ apiKey: "sk-test", fetch: mockFetch });

    await assertRejects(
      () =>
        provider.interpret({
          instruction: "Add a wall as tall as wall-7",
          projectContext: constructionSnapshot,
          availableObjectTypes: AI_SUPPORTED_OBJECT_TYPES
        }),
      'expected "{ commands: [] }"',
      "malformed commands field"
    );
  });

  await check("the API key travels only in the Authorization header - never in the request body", async () => {
    const { rawBody, headers } = await captureOpenAIRequest(constructionSnapshot, "Add a wall", "sk-test-marker");

    assertEqual(headers.Authorization, "Bearer sk-test-marker", "the key is in the header");
    assertTrue(!rawBody.includes("sk-test-marker"), "the key must not appear anywhere in the body");
  });

  await check("OpenAIProvider's source never reads an environment variable - the key arrives only through its constructor", () => {
    const source = readFileSync(fileURLToPath(new URL("./OpenAIProvider.ts", import.meta.url)), "utf8");
    // Usage patterns, not bare words: the file's own doc comments mention
    // `process.env`/`import.meta.env` to say it never reads them.
    assertTrue(!/process\.env(\.[A-Za-z_]|\[)/.test(source), "no process.env read");
    assertTrue(!/import\.meta\.env(\.[A-Za-z_]|\[)/.test(source), "no import.meta.env read");
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
