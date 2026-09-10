/**
 * Lightweight in-memory verification for the AI command pipeline -
 * MockAIProvider output, AICommandPipeline orchestration, and the
 * buildAIProjectSnapshot() helper. Same approach as every other
 * verify.ts in this project: no test framework, plain assertion
 * helpers, run directly by Node. Run with:
 *   npm run verify
 * or directly:
 *   node src/engine/ai/verify.ts
 *
 * Most checks here use a lightweight CommandExecutorLike spy (records
 * calls, returns a canned CommandResult) rather than a real
 * CommandExecutor - that's what lets this file prove AICommandPipeline
 * never mutates anything except by calling `.execute()`, without caring
 * how any particular command happens to be handled. A few checks do use
 * a real CommandExecutor backed by a real WallStore, to prove domain
 * validation (e.g. invalid dimensions) and undo/redo genuinely flow
 * through unchanged - those use the same store-backed WallHistoryLike
 * stub pattern established in src/engine/commands/verify.ts (real
 * WallHistoryController can't be instantiated here: it uses TypeScript
 * parameter-property constructor shorthand, which Node's native
 * TypeScript support can't run - see that file's header for the full
 * explanation).
 *
 * Explicit .ts extensions below are required for Node's native
 * TypeScript support to resolve these relative imports (see
 * allowImportingTsExtensions in tsconfig.json) - this file is run
 * directly by Node, not bundled by Vite.
 */
import { AICommandPipeline } from "./AICommandPipeline.ts";
import type { CommandExecutorLike } from "./AICommandPipeline.ts";
import { MockAIProvider } from "./MockAIProvider.ts";
import { AI_SUPPORTED_OBJECT_TYPES, buildAIProjectSnapshot } from "./types.ts";
import type { AIProjectSnapshot, AIProviderResponse, AIPipelineResult } from "./types.ts";
import type { AIProvider } from "./AIProvider.ts";
import { AIService } from "./AIService.ts";
import { AiPromptController, isAiPromptSubmitKey } from "./AiPromptController.ts";
import type { AiPromptState } from "./AiPromptController.ts";
import { CommandExecutor } from "../commands/CommandExecutor.ts";
import { WallStore } from "../wall/WallStore.ts";
import type { WallData, WallId } from "../wall/types.ts";
import type { WallValidationResult } from "../wall/validateWall.ts";
import type { WallHistoryLike, CommandResult } from "../commands/types.ts";
import { HistoryManager } from "../history/HistoryManager.ts";

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

/** A CommandExecutorLike spy - records every call it receives and returns a caller-controlled result, defaulting to success. */
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

/** Wraps a fixed AIProviderResponse as an AIProvider - lets tests hand AICommandPipeline provider output that a real MockAIProvider would never produce (e.g. malformed shapes), simulating an untrusted/misbehaving provider. */
function fixedProvider(response: AIProviderResponse): AIProvider {
  return { interpret: () => response };
}

/** An AIProvider that always throws - proves AICommandPipeline never lets a provider exception escape run(). */
function throwingProvider(message: string): AIProvider {
  return {
    interpret: () => {
      throw new Error(message);
    }
  };
}

/** Wraps an AIProvider, counting how many times interpret() was actually called - used to prove an empty instruction never reaches the provider. */
function makeProviderCallCounter(inner: AIProvider): AIProvider & { callCount: number } {
  let callCount = 0;
  return {
    get callCount(): number {
      return callCount;
    },
    interpret: (request) => {
      callCount += 1;
      return inner.interpret(request);
    }
  };
}

/** A WallHistoryLike stand-in backed by a real WallStore - mirrors makeWallHistoryStub in commands/verify.ts. */
function makeWallHistoryStub(store: WallStore): WallHistoryLike {
  return {
    add: (wall: WallData): WallValidationResult => store.add(wall),
    update: (id: WallId, changes: Parameters<WallHistoryLike["update"]>[1]): WallValidationResult =>
      store.update(id, changes),
    remove: (id: WallId): void => store.remove(id)
  };
}

/** A WallHistoryLike stand-in that *also* records real undo/redo pairs on a real HistoryManager - mirrors what WallHistoryController.add()/update() actually do, just without the parameter-property constructor Node can't run. Used only by the undo/redo compatibility check below. */
function makeUndoableWallHistory(store: WallStore, history: HistoryManager): WallHistoryLike {
  return {
    add(wall: WallData): WallValidationResult {
      const result = store.add(wall);
      if (result.valid) {
        history.record({
          undo: () => store.remove(wall.id),
          redo: () => store.add(wall)
        });
      }
      return result;
    },
    update(id: WallId, changes: Parameters<WallHistoryLike["update"]>[1]): WallValidationResult {
      const before = store.get(id);
      const result = store.update(id, changes);
      if (result.valid && before) {
        const after = store.get(id);
        if (after) {
          history.record({
            undo: () => store.set(id, before),
            redo: () => store.set(id, after)
          });
        }
      }
      return result;
    },
    remove(id: WallId): void {
      store.remove(id);
    }
  };
}

async function run(): Promise<void> {
  let passed = 0;
  let failed = 0;

  // async because AICommandPipeline.run() is now always a Promise (see
  // AICommandPipeline.ts) - `await fn()` works identically whether fn
  // itself is sync or async, so every existing synchronous check below
  // needed no changes beyond adding `await` at its call site.
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

  console.log("AI command pipeline verification\n");

  // --- buildAIProjectSnapshot ---

  await check("buildAIProjectSnapshot summarizes store counts and the current selection", async () => {
    const source = {
      wallStore: { getAll: () => [1, 2] },
      pillarStore: { getAll: () => [1] },
      beamStore: { getAll: () => [] },
      slabStore: { getAll: () => [1, 2, 3] },
      doorStore: { getAll: () => [1] },
      windowStore: { getAll: () => [1, 1] },
      assemblyStore: { getAll: () => [] },
      selectionStore: { get: () => "wall-1" }
    };

    assertDeepEqual(
      buildAIProjectSnapshot(source),
      {
        wallCount: 2,
        pillarCount: 1,
        beamCount: 0,
        slabCount: 3,
        doorCount: 1,
        windowCount: 2,
        assemblyCount: 0,
        selectedObjectId: "wall-1"
      },
      "snapshot"
    );
  });

  await check("buildAIProjectSnapshot reports selectedObjectId as null when nothing is selected", async () => {
    const source = {
      wallStore: { getAll: () => [] },
      pillarStore: { getAll: () => [] },
      beamStore: { getAll: () => [] },
      slabStore: { getAll: () => [] },
      doorStore: { getAll: () => [] },
      windowStore: { getAll: () => [] },
      assemblyStore: { getAll: () => [] },
      selectionStore: { get: () => null }
    };

    assertEqual(buildAIProjectSnapshot(source).selectedObjectId, null, "selectedObjectId");
  });

  // --- MockAIProvider: the six required deterministic example instructions ---

  const EXAMPLES: { instruction: string; command: Record<string, unknown> }[] = [
    { instruction: "Create a wall", command: { type: "wall.add", wall: {} } },
    { instruction: "Add a pillar", command: { type: "pillar.add", pillar: {} } },
    { instruction: "Create a beam", command: { type: "beam.add", beam: {} } },
    { instruction: "Add a slab", command: { type: "slab.add", slab: {} } },
    { instruction: "Create a door", command: { type: "door.add", door: {} } },
    { instruction: "Add a window", command: { type: "window.add", window: {} } }
  ];

  for (const example of EXAMPLES) {
    await check(`MockAIProvider maps "${example.instruction}" to a single deterministic command`, async () => {
      const provider = new MockAIProvider();
      const response = provider.interpret({
        instruction: example.instruction,
        projectContext: emptySnapshot,
        availableObjectTypes: AI_SUPPORTED_OBJECT_TYPES
      });

      assertEqual(response.commands.length, 1, "commands.length");
      assertDeepEqual(response.commands[0], example.command, "the produced command");
      assertEqual(response.notes, undefined, "notes should be absent when everything was recognized");
    });
  }

  await check("MockAIProvider produces multiple commands, in order, from one multi-clause instruction", async () => {
    const provider = new MockAIProvider();
    const response = provider.interpret({
      instruction: "Create a wall and add a pillar and create a beam",
      projectContext: emptySnapshot,
      availableObjectTypes: AI_SUPPORTED_OBJECT_TYPES
    });

    assertDeepEqual(
      response.commands,
      [
        { type: "wall.add", wall: {} },
        { type: "pillar.add", pillar: {} },
        { type: "beam.add", beam: {} }
      ],
      "commands, in order"
    );
  });

  await check("MockAIProvider reports an unrecognized clause via notes and produces no command for it", async () => {
    const provider = new MockAIProvider();
    const response = provider.interpret({
      instruction: "Do a backflip",
      projectContext: emptySnapshot,
      availableObjectTypes: AI_SUPPORTED_OBJECT_TYPES
    });

    assertEqual(response.commands.length, 0, "commands.length");
    assertTrue(response.notes && response.notes.includes("backflip"), "notes should mention the unrecognized clause");
  });

  await check("MockAIProvider treats an object type outside availableObjectTypes as unrecognized", async () => {
    const provider = new MockAIProvider();
    const response = provider.interpret({
      instruction: "Create a door",
      projectContext: emptySnapshot,
      availableObjectTypes: AI_SUPPORTED_OBJECT_TYPES.filter((type) => type !== "door")
    });

    assertEqual(response.commands.length, 0, "commands.length");
    assertTrue(response.notes && response.notes.includes("door"), "notes should mention the excluded clause");
  });

  // --- AICommandPipeline: single- and multi-command execution ---

  await check("AICommandPipeline executes a single recognized instruction end-to-end via CommandExecutor", async () => {
    const executor = makeExecutorSpy(() => ({ success: true, objectId: "wall-1", message: "Wall added." }));
    const pipeline = new AICommandPipeline(new MockAIProvider(), executor);

    const result = await pipeline.run("Create a wall", emptySnapshot);

    assertTrue(result.success, "result.success");
    assertEqual(executor.calls.length, 1, "executor.calls.length");
    assertDeepEqual(executor.calls[0], { type: "wall.add", wall: {} }, "the command passed to CommandExecutor");
    assertEqual(result.outcomes.length, 1, "result.outcomes.length");
    assertTrue(result.outcomes[0].result.success, "outcome success");
    assertEqual(result.errors.length, 0, "result.errors.length");
  });

  await check("AICommandPipeline executes every command in a multi-command instruction, in order", async () => {
    const executor = makeExecutorSpy();
    const pipeline = new AICommandPipeline(new MockAIProvider(), executor);

    const result = await pipeline.run("Create a wall and add a pillar", emptySnapshot);

    assertTrue(result.success, "result.success");
    assertEqual(executor.calls.length, 2, "executor.calls.length");
    assertDeepEqual(executor.calls[0], { type: "wall.add", wall: {} }, "first command");
    assertDeepEqual(executor.calls[1], { type: "pillar.add", pillar: {} }, "second command");
    assertEqual(result.outcomes.length, 2, "result.outcomes.length");
  });

  // --- Empty instruction ---

  await check("AICommandPipeline rejects an empty instruction without ever calling the provider or the executor", async () => {
    const providerSpy = makeProviderCallCounter(new MockAIProvider());
    const executor = makeExecutorSpy();
    const pipeline = new AICommandPipeline(providerSpy, executor);

    const result = await pipeline.run("   ", emptySnapshot);

    assertEqual(result.success, false, "result.success");
    assertEqual(result.errors.length, 1, "result.errors.length");
    assertEqual(result.errors[0].stage, "input", "error stage");
    assertEqual(providerSpy.callCount, 0, "provider should never be called");
    assertEqual(executor.calls.length, 0, "executor should never be called");
  });

  // --- Invalid provider output ---

  await check("AICommandPipeline rejects a non-array provider response", async () => {
    const provider = fixedProvider({ commands: "not-an-array" } as unknown as AIProviderResponse);
    const executor = makeExecutorSpy();
    const pipeline = new AICommandPipeline(provider, executor);

    const result = await pipeline.run("Create a wall", emptySnapshot);

    assertEqual(result.success, false, "result.success");
    assertEqual(result.errors[0].stage, "provider", "error stage");
    assertEqual(executor.calls.length, 0, "executor should never be called");
  });

  await check("AICommandPipeline rejects a null provider response", async () => {
    const provider = fixedProvider(null as unknown as AIProviderResponse);
    const executor = makeExecutorSpy();
    const pipeline = new AICommandPipeline(provider, executor);

    const result = await pipeline.run("Create a wall", emptySnapshot);

    assertEqual(result.success, false, "result.success");
    assertEqual(result.errors[0].stage, "provider", "error stage");
  });

  await check("AICommandPipeline rejects a provider response with zero commands and surfaces its notes", async () => {
    const provider = fixedProvider({ commands: [], notes: "nothing matched" });
    const executor = makeExecutorSpy();
    const pipeline = new AICommandPipeline(provider, executor);

    const result = await pipeline.run("Do a backflip", emptySnapshot);

    assertEqual(result.success, false, "result.success");
    assertEqual(result.errors[0].stage, "provider", "error stage");
    assertEqual(result.errors[0].message, "nothing matched", "error message");
  });

  await check("AICommandPipeline catches a throwing provider without throwing itself", async () => {
    const provider = throwingProvider("boom");
    const executor = makeExecutorSpy();
    const pipeline = new AICommandPipeline(provider, executor);

    const result = await pipeline.run("Create a wall", emptySnapshot);

    assertEqual(result.success, false, "result.success");
    assertEqual(result.errors[0].stage, "provider", "error stage");
    assertTrue(result.errors[0].message.includes("boom"), "error message should include the thrown message");
  });

  // --- Malformed / unsupported commands ---

  await check("AICommandPipeline rejects a structurally malformed command but still processes the rest of the batch", async () => {
    const provider = fixedProvider({ commands: [42, { type: "wall.add", wall: {} }] });
    const executor = makeExecutorSpy();
    const pipeline = new AICommandPipeline(provider, executor);

    const result = await pipeline.run("Create a wall", emptySnapshot);

    assertEqual(result.success, false, "result.success");
    assertEqual(result.outcomes.length, 2, "result.outcomes.length");
    assertEqual(result.outcomes[0].result.success, false, "first outcome should fail structural validation");
    assertEqual(result.outcomes[1].result.success, true, "second outcome should still be executed and succeed");
    assertEqual(executor.calls.length, 1, "only the well-formed command should reach the executor");
    assertEqual(result.errors[0].stage, "validation", "error stage");
    assertEqual(result.errors[0].commandIndex, 0, "error commandIndex");
  });

  await check("AICommandPipeline rejects an unsupported object type", async () => {
    const provider = fixedProvider({ commands: [{ type: "roof.add", roof: {} }] });
    const executor = makeExecutorSpy();
    const pipeline = new AICommandPipeline(provider, executor);

    const result = await pipeline.run("Create a roof", emptySnapshot);

    assertEqual(result.success, false, "result.success");
    assertTrue(result.errors[0].message.includes("Unsupported object type"), "error message");
    assertEqual(executor.calls.length, 0, "executor should never be called");
  });

  await check("AICommandPipeline rejects an object type excluded from this call's availableObjectTypes", async () => {
    const provider = fixedProvider({ commands: [{ type: "slab.add", slab: {} }] });
    const executor = makeExecutorSpy();
    const pipeline = new AICommandPipeline(provider, executor);
    const availableObjectTypes = AI_SUPPORTED_OBJECT_TYPES.filter((type) => type !== "slab");

    const result = await pipeline.run("Create a slab", emptySnapshot, availableObjectTypes);

    assertEqual(result.success, false, "result.success");
    assertTrue(result.errors[0].message.includes("not available"), "error message");
    assertEqual(executor.calls.length, 0, "executor should never be called");
  });

  await check("AICommandPipeline rejects an unsupported command type", async () => {
    const provider = fixedProvider({ commands: [{ type: "wall.frobnicate" }] });
    const executor = makeExecutorSpy();
    const pipeline = new AICommandPipeline(provider, executor);

    const result = await pipeline.run("Frobnicate a wall", emptySnapshot);

    assertEqual(result.success, false, "result.success");
    assertTrue(result.errors[0].message.includes("Unsupported command type"), "error message");
    assertEqual(executor.calls.length, 0, "executor should never be called");
  });

  // --- Command failure propagation ---

  await check("AICommandPipeline propagates one command's execution failure without aborting the rest of the batch", async () => {
    const executor = makeExecutorSpy((input) => {
      const type = (input as { type: string }).type;
      return type === "wall.add"
        ? { success: false, message: "Could not add wall: validation failed." }
        : { success: true, objectId: "pillar-1", message: "Pillar added." };
    });
    const provider = fixedProvider({
      commands: [
        { type: "wall.add", wall: {} },
        { type: "pillar.add", pillar: {} }
      ]
    });
    const pipeline = new AICommandPipeline(provider, executor);

    const result = await pipeline.run("Create a wall and add a pillar", emptySnapshot);

    assertEqual(result.success, false, "result.success");
    assertEqual(executor.calls.length, 2, "both commands should have been attempted");
    assertEqual(result.outcomes[0].result.success, false, "first outcome");
    assertEqual(result.outcomes[1].result.success, true, "second outcome should still succeed");
    assertEqual(result.errors.length, 1, "result.errors.length");
    assertEqual(result.errors[0].stage, "execution", "error stage");
    assertEqual(result.errors[0].commandIndex, 0, "error commandIndex");
  });

  await check("AICommandPipeline propagates a real domain validation failure (invalid dimensions) from CommandExecutor", async () => {
    const store = new WallStore();
    const history = makeWallHistoryStub(store);
    const executor = new CommandExecutor(store, history);
    const provider = fixedProvider({ commands: [{ type: "wall.add", wall: { length: 0 } }] });
    const pipeline = new AICommandPipeline(provider, executor);

    const result = await pipeline.run("Create a wall with no length", emptySnapshot);

    assertEqual(result.success, false, "result.success");
    const outcome = result.outcomes[0];
    assertEqual(outcome.result.success, false, "outcome.result.success");
    assertTrue(
      outcome.result.errors && outcome.result.errors.some((e) => e.field === "dimensions.length"),
      "expected a dimensions.length error"
    );
    assertEqual(store.getAll().length, 0, "nothing should have been stored");
  });

  // --- Undo/redo compatibility ---

  await check("a command executed through AICommandPipeline undoes and redoes exactly like a directly-issued one", async () => {
    const store = new WallStore();
    const history = new HistoryManager();
    const wallHistory = makeUndoableWallHistory(store, history);
    const executor = new CommandExecutor(store, wallHistory);
    const pipeline = new AICommandPipeline(new MockAIProvider(), executor);

    assertEqual(store.getAll().length, 0, "no walls yet");
    assertEqual(history.canUndo(), false, "nothing to undo yet");

    const result = await pipeline.run("Create a wall", emptySnapshot);

    assertTrue(result.success, "result.success");
    assertEqual(store.getAll().length, 1, "one wall should have been added");
    assertTrue(history.canUndo(), "the AI-issued add should have been recorded");

    history.undo();
    assertEqual(store.getAll().length, 0, "undo should remove the AI-added wall");
    assertTrue(history.canRedo(), "redo should now be available");

    history.redo();
    assertEqual(store.getAll().length, 1, "redo should restore the AI-added wall");
  });

  // --- No direct store mutation from the AI layer ---

  await check("AICommandPipeline holds no store reference - only a provider and a CommandExecutorLike", async () => {
    const pipeline = new AICommandPipeline(new MockAIProvider(), makeExecutorSpy());

    const ownProperties = Object.getOwnPropertyNames(pipeline).sort();

    assertDeepEqual(ownProperties, ["commandExecutor", "provider"], "AICommandPipeline's own instance properties");
  });

  await check("every mutation an AI instruction causes goes through the CommandExecutorLike, and only that", async () => {
    const executor = makeExecutorSpy();
    const pipeline = new AICommandPipeline(new MockAIProvider(), executor);

    await pipeline.run("Create a wall", emptySnapshot);
    await pipeline.run("Add a pillar and create a beam", emptySnapshot);
    await pipeline.run("Add a slab, create a door, add a window", emptySnapshot);

    assertEqual(executor.calls.length, 6, "one executor call per recognized command across all three instructions");
  });

  // --- AIPipelineResult.notes propagation ---

  await check("AICommandPipeline includes the provider's notes on a successful result", async () => {
    const provider = fixedProvider({ commands: [{ type: "wall.add", wall: {} }], notes: "used default dimensions" });
    const pipeline = new AICommandPipeline(provider, makeExecutorSpy());

    const result = await pipeline.run("Create a wall", emptySnapshot);

    assertTrue(result.success, "result.success");
    assertEqual(result.notes, "used default dimensions", "result.notes");
  });

  await check("AICommandPipeline includes the provider's notes on a failing result", async () => {
    const provider = fixedProvider({ commands: [{ type: "roof.add", roof: {} }], notes: "couldn't build a roof yet" });
    const pipeline = new AICommandPipeline(provider, makeExecutorSpy());

    const result = await pipeline.run("Create a roof", emptySnapshot);

    assertEqual(result.success, false, "result.success");
    assertEqual(result.notes, "couldn't build a roof yet", "result.notes");
  });

  await check("AICommandPipeline includes the provider's notes when zero commands were produced", async () => {
    const provider = fixedProvider({ commands: [], notes: "nothing matched" });
    const pipeline = new AICommandPipeline(provider, makeExecutorSpy());

    const result = await pipeline.run("Do a backflip", emptySnapshot);

    assertEqual(result.notes, "nothing matched", "result.notes");
  });

  await check("AICommandPipeline omits notes when the provider didn't supply any", async () => {
    const provider = fixedProvider({ commands: [{ type: "wall.add", wall: {} }] });
    const pipeline = new AICommandPipeline(provider, makeExecutorSpy());

    const result = await pipeline.run("Create a wall", emptySnapshot);

    assertEqual(result.notes, undefined, "result.notes");
  });

  // --- AIService ---

  function makeCountingSnapshotSource(counts: { wallCount: number }) {
    return {
      wallStore: { getAll: () => Array.from({ length: counts.wallCount }) },
      pillarStore: { getAll: () => [] },
      beamStore: { getAll: () => [] },
      slabStore: { getAll: () => [] },
      doorStore: { getAll: () => [] },
      windowStore: { getAll: () => [] },
      assemblyStore: { getAll: () => [] },
      selectionStore: { get: (): string | null => null }
    };
  }

  await check("AIService.submit builds a fresh snapshot on every call - not a cached one", async () => {
    const requests: AIProjectSnapshot[] = [];
    const provider: AIProvider = {
      interpret: (request) => {
        requests.push(request.projectContext);
        return { commands: [] };
      }
    };
    const counts = { wallCount: 0 };
    const service = new AIService({
      provider,
      commandExecutor: makeExecutorSpy(),
      snapshotSource: makeCountingSnapshotSource(counts)
    });

    await service.submit("Create a wall");
    counts.wallCount = 1;
    await service.submit("Create another wall");

    assertEqual(requests[0].wallCount, 0, "first call should see the wall count at that time");
    assertEqual(requests[1].wallCount, 1, "second call should see the updated wall count, not a cached snapshot");
  });

  await check("AIService.submit executes returned commands via the injected CommandExecutor", async () => {
    const provider = fixedProvider({ commands: [{ type: "wall.add", wall: {} }] });
    const executor = makeExecutorSpy();
    const service = new AIService({ provider, commandExecutor: executor, snapshotSource: makeCountingSnapshotSource({ wallCount: 0 }) });

    const result = await service.submit("Create a wall");

    assertTrue(result.success, "result.success");
    assertEqual(executor.calls.length, 1, "executor.calls.length");
    assertDeepEqual(executor.calls[0], { type: "wall.add", wall: {} }, "the command passed to CommandExecutor");
  });

  await check("AIService holds no store reference - only a pipeline and a snapshot source", () => {
    const service = new AIService({
      provider: fixedProvider({ commands: [] }),
      commandExecutor: makeExecutorSpy(),
      snapshotSource: makeCountingSnapshotSource({ wallCount: 0 })
    });

    const ownProperties = Object.getOwnPropertyNames(service).sort();

    assertDeepEqual(ownProperties, ["pipeline", "snapshotSource"], "AIService's own instance properties");
  });

  // --- AiPromptController ---

  function makeDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  function makeResult(overrides: Partial<AIPipelineResult> = {}): AIPipelineResult {
    return {
      success: true,
      instruction: "Create a wall",
      outcomes: [{ command: { type: "wall.add", wall: {} }, result: { success: true } }],
      errors: [],
      ...overrides
    };
  }

  await check("AiPromptController starts idle", () => {
    const controller = new AiPromptController(async () => makeResult());
    assertDeepEqual(controller.getState(), { status: "idle", message: null, notes: null }, "initial state");
  });

  await check("AiPromptController transitions submitting -> success and reports a summary message", async () => {
    const states: AiPromptState[] = [];
    const controller = new AiPromptController(async () => makeResult());
    controller.subscribe((state) => states.push(state));

    await controller.submit("Create a wall");

    assertEqual(states[0].status, "idle", "initial notification");
    assertEqual(states[1].status, "submitting", "should go through a submitting state");
    assertEqual(states[2].status, "success", "final state");
    assertEqual(controller.getState().message, "1 command executed.", "success message");
  });

  await check("AiPromptController transitions submitting -> error and reports the first error message", async () => {
    const controller = new AiPromptController(async () =>
      makeResult({
        success: false,
        outcomes: [],
        errors: [{ stage: "input", message: "Instruction is empty." }]
      })
    );

    await controller.submit("");

    assertEqual(controller.getState().status, "error", "final state");
    assertEqual(controller.getState().message, "Instruction is empty.", "error message");
  });

  await check("AiPromptController summarizes a partial success (some commands succeeded, some failed)", async () => {
    const controller = new AiPromptController(async () =>
      makeResult({
        success: false,
        outcomes: [
          { command: { type: "wall.add", wall: {} }, result: { success: true } },
          { command: { type: "roof.add", roof: {} }, result: { success: false } }
        ],
        errors: [{ stage: "validation", message: 'Unsupported object type: "roof".', commandIndex: 1 }]
      })
    );

    await controller.submit("Create a wall and a roof");

    assertEqual(controller.getState().status, "error", "final state");
    assertTrue(controller.getState().message?.startsWith("1 command of 2 succeeded."), "should report the partial count");
  });

  await check("AiPromptController reports the provider's notes when the result includes them", async () => {
    const controller = new AiPromptController(async () => makeResult({ notes: "assumed default dimensions" }));

    await controller.submit("Create a wall");

    assertEqual(controller.getState().notes, "assumed default dimensions", "notes");
  });

  await check("AiPromptController reports notes as null when the result has none", async () => {
    const controller = new AiPromptController(async () => makeResult());

    await controller.submit("Create a wall");

    assertEqual(controller.getState().notes, null, "notes");
  });

  await check("AiPromptController prevents a duplicate submission while one is already in flight", async () => {
    let callCount = 0;
    const deferred = makeDeferred<AIPipelineResult>();
    const controller = new AiPromptController(async () => {
      callCount += 1;
      return deferred.promise;
    });

    const first = controller.submit("Create a wall");
    assertEqual(controller.getState().status, "submitting", "should already be submitting");

    const second = controller.submit("Create a wall");
    await second;
    assertEqual(callCount, 1, "the second, concurrent submit() should not have called the submitter again");
    assertEqual(controller.getState().status, "submitting", "still submitting - the first call hasn't resolved yet");

    deferred.resolve(makeResult());
    await first;
    assertEqual(controller.getState().status, "success", "the first call's result should still land");
  });

  await check("AiPromptController allows a new submission once the previous one has finished", async () => {
    let callCount = 0;
    const controller = new AiPromptController(async () => {
      callCount += 1;
      return makeResult();
    });

    await controller.submit("Create a wall");
    await controller.submit("Add a pillar");

    assertEqual(callCount, 2, "a submission after the previous one resolved should not be blocked");
  });

  await check("AiPromptController catches a throwing submitter and reports an error state", async () => {
    const controller = new AiPromptController(async () => {
      throw new Error("network down");
    });

    await controller.submit("Create a wall");

    assertEqual(controller.getState().status, "error", "final state");
    assertEqual(controller.getState().message, "network down", "error message");
  });

  await check("AiPromptController holds no store, CommandExecutor, or AICommandPipeline reference", () => {
    const controller = new AiPromptController(async () => makeResult());

    const ownProperties = Object.getOwnPropertyNames(controller).sort();

    assertDeepEqual(
      ownProperties,
      ["listeners", "state", "submitInstruction"],
      "AiPromptController's own instance properties"
    );
  });

  // --- AI Prompt submit key ---

  await check("isAiPromptSubmitKey accepts Enter", () => {
    assertEqual(isAiPromptSubmitKey({ key: "Enter" }), true, "plain Enter");
    assertEqual(isAiPromptSubmitKey({ key: "Enter", isComposing: false }), true, "Enter outside a composition");
  });

  await check("isAiPromptSubmitKey rejects a keydown carrying no key identity", () => {
    // What a synthetic "Return" press from some automation tools actually
    // delivers - observed in-browser as key "", code "", keyCode 0.
    assertEqual(isAiPromptSubmitKey({ key: "" }), false, "empty key");
  });

  await check("isAiPromptSubmitKey rejects an Enter that confirms an IME composition", () => {
    assertEqual(isAiPromptSubmitKey({ key: "Enter", isComposing: true }), false, "composing Enter");
  });

  await check("isAiPromptSubmitKey rejects every other key", () => {
    // A numpad Enter reports key "Enter" (only its `code` differs), so
    // "NumpadEnter" never appears as a key value; the rule keys off `key`.
    for (const key of ["a", "Tab", "Escape", " ", "Return", "NumpadEnter", "enter"]) {
      assertEqual(isAiPromptSubmitKey({ key }), false, `key ${JSON.stringify(key)}`);
    }
  });

  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) {
    throw new Error(`${failed} verification check(s) failed`);
  }
}

// run() is async (see above), so a synchronous top-level `run();` here
// would let this script exit with code 0 before any check had actually
// finished. Instead, wait for the returned promise; on failure, log and
// rethrow so this becomes an unhandled rejection - Node's default
// behavior for that is to exit with a non-zero code, the same effect
// every other (synchronous) verify.ts in this project gets for free
// from an uncaught throw. (Deliberately not `process.exitCode` - the
// Node-only `process` global isn't typed without @types/node, which
// this project doesn't depend on, and referencing it would fail
// `tsc --noEmit`.)
run().catch((error) => {
  console.error(error);
  throw error;
});
