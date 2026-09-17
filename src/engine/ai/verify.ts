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
import { AICommandPipeline, MAX_COMMANDS_PER_RESPONSE } from "./AICommandPipeline.ts";
import type { CommandExecutorLike } from "./AICommandPipeline.ts";
import { MockAIProvider } from "./MockAIProvider.ts";
import { DEFAULT_HOUSE_FOOTPRINT, buildSimpleHousePlan } from "./housePlan.ts";
import { AI_SUPPORTED_OBJECT_TYPES, buildAIProjectSnapshot } from "./types.ts";
import { parseAIProjectSnapshot } from "./parseProjectSnapshot.ts";
import { buildAIProjectContext } from "./aiProjectContext.ts";
import { analyzeConstructionGeometry } from "./geometry/analyzeConstructionGeometry.ts";
import type {
  AIContextObject,
  AIProjectContext,
  AIProjectSnapshot,
  AIProviderRequest,
  AIProviderResponse,
  AIPipelineResult
} from "./types.ts";
import type { Command } from "../commands/types.ts";
import type { AIProvider } from "./AIProvider.ts";
import { AIService } from "./AIService.ts";
import { AiPromptController, isAiPromptSubmitKey, summarizeUpdatedObjects } from "./AiPromptController.ts";
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
  selectedObjectId: null,
  objects: [],
  assemblies: []
};

/** What a provider receives for an empty project - the snapshot plus its (empty) derived geometry. */
const emptyContext: AIProjectContext = buildAIProjectContext(emptySnapshot);

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

  // Store-record fixtures shaped like the real WallData/PillarData/...
  // records. Types are derived from the builder's own signature, so these
  // track AIProjectSnapshotSource without a separate import.
  type SnapshotSource = Parameters<typeof buildAIProjectSnapshot>[0];
  type ObjectRecords = ReturnType<SnapshotSource["wallStore"]["getAll"]>;
  type AssemblyRecords = ReturnType<SnapshotSource["assemblyStore"]["getAll"]>;
  type RecordType = ObjectRecords[number]["type"];

  function makeSnapshotSource(
    contents: {
      walls?: ObjectRecords;
      pillars?: ObjectRecords;
      doors?: ObjectRecords;
      assemblies?: AssemblyRecords;
      selected?: string | null;
    } = {}
  ): SnapshotSource {
    return {
      wallStore: { getAll: () => contents.walls ?? [] },
      pillarStore: { getAll: () => contents.pillars ?? [] },
      beamStore: { getAll: () => [] },
      slabStore: { getAll: () => [] },
      doorStore: { getAll: () => contents.doors ?? [] },
      windowStore: { getAll: () => [] },
      assemblyStore: { getAll: () => contents.assemblies ?? [] },
      selectionStore: { get: () => contents.selected ?? null }
    };
  }

  function objectRecord(
    id: string,
    type: RecordType,
    dimensions: Record<string, number>,
    extra: { position?: { x: number; y: number; z: number }; rotation?: number; color?: string; assemblyId?: string | null } = {}
  ) {
    return {
      id,
      type,
      position: extra.position ?? { x: 0, y: 1.35, z: 0 },
      rotation: extra.rotation ?? 0,
      dimensions,
      material: "generic",
      color: extra.color ?? "#c9c9c9",
      // Real records carry this reserved, never-set field - see AIContextObject.
      assemblyId: extra.assemblyId ?? null
    };
  }

  function wallRecord(id: string, extra: Parameters<typeof objectRecord>[3] & { length?: number } = {}) {
    return objectRecord(id, "wall", { length: extra.length ?? 4, height: 2.7, thickness: 0.2 }, extra);
  }

  function assemblyRecord(id: string, name: string, objectIds: string[], description?: string) {
    // Real AssemblyData carries Date.now() timestamps; the snapshot must drop them.
    return { id, name, description, objectIds, createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_500 };
  }

  /** Fails if `value` holds anything but plain JSON data - see the matching helper in e2e/verify.ts. */
  function assertPlainJson(value: unknown, path: string, seen: Set<object> = new Set()): void {
    if (value === null || typeof value === "string" || typeof value === "boolean") {
      return;
    }
    if (typeof value === "number") {
      assertTrue(Number.isFinite(value), `${path} must be a finite number`);
      return;
    }
    assertTrue(typeof value === "object", `${path} must be plain data, got ${typeof value}`);
    const object = value as object;
    assertTrue(!seen.has(object), `${path} shares a reference with another part of the snapshot`);
    seen.add(object);
    const prototype = Object.getPrototypeOf(object);
    assertTrue(prototype === Object.prototype || prototype === Array.prototype, `${path} must be a plain object or array`);
    for (const [key, child] of Object.entries(object)) {
      assertPlainJson(child, `${path}.${key}`, seen);
    }
  }

  await check("buildAIProjectSnapshot keeps the store counts and current selection it always reported", async () => {
    const snapshot = buildAIProjectSnapshot(
      makeSnapshotSource({
        walls: [wallRecord("wall-1"), wallRecord("wall-2")],
        pillars: [objectRecord("pillar-1", "pillar", { width: 0.4, depth: 0.4, height: 2.7 })],
        assemblies: [assemblyRecord("assembly-1", "Core", [])],
        selected: "wall-1"
      })
    );

    assertEqual(snapshot.wallCount, 2, "wallCount");
    assertEqual(snapshot.pillarCount, 1, "pillarCount");
    assertEqual(snapshot.beamCount, 0, "beamCount");
    assertEqual(snapshot.assemblyCount, 1, "assemblyCount");
    assertEqual(snapshot.selectedObjectId, "wall-1", "selectedObjectId");
  });

  await check("buildAIProjectSnapshot reports selectedObjectId as null when nothing is selected", async () => {
    assertEqual(buildAIProjectSnapshot(makeSnapshotSource()).selectedObjectId, null, "selectedObjectId");
  });

  await check("buildAIProjectSnapshot lists every current object with its id, type, dimensions, and transform", () => {
    const snapshot = buildAIProjectSnapshot(
      makeSnapshotSource({
        walls: [wallRecord("wall-1", { position: { x: 1, y: 1.35, z: -2 }, rotation: 0.25, length: 5 })],
        pillars: [
          objectRecord("pillar-1", "pillar", { width: 0.4, depth: 0.4, height: 2.7 }, {
            position: { x: 3, y: 1.35, z: 0 },
            color: "#a8a8a8"
          })
        ]
      })
    );

    assertDeepEqual(
      snapshot.objects,
      [
        {
          id: "pillar-1",
          type: "pillar",
          position: { x: 3, y: 1.35, z: 0 },
          rotation: 0,
          dimensions: { depth: 0.4, height: 2.7, width: 0.4 },
          material: "generic",
          color: "#a8a8a8",
          assemblyIds: []
        },
        {
          id: "wall-1",
          type: "wall",
          position: { x: 1, y: 1.35, z: -2 },
          rotation: 0.25,
          dimensions: { height: 2.7, length: 5, thickness: 0.2 },
          material: "generic",
          color: "#c9c9c9",
          assemblyIds: []
        }
      ],
      "objects, sorted by id, with dimension keys sorted"
    );
  });

  await check("buildAIProjectSnapshot takes assembly membership from the assemblies, not the object's own assemblyId", () => {
    const snapshot = buildAIProjectSnapshot(
      makeSnapshotSource({
        walls: [
          wallRecord("wall-1"),
          wallRecord("wall-2"),
          // A stale value in the reserved field must not be reported as membership.
          wallRecord("wall-3", { assemblyId: "assembly-9" })
        ],
        assemblies: [
          assemblyRecord("assembly-2", "Facade", ["wall-1"]),
          assemblyRecord("assembly-1", "Ground Floor", ["wall-2", "wall-1"], "Level 0")
        ]
      })
    );

    const byId = new Map(snapshot.objects.map((object) => [object.id, object]));
    assertDeepEqual(byId.get("wall-1")?.assemblyIds, ["assembly-1", "assembly-2"], "wall-1 is in both, ids sorted");
    assertDeepEqual(byId.get("wall-2")?.assemblyIds, ["assembly-1"], "wall-2 is in one");
    assertDeepEqual(byId.get("wall-3")?.assemblyIds, [], "the reserved assemblyId field is ignored");

    assertDeepEqual(
      snapshot.assemblies,
      [
        { id: "assembly-1", name: "Ground Floor", description: "Level 0", objectIds: ["wall-2", "wall-1"] },
        { id: "assembly-2", name: "Facade", description: null, objectIds: ["wall-1"] }
      ],
      "assemblies sorted by id, member order kept, no timestamps, unset description is null"
    );
  });

  await check("buildAIProjectSnapshot is deterministic - store insertion order doesn't matter, and ids sort numerically", () => {
    const ids = ["wall-10", "wall-2", "wall-1"];
    const forward = buildAIProjectSnapshot(makeSnapshotSource({ walls: ids.map((id) => wallRecord(id)) }));
    const reversed = buildAIProjectSnapshot(makeSnapshotSource({ walls: [...ids].reverse().map((id) => wallRecord(id)) }));

    assertEqual(JSON.stringify(forward), JSON.stringify(reversed), "identical JSON for identical state");
    assertDeepEqual(
      forward.objects.map((object) => object.id),
      ["wall-1", "wall-2", "wall-10"],
      "wall-2 sorts before wall-10"
    );
  });

  await check("buildAIProjectSnapshot output is plain JSON that survives a round trip unchanged", () => {
    const snapshot = buildAIProjectSnapshot(
      makeSnapshotSource({
        walls: [wallRecord("wall-1")],
        assemblies: [assemblyRecord("assembly-1", "Core", ["wall-1"])],
        selected: "wall-1"
      })
    );

    assertPlainJson(snapshot, "snapshot");
    assertEqual(JSON.stringify(JSON.parse(JSON.stringify(snapshot))), JSON.stringify(snapshot), "round trip");
  });

  await check("buildAIProjectSnapshot copies only known fields - no class instances, functions, extras, or shared references", () => {
    class FakeMesh {
      readonly isObject3D = true;
      geometry = { vertices: [1, 2, 3] };
    }
    const record = {
      ...wallRecord("wall-1"),
      position: { x: 0, y: 1.35, z: 0, w: 1 },
      dimensions: { length: 4, height: 2.7, thickness: 0.2, area: () => 10, nested: { depth: 1 } },
      mesh: new FakeMesh(),
      dispose: () => undefined,
      userData: { selected: true }
    };

    const snapshot = buildAIProjectSnapshot(makeSnapshotSource({ walls: [record] }));

    assertPlainJson(snapshot, "snapshot");
    const object = snapshot.objects[0];
    assertDeepEqual(
      Object.keys(object),
      ["id", "type", "position", "rotation", "dimensions", "material", "color", "assemblyIds"],
      "object keys"
    );
    assertDeepEqual(Object.keys(object.position), ["x", "y", "z"], "position keys");
    assertDeepEqual(object.dimensions, { height: 2.7, length: 4, thickness: 0.2 }, "only finite numeric dimensions");

    // Mutating the source after the fact must not reach the snapshot.
    record.position.x = 99;
    assertEqual(object.position.x, 0, "the snapshot holds no reference into the store record");
  });

  await check("buildAIProjectSnapshot handles an empty project", () => {
    const snapshot = buildAIProjectSnapshot(makeSnapshotSource());

    assertDeepEqual(snapshot.objects, [], "no objects");
    assertDeepEqual(snapshot.assemblies, [], "no assemblies");
    assertEqual(snapshot.wallCount, 0, "counts are zero");
    assertPlainJson(snapshot, "snapshot");
  });

  // --- parseAIProjectSnapshot (shared by the backend and the E2E mock backend) ---

  const richSnapshot = buildAIProjectSnapshot(
    makeSnapshotSource({
      walls: [wallRecord("wall-1")],
      assemblies: [assemblyRecord("assembly-1", "Core", ["wall-1"], "Structural core")],
      selected: "wall-1"
    })
  );

  await check("parseAIProjectSnapshot accepts a built snapshot and returns an identical copy", () => {
    const result = parseAIProjectSnapshot(JSON.parse(JSON.stringify(richSnapshot)));
    assertTrue(result.ok, "a snapshot the builder produced must be accepted");
    assertEqual(JSON.stringify(result.snapshot), JSON.stringify(richSnapshot), "identical after parsing");
  });

  await check("parseAIProjectSnapshot still accepts an empty project", () => {
    const result = parseAIProjectSnapshot(JSON.parse(JSON.stringify(buildAIProjectSnapshot(makeSnapshotSource()))));
    assertTrue(result.ok, "an empty project must be accepted");
  });

  await check("parseAIProjectSnapshot strips every field the snapshot doesn't define", () => {
    const raw = JSON.parse(JSON.stringify(richSnapshot));
    raw.injected = "top-level extra";
    raw.objects[0].mesh = { geometry: "should never reach a provider" };
    raw.objects[0].position.w = 1;
    raw.assemblies[0].createdAt = 1_700_000_000_000;

    const result = parseAIProjectSnapshot(raw);

    assertTrue(result.ok, "extra fields alone are not an error");
    assertEqual(JSON.stringify(result.snapshot), JSON.stringify(richSnapshot), "every extra field is gone");
  });

  await check("parseAIProjectSnapshot rejects a __proto__ key smuggled into dimensions", () => {
    const raw = JSON.parse(JSON.stringify(richSnapshot));
    // JSON.parse is the one way a real request can carry an own "__proto__" key.
    raw.objects[0].dimensions = JSON.parse('{"__proto__": 1, "length": 4}');

    const result = parseAIProjectSnapshot(raw);

    assertTrue(!result.ok, "a __proto__ dimension key must be rejected");
  });

  await check("parseAIProjectSnapshot rejects malformed input, naming the offending field", () => {
    const cases: { mutate: (raw: any) => void; path: string }[] = [
      { mutate: (raw) => delete raw.objects, path: "projectContext.objects" },
      { mutate: (raw) => (raw.assemblies = "none"), path: "projectContext.assemblies" },
      { mutate: (raw) => (raw.wallCount = "2"), path: "projectContext.wallCount" },
      { mutate: (raw) => (raw.objects[0].type = "roof"), path: "projectContext.objects[0].type" },
      { mutate: (raw) => (raw.objects[0].position = { x: "1", y: 0, z: 0 }), path: "projectContext.objects[0].position" },
      { mutate: (raw) => (raw.objects[0].rotation = null), path: "projectContext.objects[0].rotation" },
      { mutate: (raw) => (raw.objects[0].dimensions = { length: "4" }), path: "projectContext.objects[0].dimensions" },
      { mutate: (raw) => (raw.objects[0].assemblyIds = [1]), path: "projectContext.objects[0].assemblyIds" },
      { mutate: (raw) => (raw.assemblies[0].objectIds = [""]), path: "projectContext.assemblies[0].objectIds" },
      { mutate: (raw) => (raw.assemblies[0].description = 5), path: "projectContext.assemblies[0].description" }
    ];

    for (const { mutate, path } of cases) {
      const raw = JSON.parse(JSON.stringify(richSnapshot));
      mutate(raw);
      const result = parseAIProjectSnapshot(raw);
      assertTrue(!result.ok, `${path}: malformed input must be rejected`);
      assertTrue(result.error.includes(`"${path}"`), `${path}: error should name the field, got "${result.error}"`);
    }
  });

  // --- MockAIProvider reads the context ---

  await check("MockAIProvider notes an existing object the instruction names by id", () => {
    const projectContext = buildAIProjectSnapshot(
      makeSnapshotSource({
        walls: [wallRecord("wall-1")],
        doors: [objectRecord("door-1", "door", { width: 0.9, height: 2.1, thickness: 0.05 })]
      })
    );

    // "pillar" is matched before "door" in the keyword order, so naming the
    // door by id doesn't change which command is produced.
    const response = new MockAIProvider().interpret({
      instruction: "Add a pillar beside door-1",
      projectContext: buildAIProjectContext(projectContext),
      availableObjectTypes: AI_SUPPORTED_OBJECT_TYPES
    });

    assertDeepEqual(response.commands, [{ type: "pillar.add", pillar: {} }], "commands are unaffected");
    assertEqual(response.notes, "Referenced existing objects: door-1 (door).", "the door was found in the context");
  });

  await check("MockAIProvider ignores ids that aren't in the context or only appear inside a longer id", () => {
    const projectContext = buildAIProjectSnapshot(makeSnapshotSource({ walls: [wallRecord("wall-1")] }));

    const response = new MockAIProvider().interpret({
      instruction: "Add a pillar near wall-10 and door-7",
      projectContext: buildAIProjectContext(projectContext),
      availableObjectTypes: AI_SUPPORTED_OBJECT_TYPES
    });

    assertTrue(!(response.notes ?? "").includes("Referenced existing objects"), "neither id should be reported");
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
        projectContext: emptyContext,
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
      projectContext: emptyContext,
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
      projectContext: emptyContext,
      availableObjectTypes: AI_SUPPORTED_OBJECT_TYPES
    });

    assertEqual(response.commands.length, 0, "commands.length");
    assertTrue(response.notes && response.notes.includes("backflip"), "notes should mention the unrecognized clause");
  });

  await check("MockAIProvider treats an object type outside availableObjectTypes as unrecognized", async () => {
    const provider = new MockAIProvider();
    const response = provider.interpret({
      instruction: "Create a door",
      projectContext: emptyContext,
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

  await check("AICommandPipeline rejects the whole response when any command is malformed - not even the valid ones run", async () => {
    const provider = fixedProvider({ commands: [{ type: "wall.add", wall: {} }, 42, { type: "pillar.add", pillar: {} }] });
    const executor = makeExecutorSpy();
    const pipeline = new AICommandPipeline(provider, executor);

    const result = await pipeline.run("Create a wall", emptySnapshot);

    assertEqual(result.success, false, "result.success");
    assertEqual(executor.calls.length, 0, "nothing reaches the executor - validation covers the whole response first");
    assertEqual(result.outcomes.length, 3, "one outcome per command");
    assertEqual(result.outcomes[1].result.message, "Malformed command: expected a plain object.", "the malformed command says why");
    assertTrue(result.outcomes[0].result.message?.startsWith("Not executed: command 2"), "a valid command says it wasn't run");
    assertTrue(result.outcomes[2].result.message?.startsWith("Not executed: command 2"), "so does the one after it");
    assertEqual(result.errors.length, 1, "one error, for the malformed command");
    assertEqual(result.errors[0].stage, "validation", "error stage");
    assertEqual(result.errors[0].commandIndex, 1, "error commandIndex");
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

  await check("AICommandPipeline stops at the first execution failure - later commands are never run", async () => {
    const executor = makeExecutorSpy((input) => {
      const type = (input as { type: string }).type;
      return type === "wall.add"
        ? { success: false, message: "Could not add wall: validation failed." }
        : { success: true, objectId: "pillar-1", message: "Pillar added." };
    });
    const provider = fixedProvider({
      commands: [
        { type: "pillar.add", pillar: {} },
        { type: "wall.add", wall: {} },
        { type: "beam.add", beam: {} }
      ]
    });
    const pipeline = new AICommandPipeline(provider, executor);

    const result = await pipeline.run("Add a pillar, a wall and a beam", emptySnapshot);

    assertEqual(result.success, false, "result.success");
    assertEqual(executor.calls.length, 2, "the beam after the failing wall was never attempted");
    assertEqual(result.outcomes[1].result.message, "Could not add wall: validation failed.", "the failing command's own result");
    assertEqual(result.outcomes[2].result.message, "Not executed: command 2 failed.", "a later command says it wasn't run");
    assertEqual(result.errors.length, 1, "result.errors.length");
    assertEqual(result.errors[0].stage, "execution", "error stage");
    assertEqual(result.errors[0].commandIndex, 1, "error commandIndex");
  });

  /**
   * An executor stand-in that keeps "objects" in a list and records each
   * add in a real HistoryManager - what the real *HistoryController classes
   * do - so rollback and grouping can be checked without the real stores.
   */
  function makeRecordingExecutor(history: HistoryManager, failOnType: string | null = null) {
    const objects: string[] = [];
    let nextId = 1;
    return {
      objects,
      execute(input: unknown): CommandResult {
        const type = (input as { type: string }).type;
        if (type === failOnType) {
          return { success: false, message: `Could not run ${type}.` };
        }
        const id = `object-${nextId++}`;
        objects.push(id);
        history.record({
          undo: () => {
            objects.splice(objects.indexOf(id), 1);
          },
          redo: () => {
            objects.push(id);
          }
        });
        return { success: true, objectId: id };
      }
    };
  }

  const threeAdds = [
    { type: "wall.add", wall: {} },
    { type: "pillar.add", pillar: {} },
    { type: "beam.add", beam: {} }
  ];

  await check("with a history, a response that fails part-way is rolled back completely and records nothing", async () => {
    const history = new HistoryManager();
    const executor = makeRecordingExecutor(history, "beam.add");
    const pipeline = new AICommandPipeline(fixedProvider({ commands: threeAdds }), executor, history);

    const result = await pipeline.run("Add a wall, a pillar and a beam", emptySnapshot);

    assertEqual(result.success, false, "result.success");
    assertDeepEqual(executor.objects, [], "the wall and pillar added before the failure were removed again");
    assertEqual(history.canUndo(), false, "no history entry");
    assertEqual(history.isGrouping(), false, "the group was closed");
    assertEqual(result.outcomes[0].result.success, false, "a rolled-back command doesn't count as a success");
    assertTrue(result.outcomes[0].result.message?.startsWith("Rolled back: command 3 failed"), "and says it was rolled back");
    assertEqual(result.outcomes[2].result.message, "Could not run beam.add.", "the failing command's own result");
  });

  await check("with a history, a successful response is ONE undo entry - one undo removes all of it, one redo restores it", async () => {
    const history = new HistoryManager();
    const executor = makeRecordingExecutor(history);
    const pipeline = new AICommandPipeline(fixedProvider({ commands: threeAdds }), executor, history);

    const result = await pipeline.run("Add a wall, a pillar and a beam", emptySnapshot);
    assertTrue(result.success, "result.success");
    assertDeepEqual(executor.objects, ["object-1", "object-2", "object-3"], "three objects");

    history.undo();
    assertDeepEqual(executor.objects, [], "one undo removes all three");
    assertEqual(history.canUndo(), false, "it was a single entry");
    history.redo();
    assertDeepEqual(executor.objects, ["object-1", "object-2", "object-3"], "one redo restores all three, same ids");
  });

  await check("a response that arrives while a history group is open (a drag in progress) changes nothing", async () => {
    const history = new HistoryManager();
    const executor = makeRecordingExecutor(history);
    const pipeline = new AICommandPipeline(fixedProvider({ commands: threeAdds }), executor, history);

    history.beginGroup();
    const result = await pipeline.run("Add a wall, a pillar and a beam", emptySnapshot);
    assertEqual(history.isGrouping(), true, "the drag's group is still open, untouched");
    history.cancelGroup();

    assertEqual(result.success, false, "result.success");
    assertDeepEqual(executor.objects, [], "nothing was added");
    assertTrue(result.errors[0].message.includes("still in progress"), "clear message");
  });

  await check("AICommandPipeline refuses a response with more commands than one response may contain", async () => {
    const commands = Array.from({ length: MAX_COMMANDS_PER_RESPONSE + 1 }, () => ({ type: "wall.add", wall: {} }));
    const executor = makeExecutorSpy();

    const result = await new AICommandPipeline(fixedProvider({ commands }), executor).run("Add many walls", emptySnapshot);

    assertEqual(result.success, false, "result.success");
    assertEqual(result.errors[0].stage, "provider", "error stage");
    assertEqual(executor.calls.length, 0, "nothing executed");
  });

  // --- MockAIProvider: a whole house (see housePlan.ts) ---

  const HOUSE_INSTRUCTION = "Build a simple 2-bedroom house on a 10m × 8m footprint.";
  const interpretWith = (instruction: string, projectContext: AIProjectContext = emptyContext, types = AI_SUPPORTED_OBJECT_TYPES) =>
    new MockAIProvider().interpret({ instruction, projectContext, availableObjectTypes: types });

  await check("MockAIProvider answers a house instruction with the complete 12-command plan, in build order", () => {
    const response = interpretWith(HOUSE_INSTRUCTION);

    assertDeepEqual(response.commands, buildSimpleHousePlan({ length: 10, width: 8 }), "exactly the reference plan");
    assertDeepEqual(
      response.commands.map((command) => (command as { type: string }).type),
      ["slab.add", "wall.add", "wall.add", "wall.add", "wall.add", "pillar.add", "pillar.add", "pillar.add", "pillar.add", "door.add", "window.add", "window.add"],
      "1 slab, 4 walls, 4 pillars, 1 door, 2 windows"
    );
    assertTrue(response.notes?.includes("10 m × 8 m house centered on the origin"), "notes describe the plan");
    assertTrue(response.notes?.includes("no interior walls"), "notes say rooms weren't modeled");
    assertDeepEqual(interpretWith(HOUSE_INSTRUCTION), response, "deterministic: the same request, the same response");
  });

  await check("the reference house plan on a 10 x 8 footprint, pinned: slab, perimeter walls between corner pillars, door and windows on the outside faces", () => {
    const quarterTurn = Math.PI / 2;
    const wall = (length: number, rotation: number, x: number, z: number) => ({
      type: "wall.add",
      wall: { length, height: 2.7, thickness: 0.2, rotation, position: { x, y: 1.55, z } }
    });
    const pillar = (x: number, z: number) => ({
      type: "pillar.add",
      pillar: { width: 0.4, depth: 0.4, height: 2.7, rotation: 0, position: { x, y: 1.55, z } }
    });
    const windowAt = (rotation: number, x: number, z: number) => ({
      type: "window.add",
      window: { width: 1.2, height: 1.2, thickness: 0.05, rotation, position: { x, y: 1.7, z } }
    });

    assertDeepEqual(
      buildSimpleHousePlan({ length: 10, width: 8 }),
      [
        { type: "slab.add", slab: { length: 10, width: 8, thickness: 0.2, rotation: 0, position: { x: 0, y: 0.1, z: 0 } } },
        wall(9.2, 0, 0, 3.9),
        wall(9.2, 0, 0, -3.9),
        wall(7.2, quarterTurn, -4.9, 0),
        wall(7.2, quarterTurn, 4.9, 0),
        pillar(-4.8, -3.8),
        pillar(4.8, -3.8),
        pillar(4.8, 3.8),
        pillar(-4.8, 3.8),
        { type: "door.add", door: { width: 0.9, height: 2.1, thickness: 0.05, rotation: 0, position: { x: 0, y: 1.25, z: 4.025 } } },
        windowAt(0, -2.5, -4.025),
        windowAt(quarterTurn, 5.025, -2)
      ],
      "the plan"
    );
  });

  /** A plan command as the geometry analysis sees an object - the same fields buildAIProjectSnapshot copies out of a store. */
  function planObject(command: Command, index: number) {
    const type = command.type.split(".")[0] as AIContextObject["type"];
    const options = (command as unknown as Record<string, { position: AIContextObject["position"]; rotation: number } & Record<string, number>>)[type];
    const { position, rotation, ...dimensions } = options;
    return { id: `${type}-${index + 1}`, type, position, rotation, dimensions, material: "generic", color: "#c9c9c9", assemblyIds: [] };
  }

  await check("the house plan's parts meet face to face - no two boxes share any volume - on several footprints", () => {
    for (const footprint of [{ length: 10, width: 8 }, { length: 4, width: 4 }, { length: 23.5, width: 11 }]) {
      const objects = buildSimpleHousePlan(footprint).map(planObject);
      const geometry = analyzeConstructionGeometry({ ...emptySnapshot, objects });
      const label = `${footprint.length} x ${footprint.width}`;

      assertEqual(geometry.invalidObjects.length, 0, `${label}: no invalid objects`);
      const overlapping = geometry.relationships.filter((pair) => pair.overlap.aabb).map((pair) => `${pair.a}/${pair.b}`);
      assertEqual(overlapping.join(", "), "", `${label}: no overlapping pair`);
    }
  });

  await check("MockAIProvider reads the footprint ('12 x 9', '12.5 by 9 metres') and falls back to 10 x 8 with a note", () => {
    assertDeepEqual(interpretWith("Build a house, 12 x 9").commands, buildSimpleHousePlan({ length: 12, width: 9 }), "12 x 9");
    assertDeepEqual(
      interpretWith("Create a small cottage 12.5 by 9 metres").commands,
      buildSimpleHousePlan({ length: 12.5, width: 9 }),
      "12.5 by 9 metres"
    );
    const defaulted = interpretWith("Build me a house");
    assertDeepEqual(defaulted.commands, buildSimpleHousePlan(DEFAULT_HOUSE_FOOTPRINT), "the default footprint");
    assertTrue(defaulted.notes?.includes("No footprint was given"), "the default is explained");
  });

  await check("MockAIProvider refuses an out-of-range footprint, or a house whose types aren't all available - notes, no commands", () => {
    const tiny = interpretWith("Build a house 2m x 3m");
    assertEqual(tiny.commands.length, 0, "no commands for a 2 x 3 footprint");
    assertTrue(tiny.notes?.includes("outside what the house plan supports"), "explained");

    const noDoors = interpretWith(HOUSE_INSTRUCTION, emptyContext, AI_SUPPORTED_OBJECT_TYPES.filter((type) => type !== "door"));
    assertEqual(noDoors.commands.length, 0, "no commands without doors");
    assertTrue(noDoors.notes?.includes("door"), "the missing type is named");
  });

  await check("MockAIProvider only plans a house when a new house is asked for", () => {
    assertDeepEqual(interpretWith("Build a wall next to the house").commands, [{ type: "wall.add", wall: {} }], "a wall next to a house is a wall");
    assertDeepEqual(interpretWith("Add a door to the house").commands, [{ type: "door.add", door: {} }], "a door for a house is a door");
    assertDeepEqual(interpretWith("Create a wall and add a pillar").commands.length, 2, "ordinary instructions are unaffected");
  });

  await check("MockAIProvider uses the context's geometry to place the house clear of existing objects", () => {
    const wallAtOrigin: AIContextObject = {
      id: "wall-1",
      type: "wall",
      position: { x: 0, y: 1.35, z: 0 },
      rotation: 0,
      dimensions: { height: 2.7, length: 4, thickness: 0.2 },
      material: "generic",
      color: "#c9c9c9",
      assemblyIds: []
    };
    const context = buildAIProjectContext({ ...emptySnapshot, wallCount: 1, objects: [wallAtOrigin] });

    const response = interpretWith(HOUSE_INSTRUCTION, context);

    // The wall reaches x = 2; 1 m clearance plus the plan's 5.05 m half-reach is 8.05, rounded up to the next half meter.
    assertDeepEqual(response.commands, buildSimpleHousePlan({ length: 10, width: 8, center: { x: 8.5, z: 0 } }), "moved to x = 8.5");
    assertTrue(response.notes?.includes("centered at x = 8.5, z = 0, clear of the existing objects"), "notes say where, and why");

    const objects = [wallAtOrigin, ...(response.commands as Command[]).map((command, index) => planObject(command, index + 1))];
    const geometry = analyzeConstructionGeometry({ ...emptySnapshot, objects });
    assertEqual(geometry.relationships.filter((pair) => pair.overlap.aabb).length, 0, "the house overlaps nothing, the existing wall included");
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

  await check("AICommandPipeline holds no store reference - only a provider, a CommandExecutorLike, and an optional history group handle", async () => {
    const pipeline = new AICommandPipeline(new MockAIProvider(), makeExecutorSpy());

    const ownProperties = Object.getOwnPropertyNames(pipeline).sort();

    assertDeepEqual(ownProperties, ["commandExecutor", "history", "provider"], "AICommandPipeline's own instance properties");
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
      wallStore: { getAll: () => Array.from({ length: counts.wallCount }, (_, index) => wallRecord(`wall-${index + 1}`)) },
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
    assertDeepEqual(
      controller.getState(),
      { status: "idle", message: null, notes: null, summary: null, updateSummary: null, details: null, houseSummary: null },
      "initial state"
    );
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
      ["listeners", "onCreated", "state", "submitInstruction"],
      "AiPromptController's own instance properties"
    );
  });

  await check("AiPromptController's result summary counts only objects actually created, and reports them to onCreated", async () => {
    const created: string[][] = [];
    const controller = new AiPromptController(
      async () =>
        makeResult({
          outcomes: [
            { command: { type: "wall.add", wall: {} }, result: { success: true, objectId: "wall-1" } },
            { command: { type: "wall.add", wall: {} }, result: { success: true, objectId: "wall-2" } },
            { command: { type: "element.add", element: { kind: "room" } }, result: { success: true, objectId: "element-1" } },
            // A door.update never created anything - it must not be counted, even though it succeeded.
            { command: { type: "door.update", id: "door-1", changes: {} }, result: { success: true } }
          ]
        }),
      (objectIds) => created.push([...objectIds])
    );

    await controller.submit("Create a room with two walls");

    const summary = controller.getState().summary;
    assertTrue(summary !== null, "a build that created objects should report a summary");
    assertEqual(summary?.total, 3, "total created (the update is excluded)");
    assertDeepEqual(summary?.byType, [{ label: "room", count: 1 }, { label: "walls", count: 2 }], "grouped by type, rooms first");
    assertDeepEqual(summary?.objectIds, ["wall-1", "wall-2", "element-1"], "every created object's id, in outcome order");
    assertDeepEqual(created, [["wall-1", "wall-2", "element-1"]], "onCreated is called once, with the same ids");
  });

  await check("AiPromptController reports no summary when nothing was created (an edit-only instruction, or a failure)", async () => {
    const created: string[][] = [];
    const editOnly = new AiPromptController(
      async () =>
        makeResult({
          outcomes: [{ command: { type: "wall.update", id: "wall-1", changes: {} }, result: { success: true } }]
        }),
      (objectIds) => created.push([...objectIds])
    );
    await editOnly.submit("Make the wall longer");
    assertEqual(editOnly.getState().summary, null, "an edit-only success has nothing to summarize");
    assertEqual(created.length, 0, "onCreated should not fire when nothing was created");

    const failed = new AiPromptController(async () =>
      makeResult({
        success: false,
        outcomes: [{ command: { type: "wall.add", wall: {} }, result: { success: false } }],
        errors: [{ stage: "validation", message: "validation failed" }]
      })
    );
    await failed.submit("Create a wall");
    assertEqual(failed.getState().summary, null, "a failed build has nothing to summarize");
  });

  // --- CREATE vs MODIFY (Phase 6) ---

  await check("summarizeUpdatedObjects reports what a create-free response modified, deduplicated by id", () => {
    const summary = summarizeUpdatedObjects([
      { command: { type: "update_object", objectId: "wall-1", changes: {} }, result: { success: true, objectId: "wall-1" } },
      // A second edit to the SAME wall - still one modified object, not two.
      { command: { type: "update_object", objectId: "wall-1", changes: {} }, result: { success: true, objectId: "wall-1" } },
      { command: { type: "door.update", id: "door-1", changes: {} }, result: { success: true, objectId: "door-1" } },
      // Failed and create outcomes are never counted as a modify.
      { command: { type: "update_object", objectId: "wall-2", changes: {} }, result: { success: false } },
      { command: { type: "wall.add", wall: {} }, result: { success: true, objectId: "wall-3" } }
    ]);
    assertTrue(summary !== null, "a response with successful updates has something to summarize");
    assertEqual(summary?.total, 2, "wall-1 (once) and door-1");
    assertDeepEqual(summary?.objectIds, ["wall-1", "door-1"], "in outcome order, deduplicated");
  });

  await check("summarizeUpdatedObjects reports null when nothing was actually modified", () => {
    assertEqual(summarizeUpdatedObjects([]), null, "no outcomes at all");
    assertEqual(
      summarizeUpdatedObjects([{ command: { type: "wall.add", wall: {} }, result: { success: true, objectId: "wall-1" } }]),
      null,
      "a create is not a modify"
    );
  });

  await check("AiPromptController reports updateSummary (not summary) for a successful create-free response, and still calls onCreated to focus what changed", async () => {
    const focused: string[][] = [];
    const controller = new AiPromptController(
      async () =>
        makeResult({
          outcomes: [{ command: { type: "update_object", objectId: "wall-1", changes: {} }, result: { success: true, objectId: "wall-1" } }]
        }),
      (objectIds) => focused.push([...objectIds])
    );

    await controller.submit("Make the wall longer");

    const state = controller.getState();
    assertEqual(state.summary, null, "nothing was created, so the CREATE card has nothing to show");
    assertTrue(state.updateSummary !== null, "a successful modify reports an updateSummary");
    assertEqual(state.updateSummary?.total, 1, "one object modified");
    assertDeepEqual(state.updateSummary?.objectIds, ["wall-1"], "the modified object's id");
    assertDeepEqual(focused, [["wall-1"]], "onCreated is still called, so the viewport frames what was modified");
  });

  await check("a response that both creates and modifies shows the CREATE card, never both at once", async () => {
    const controller = new AiPromptController(async () =>
      makeResult({
        outcomes: [
          { command: { type: "wall.add", wall: {} }, result: { success: true, objectId: "wall-2" } },
          { command: { type: "update_object", objectId: "wall-1", changes: {} }, result: { success: true, objectId: "wall-1" } }
        ]
      })
    );
    await controller.submit("Add a wall and make the other one longer");
    const state = controller.getState();
    assertTrue(state.summary !== null, "the create should still be reported");
    assertEqual(state.updateSummary, null, "updateSummary is suppressed whenever summary (create) is present");
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

  // --- update_object: MockAIProvider and the pipeline's structural check ---

  function assertIncludes(actual: string | null | undefined, needle: string, message: string): void {
    if (actual === null || actual === undefined || !actual.includes(needle)) {
      throw new Error(`${message}: expected ${JSON.stringify(actual)} to include ${JSON.stringify(needle)}`);
    }
  }

  /** Freezes `value` and everything inside it - any later attempt to mutate it throws in strict mode. */
  function deepFreeze<T>(value: T): T {
    if (value !== null && typeof value === "object") {
      for (const child of Object.values(value)) {
        deepFreeze(child);
      }
      Object.freeze(value);
    }
    return value;
  }

  function interpretAgainst(projectContext: AIProjectSnapshot, instruction: string): AIProviderResponse {
    return new MockAIProvider().interpret({
      instruction,
      projectContext: buildAIProjectContext(projectContext),
      availableObjectTypes: AI_SUPPORTED_OBJECT_TYPES
    });
  }

  const editableContext = buildAIProjectSnapshot(
    makeSnapshotSource({
      walls: [wallRecord("wall-1", { rotation: 0.5 })],
      pillars: [objectRecord("pillar-1", "pillar", { width: 0.4, depth: 0.4, height: 2.7 })]
    })
  );

  await check('MockAIProvider turns "Make wall-1 5 meters long." into an update_object command', () => {
    assertDeepEqual(
      interpretAgainst(editableContext, "Make wall-1 5 meters long.").commands,
      [{ type: "update_object", objectId: "wall-1", changes: { dimensions: { length: 5 } } }],
      "commands"
    );
  });

  await check('MockAIProvider turns "Change wall-1 height to 3.2 meters." into an update_object command', () => {
    assertDeepEqual(
      interpretAgainst(editableContext, "Change wall-1 height to 3.2 meters.").commands,
      [{ type: "update_object", objectId: "wall-1", changes: { dimensions: { height: 3.2 } } }],
      "commands"
    );
  });

  await check('MockAIProvider turns "Rotate wall-1 by 90 degrees." into a rotation relative to its current one', () => {
    assertDeepEqual(
      interpretAgainst(editableContext, "Rotate wall-1 by 90 degrees.").commands,
      [{ type: "update_object", objectId: "wall-1", changes: { rotation: 0.5 + Math.PI / 2 } }],
      "0.5 rad (current, from the snapshot) + 90 degrees"
    );
    assertDeepEqual(
      interpretAgainst(editableContext, "Rotate wall-1 to 45 degrees").commands,
      [{ type: "update_object", objectId: "wall-1", changes: { rotation: Math.PI / 4 } }],
      '"to" is absolute'
    );
  });

  await check('MockAIProvider turns "Move wall-1 to X=2." into a single-axis position change', () => {
    assertDeepEqual(
      interpretAgainst(editableContext, "Move wall-1 to X=2.").commands,
      [{ type: "update_object", objectId: "wall-1", changes: { position: { x: 2 } } }],
      "commands"
    );
  });

  await check("MockAIProvider never invents an id - an edit naming an unknown object produces no command at all", () => {
    const response = interpretAgainst(editableContext, "Make wall-9 5 meters long.");

    assertDeepEqual(response.commands, [], "no update, and no fallback wall.add");
    assertTrue(response.notes?.includes('No existing object with id "wall-9"'), "the note explains why");
  });

  await check("MockAIProvider won't ask to change a dimension the object doesn't have", () => {
    const response = interpretAgainst(editableContext, "Make pillar-1 5 meters long.");

    assertDeepEqual(response.commands, [], "a pillar has no length");
    assertTrue(response.notes?.includes('pillar-1 (pillar) has no "length" dimension'), "the note explains why");
  });

  await check("MockAIProvider only reads the snapshot - a frozen snapshot survives every edit instruction", () => {
    const frozen = deepFreeze(JSON.parse(JSON.stringify(editableContext)) as AIProjectSnapshot);
    const before = JSON.stringify(frozen);

    for (const instruction of [
      "Make wall-1 5 meters long.",
      "Change wall-1 height to 3.2 meters.",
      "Rotate wall-1 by 90 degrees.",
      "Move wall-1 to X=2."
    ]) {
      interpretAgainst(frozen, instruction);
    }

    assertEqual(JSON.stringify(frozen), before, "snapshot unchanged");
  });

  await check("AICommandPipeline passes a well-formed update_object to CommandExecutor unchanged", async () => {
    const command = { type: "update_object", objectId: "wall-1", changes: { dimensions: { length: 5 } } };
    const executor = makeExecutorSpy();
    const pipeline = new AICommandPipeline(fixedProvider({ commands: [command] }), executor);

    const result = await pipeline.run("Make wall-1 5 meters long", editableContext);

    assertTrue(result.success, "result.success");
    assertDeepEqual(executor.calls, [command], "the executor received exactly this command");
  });

  await check("AICommandPipeline rejects malformed update_object commands before execution", async () => {
    const malformed = [
      { type: "update_object", changes: { color: "#000000" } },
      { type: "update_object", objectId: "", changes: { color: "#000000" } },
      { type: "update_object", objectId: "wall-1" },
      { type: "update_object", objectId: "wall-1", changes: "wider" },
      { type: "update_object", objectId: "wall-1", changes: [1] }
    ];

    for (const command of malformed) {
      const executor = makeExecutorSpy();
      const pipeline = new AICommandPipeline(fixedProvider({ commands: [command] }), executor);
      const result = await pipeline.run("Edit something", editableContext);

      assertEqual(result.success, false, `${JSON.stringify(command)}: rejected`);
      assertEqual(result.errors[0].stage, "validation", `${JSON.stringify(command)}: rejected structurally`);
      assertIncludes(result.errors[0].message, "Malformed update_object", `${JSON.stringify(command)}: clear message`);
      assertEqual(executor.calls.length, 0, `${JSON.stringify(command)}: never executed`);
    }
  });

  await check("AICommandPipeline rejects an update_object whose target type isn't available in this context", async () => {
    const executor = makeExecutorSpy();
    const command = { type: "update_object", objectId: "pillar-1", changes: { dimensions: { width: 0.5 } } };
    const pipeline = new AICommandPipeline(fixedProvider({ commands: [command] }), executor);

    const result = await pipeline.run(
      "Make pillar-1 wider",
      editableContext,
      AI_SUPPORTED_OBJECT_TYPES.filter((type) => type !== "pillar")
    );

    assertEqual(result.success, false, "result.success");
    assertIncludes(result.errors[0].message, "not available", "clear message");
    assertEqual(executor.calls.length, 0, "never executed");
  });

  await check("AICommandPipeline leaves the snapshot untouched while running an update", async () => {
    const frozen = deepFreeze(JSON.parse(JSON.stringify(editableContext)) as AIProjectSnapshot);
    const before = JSON.stringify(frozen);
    const pipeline = new AICommandPipeline(new MockAIProvider(), makeExecutorSpy());

    const result = await pipeline.run("Make wall-1 5 meters long.", frozen);

    assertTrue(result.success, "result.success");
    assertEqual(JSON.stringify(frozen), before, "snapshot unchanged");
  });

  // --- Geometry in the AI context ---

  type ContextObject = AIProjectSnapshot["objects"][number];

  function geometryWall(
    id: string,
    x: number,
    z: number,
    rotation = 0,
    dimensions: Record<string, number> = { height: 3, length: 4, thickness: 0.2 }
  ): ContextObject {
    return {
      id,
      type: "wall",
      position: { x, y: 1.5, z },
      rotation,
      dimensions: { ...dimensions },
      material: "generic",
      color: "#c9c9c9",
      assemblyIds: []
    };
  }

  function snapshotOf(objects: ContextObject[]): AIProjectSnapshot {
    return { ...emptySnapshot, wallCount: objects.filter((object) => object.type === "wall").length, objects };
  }

  // Two 4 m walls along X, 6 m apart center to center: wall-1 spans x -2..2, wall-2 spans x 4..8.
  const twoWalls = snapshotOf([geometryWall("wall-1", 0, 0), geometryWall("wall-2", 6, 0)]);
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

  /** An AIProvider that records every request it receives and answers with no commands. */
  function makeRecordingProvider(): AIProvider & { requests: AIProviderRequest[] } {
    const requests: AIProviderRequest[] = [];
    return {
      requests,
      interpret: (request) => {
        requests.push(request);
        return { commands: [] };
      }
    };
  }

  function withoutGeometry(context: AIProjectContext): Record<string, unknown> {
    return Object.fromEntries(Object.entries(context).filter(([key]) => key !== "geometry"));
  }

  function objectReferences(value: unknown, into: Set<object> = new Set()): Set<object> {
    if (typeof value === "object" && value !== null) {
      into.add(value);
      for (const child of Object.values(value)) {
        objectReferences(child, into);
      }
    }
    return into;
  }

  /** Every object and array is plain (no class instance) and frozen; every leaf is JSON data. */
  function assertPlainAndFrozen(value: unknown, path: string): void {
    if (typeof value !== "object" || value === null) {
      assertTrue(typeof value !== "function" && typeof value !== "undefined", `${path} must be JSON data`);
      return;
    }
    const prototype = Object.getPrototypeOf(value);
    assertTrue(prototype === Object.prototype || prototype === Array.prototype, `${path} must be a plain object or array`);
    assertTrue(Object.isFrozen(value), `${path} must be frozen`);
    for (const [key, child] of Object.entries(value)) {
      assertPlainAndFrozen(child, `${path}.${key}`);
    }
  }

  await check("A. a two-wall project's AI context carries a geometry section with both walls and their relationship", () => {
    const context = buildAIProjectContext(twoWalls);

    assertDeepEqual(context.geometry.objects.map((object) => object.id), ["wall-1", "wall-2"], "analyzed objects");
    assertEqual(context.geometry.relationships.length, 1, "one pair");
    assertDeepEqual(context.geometry.invalidObjects, [], "no invalid objects");
    assertDeepEqual(Object.keys(context), [...Object.keys(twoWalls), "geometry"], "the snapshot's own fields, then geometry");
  });

  await check("C. exact distances, gaps, overlap flags, and direction flags are in the context", () => {
    assertDeepEqual(buildAIProjectContext(twoWalls).geometry.relationships[0], expectedWallPair, "wall-1 / wall-2");
  });

  await check("D. the context's geometry is analyzeConstructionGeometry() of the very snapshot beside it", () => {
    const context = buildAIProjectContext(twoWalls);

    assertDeepEqual(withoutGeometry(context), twoWalls, "the snapshot fields are the snapshot, unchanged");
    assertDeepEqual(context.geometry, analyzeConstructionGeometry(twoWalls), "same result as the analyzer on the input");
    assertDeepEqual(
      context.geometry,
      analyzeConstructionGeometry(withoutGeometry(context) as unknown as AIProjectSnapshot),
      "and on the context's own objects"
    );
  });

  await check("B. AICommandPipeline hands the provider the geometry-aware context, relationship intact", async () => {
    const provider = makeRecordingProvider();

    await new AICommandPipeline(provider, makeExecutorSpy()).run("Describe the walls", twoWalls);

    assertEqual(provider.requests.length, 1, "one provider call");
    const received = provider.requests[0].projectContext;
    assertDeepEqual(received.geometry.relationships, [expectedWallPair], "the relationship the provider received");
    assertDeepEqual(received, buildAIProjectContext(twoWalls), "exactly the context built from the snapshot");
  });

  await check("AICommandPipeline derives geometry itself - geometry a caller attaches to the snapshot is ignored", async () => {
    const provider = makeRecordingProvider();
    const fabricated = { objects: [], relationships: [{ ...expectedWallPair, centerDistance: 999 }], invalidObjects: [] };

    await new AICommandPipeline(provider, makeExecutorSpy()).run("Describe the walls", {
      ...twoWalls,
      geometry: fabricated
    } as AIProjectSnapshot);

    assertDeepEqual(provider.requests[0].projectContext.geometry, analyzeConstructionGeometry(twoWalls), "derived, not the attached one");
  });

  await check("E. moving an object changes the derived geometry", () => {
    const moved = buildAIProjectContext(snapshotOf([geometryWall("wall-1", 0, 0), geometryWall("wall-2", 10, 0)]));
    const pair = moved.geometry.relationships[0];

    assertEqual(pair.centerDistance, 10, "centers 10 m apart");
    assertDeepEqual(pair.gap, { x: 6, y: 0, z: 0 }, "6 m clear between x 2 and x 8");
    assertTrue(
      JSON.stringify(moved.geometry) !== JSON.stringify(buildAIProjectContext(twoWalls).geometry),
      "different from before the move"
    );
  });

  await check("F. rotating an object changes its box and, here, its relationship", () => {
    // wall-2 sits 1.5 m in front of wall-1. Turned 90 degrees, wall-1 runs along Z and reaches it.
    const straight = buildAIProjectContext(snapshotOf([geometryWall("wall-1", 0, 0), geometryWall("wall-2", 0, 1.5)]));
    const turned = buildAIProjectContext(snapshotOf([geometryWall("wall-1", 0, 0, Math.PI / 2), geometryWall("wall-2", 0, 1.5)]));

    assertDeepEqual(straight.geometry.objects[0].aabb, { min: { x: -2, y: 0, z: -0.1 }, max: { x: 2, y: 3, z: 0.1 } }, "unrotated wall-1");
    assertDeepEqual(turned.geometry.objects[0].aabb, { min: { x: -0.1, y: 0, z: -2 }, max: { x: 0.1, y: 3, z: 2 } }, "rotated wall-1");
    assertEqual(straight.geometry.relationships[0].overlap.aabb, false, "apart when unrotated");
    assertEqual(straight.geometry.relationships[0].aRelativeToB.behind, true, "wall-1 entirely behind wall-2");
    assertEqual(turned.geometry.relationships[0].overlap.aabb, true, "the boxes overlap once wall-1 is rotated");
    assertEqual(turned.geometry.relationships[0].aRelativeToB.behind, false, "no longer entirely behind");
  });

  await check("G. an empty project gets a valid, empty geometry section", async () => {
    // hosts and connections arrived with wall hosting and endpoint connections.
    assertDeepEqual(emptyContext.geometry, { objects: [], relationships: [], invalidObjects: [], hosts: [], connections: [] }, "empty geometry");

    const provider = makeRecordingProvider();
    await new AICommandPipeline(provider, makeExecutorSpy()).run("What is here?", emptySnapshot);
    assertDeepEqual(provider.requests[0].projectContext, emptyContext, "what the provider received");
  });

  await check("H. an object whose geometry can't be derived appears in geometry.invalidObjects", () => {
    const context = buildAIProjectContext(
      snapshotOf([geometryWall("wall-1", 0, 0), geometryWall("wall-3", 3, 3, 0, { height: 3, length: 4, thickness: 0 })])
    );

    assertDeepEqual(
      context.geometry.invalidObjects,
      [{ id: "wall-3", type: "wall", errors: [{ field: "dimensions.thickness", message: "Thickness must be a finite number greater than 0." }] }],
      "invalid objects"
    );
    assertDeepEqual(context.geometry.objects.map((object) => object.id), ["wall-1"], "only the valid wall is boxed");
    assertDeepEqual(context.geometry.relationships, [], "no relationship involves it");
    assertEqual(context.objects.length, 2, "the snapshot part still lists both - geometry doesn't filter the model");
  });

  await check("I. geometry is deterministic and sorted, whatever order the snapshot lists objects in", () => {
    const objects = [geometryWall("wall-10", 0, 5), geometryWall("wall-2", 6, 0), geometryWall("wall-1", 0, 0)];
    const context = buildAIProjectContext(snapshotOf(objects));

    assertDeepEqual(context.geometry.objects.map((object) => object.id), ["wall-1", "wall-2", "wall-10"], "sorted by id");
    assertDeepEqual(
      context.geometry.relationships.map((pair) => `${pair.a}|${pair.b}`),
      ["wall-1|wall-2", "wall-1|wall-10", "wall-2|wall-10"],
      "pairs in id order"
    );
    assertEqual(JSON.stringify(buildAIProjectContext(snapshotOf(objects))), JSON.stringify(context), "a second build is byte-identical");
    assertEqual(
      JSON.stringify(buildAIProjectContext(snapshotOf([...objects].reverse())).geometry),
      JSON.stringify(context.geometry),
      "reordered input, identical geometry"
    );
  });

  await check("J. building the context and running the pipeline leave the snapshot unchanged", async () => {
    const snapshot = deepFreeze(JSON.parse(JSON.stringify(twoWalls)) as AIProjectSnapshot);
    const before = JSON.stringify(snapshot);

    const context = buildAIProjectContext(snapshot);
    await new AICommandPipeline(new MockAIProvider(), makeExecutorSpy()).run("Compare wall-1 with wall-2", snapshot);

    assertEqual(JSON.stringify(snapshot), before, "snapshot byte-for-byte unchanged");
    const inputReferences = objectReferences(snapshot);
    const shared = [...objectReferences(context)].filter((reference) => inputReferences.has(reference));
    assertEqual(shared.length, 0, "the context shares no object with the snapshot");
  });

  await check("K. no class instances, functions, DOM-like objects, or circular references reach the provider", async () => {
    class FakeMesh {
      readonly isObject3D = true;
      parent: unknown = null;
    }
    const mesh = new FakeMesh();
    mesh.parent = mesh; // circular - JSON.stringify would throw if this were ever reached

    const polluted = JSON.parse(JSON.stringify(twoWalls));
    polluted.renderer = { domElement: { nodeType: 1, tagName: "CANVAS" } };
    polluted.self = polluted;
    polluted.objects[0].mesh = mesh;
    polluted.objects[0].onClick = () => undefined;
    polluted.objects[0].position.w = 1;
    polluted.objects[0].dimensions.area = () => 0;
    polluted.geometry = { objects: [mesh], relationships: "fabricated", invalidObjects: null };

    const provider = makeRecordingProvider();
    await new AICommandPipeline(provider, makeExecutorSpy()).run("Describe the walls", polluted as AIProjectSnapshot);
    const received = provider.requests[0].projectContext;

    assertDeepEqual(received, buildAIProjectContext(twoWalls), "exactly the clean context");
    const serialized = JSON.stringify(received);
    for (const leak of ["isObject3D", "nodeType", "renderer", "onClick", "fabricated", '"w"']) {
      assertTrue(!serialized.includes(leak), `${leak} must not reach the provider`);
    }
    assertPlainAndFrozen(received, "context");
  });

  await check("the context is frozen - a provider can read it but can't change it", () => {
    const context = buildAIProjectContext(twoWalls);

    let threw = false;
    try {
      context.geometry.relationships[0].centerDistance = 1;
    } catch {
      threw = true;
    }

    assertTrue(threw, "writing to the context throws");
    assertEqual(context.geometry.relationships[0].centerDistance, 6, "value unchanged");
  });

  await check("MockAIProvider reports the geometry relationship between two named objects, copied verbatim", () => {
    const response = new MockAIProvider().interpret({
      instruction: "Compare wall-1 with wall-2",
      projectContext: buildAIProjectContext(twoWalls),
      availableObjectTypes: AI_SUPPORTED_OBJECT_TYPES
    });

    assertIncludes(response.notes, "Referenced existing objects: wall-1 (wall), wall-2 (wall).", "both walls found");
    assertIncludes(response.notes, `Geometry relationship: ${JSON.stringify(expectedWallPair)}.`, "the exact relationship from the context");
  });

  await check("MockAIProvider adds no geometry note when fewer than two objects are named", () => {
    const response = new MockAIProvider().interpret({
      instruction: "Make wall-1 5 meters long.",
      projectContext: buildAIProjectContext(twoWalls),
      availableObjectTypes: AI_SUPPORTED_OBJECT_TYPES
    });

    assertIncludes(response.notes, "Referenced existing objects: wall-1 (wall).", "one wall found");
    assertTrue(!(response.notes ?? "").includes("Geometry relationship"), "no pair, no geometry note");
  });

  await check("MockAIProvider's geometry note never becomes a command - no spatial behavior", () => {
    const response = new MockAIProvider().interpret({
      instruction: "Make wall-1 5 meters deep and make wall-2 5 meters deep",
      projectContext: buildAIProjectContext(twoWalls),
      availableObjectTypes: AI_SUPPORTED_OBJECT_TYPES
    });

    assertDeepEqual(response.commands, [], "walls have no depth - nothing to do, and nothing spatial invented");
    assertIncludes(response.notes, `Geometry relationship: ${JSON.stringify(expectedWallPair)}.`, "the geometry was still seen");
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
