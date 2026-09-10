/**
 * End-to-end verification of the complete AI request path, from a
 * command-bar instruction all the way down to a real construction
 * object in a real store, with a real undo entry - without any OpenAI
 * API call, key, or endpoint being involved at any point.
 *
 * What is REAL here (everything the running app uses):
 *   - createProjectContext() - the real composition root: real stores,
 *     real *HistoryController classes, the real shared HistoryManager,
 *     the real SelectionStore, the real CommandExecutor.
 *   - AIService, AICommandPipeline, BackendAIProvider, AiPromptController
 *     - the exact objects main.ts and ui/commandBar.ts construct.
 *
 * What is SUBSTITUTED (exactly one thing):
 *   - the HTTP transport handed to BackendAIProvider, replaced by
 *     ./mockBackend.ts, which enforces the same request contract and
 *     status codes the real backend does. Nothing else is faked: the
 *     pipeline still validates, the executor still executes, the stores
 *     still validate, history still records.
 *
 * Why this file needs `--experimental-transform-types` (see the root
 * package.json's "verify" script): driving the REAL ProjectContext means
 * loading the real *HistoryController classes, which use TypeScript
 * parameter-property constructor shorthand. Node's default strip-only
 * mode rejects that syntax; the transform mode runs it. Every other
 * verify.ts in this project sticks to strip-only because it only needs
 * plain classes - this suite is the one that deliberately reaches for
 * the real thing rather than the *HistoryLike stand-ins those files use.
 *
 * Explicit .ts extensions below are required for Node to resolve these
 * relative imports (see allowImportingTsExtensions in tsconfig.json).
 */
// "node:fs"/"node:url" below are typed by src/node-builtins.d.ts, a
// minimal shared ambient shim - see that file for why it exists instead
// of an @types/node dependency.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { clearProject, createProjectContext } from "../../project/ProjectContext.ts";
import { firstFreeSlot } from "../../project/placement.ts";
import { resolveConstructionObject } from "../../objects/resolveConstructionObject.ts";
import { parseAIProjectSnapshot } from "../parseProjectSnapshot.ts";
import type { ProjectContext } from "../../project/ProjectContext.ts";
import { AIService } from "../AIService.ts";
import { AiPromptController } from "../AiPromptController.ts";
import { BackendAIProvider } from "../providers/BackendAIProvider.ts";
import { createMockBackend } from "./mockBackend.ts";
import { MockAIProvider } from "../MockAIProvider.ts";
import { AI_SUPPORTED_OBJECT_TYPES, buildAIProjectSnapshot } from "../types.ts";
import { analyzeConstructionGeometry } from "../geometry/analyzeConstructionGeometry.ts";
import { buildAIProjectContext } from "../aiProjectContext.ts";
import { ObjectManipulator, createStoreObjectReader } from "../../manipulation/ObjectManipulator.ts";
import type { ConstructionGeometryAnalysis } from "../geometry/types.ts";
import type { MockBackend, MockBackendHandler } from "./mockBackend.ts";
import type { WallData } from "../../wall/types.ts";
import type { PillarData } from "../../pillar/types.ts";

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

function assertIncludes(actual: string | null, needle: string, message: string): void {
  if (actual === null || !actual.includes(needle)) {
    throw new Error(`${message}: expected ${JSON.stringify(actual)} to include ${JSON.stringify(needle)}`);
  }
}

/** The backend base URL these checks point BackendAIProvider at. Never contacted - the injected mock transport answers instead. */
const BASE_URL = "http://localhost:8787";

interface WiredApp {
  context: ProjectContext;
  backend: MockBackend;
  controller: AiPromptController;
}

/**
 * Wires the application exactly the way main.ts does - same classes, same
 * order, same shared CommandExecutor - substituting only the HTTP
 * transport. Every check below starts from one of these, so nothing in
 * this file can reach a store except through the paths the real app uses.
 */
function wireApp(handler: MockBackendHandler): WiredApp {
  const context = createProjectContext();
  const backend = createMockBackend(handler);
  const provider = new BackendAIProvider({ baseUrl: BASE_URL, fetch: backend.fetch });
  const service = new AIService({
    provider,
    commandExecutor: context.commandExecutor,
    snapshotSource: context
  });
  const controller = new AiPromptController((instruction) => service.submit(instruction));
  return { context, backend, controller };
}

/** Answers every request with the same fixed set of commands. */
function alwaysReply(commands: unknown[], notes?: string): MockBackendHandler {
  return () => (notes === undefined ? { kind: "ok", commands } : { kind: "ok", commands, notes });
}

function makeDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/**
 * The relationship between two objects, plus the directional facts for
 * `first` relative to `second` - mirrored when the analysis stored the
 * pair the other way round (it always orders a pair by id).
 */
function relationBetween(analysis: ConstructionGeometryAnalysis, first: string, second: string) {
  const pair = analysis.relationships.find(
    (relationship) => (relationship.a === first && relationship.b === second) || (relationship.a === second && relationship.b === first)
  );
  assertTrue(pair, `no relationship between ${first} and ${second}`);
  const r = pair.aRelativeToB;
  const firstRelativeToSecond =
    pair.a === first
      ? r
      : { leftOf: r.rightOf, rightOf: r.leftOf, inFrontOf: r.behind, behind: r.inFrontOf, above: r.below, below: r.above };
  return { pair, firstRelativeToSecond };
}

// --- Source scanning (requirements: no secret in frontend code or fixtures; harness never writes to a store) ---

const SRC_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

function collectSourceFiles(directory: string, collected: string[] = []): string[] {
  for (const entry of readdirSync(directory)) {
    const fullPath = `${directory}/${entry}`;
    const stats = statSync(fullPath);
    if (stats.isDirectory()) {
      collectSourceFiles(fullPath, collected);
    } else if (stats.isFile() && /\.(ts|css|html)$/.test(entry)) {
      collected.push(fullPath);
    }
  }
  return collected;
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

  console.log("AI end-to-end path verification\n");

  // --- A valid instruction reaches a real store ---

  await check("a valid AI instruction creates the expected wall through the whole real path", async () => {
    const app = wireApp(alwaysReply([{ type: "wall.add", wall: { length: 6, height: 3, color: "#ff0000" } }]));

    await app.controller.submit("Build a six metre wall");

    assertEqual(app.backend.requests.length, 1, "exactly one backend request");
    const walls = app.context.wallStore.getAll();
    assertEqual(walls.length, 1, "one wall should exist in the real store");
    assertEqual(walls[0].dimensions.length, 6, "wall length");
    assertEqual(walls[0].dimensions.height, 3, "wall height");
    assertEqual(walls[0].color, "#ff0000", "wall color");
    assertEqual(walls[0].position.y, 1.5, "wall should be grounded at height/2 by the real store rule");
    assertEqual(app.controller.getState().status, "success", "controller status");
    assertEqual(app.controller.getState().message, "1 command executed.", "controller message");
  });

  await check("a multi-command AI response creates objects across several real stores", async () => {
    const app = wireApp(
      alwaysReply([
        { type: "wall.add", wall: {} },
        { type: "pillar.add", pillar: { width: 0.5 } }
      ])
    );

    await app.controller.submit("Add a wall and a pillar");

    assertEqual(app.context.wallStore.getAll().length, 1, "wall store");
    assertEqual(app.context.pillarStore.getAll().length, 1, "pillar store");
    assertEqual(app.context.pillarStore.getAll()[0].dimensions.width, 0.5, "pillar width from the AI command");
    assertEqual(app.controller.getState().message, "2 commands executed.", "controller message");
  });

  // --- Shared history ---

  await check("the shared history system records an AI-created object, and undo/redo reverse it", async () => {
    const app = wireApp(alwaysReply([{ type: "wall.add", wall: { length: 5 } }]));

    assertEqual(app.context.history.canUndo(), false, "nothing to undo before the AI command");

    await app.controller.submit("Build a wall");

    assertEqual(app.context.wallStore.getAll().length, 1, "wall created");
    assertTrue(app.context.history.canUndo(), "the real HistoryManager should have recorded the AI-created wall");

    app.context.history.undo();
    assertEqual(app.context.wallStore.getAll().length, 0, "undo should remove the AI-created wall");

    app.context.history.redo();
    assertEqual(app.context.wallStore.getAll().length, 1, "redo should restore the AI-created wall");
  });

  await check("AI-issued and manually-issued commands share one undo stack, interleaved in order", async () => {
    const app = wireApp(alwaysReply([{ type: "pillar.add", pillar: {} }]));

    // The manual half goes through the same CommandExecutor the toolbar buttons use.
    const manual = app.context.commandExecutor.execute({ type: "wall.add", wall: {} });
    assertTrue(manual.success, "manual wall command should succeed");

    await app.controller.submit("Add a pillar");

    assertEqual(app.context.wallStore.getAll().length, 1, "manual wall present");
    assertEqual(app.context.pillarStore.getAll().length, 1, "AI pillar present");

    app.context.history.undo();
    assertEqual(app.context.pillarStore.getAll().length, 0, "first undo should reverse the AI pillar");
    assertEqual(app.context.wallStore.getAll().length, 1, "the manual wall should still be there");

    app.context.history.undo();
    assertEqual(app.context.wallStore.getAll().length, 0, "second undo should reverse the manual wall - one shared stack");
  });

  // --- Snapshot sent to the backend ---

  await check("the snapshot sent to the backend reflects the current project state", async () => {
    const app = wireApp(alwaysReply([]));

    await app.controller.submit("What is here?");
    assertEqual(app.backend.requests[0].projectContext.wallCount, 0, "first snapshot: no walls yet");
    assertEqual(app.backend.requests[0].projectContext.selectedObjectId, null, "first snapshot: nothing selected");

    // Build state through the real application pathways - the same
    // CommandExecutor the toolbar uses, and the same SelectionStore call
    // main.ts's duplicate action makes.
    const added = app.context.commandExecutor.execute({ type: "wall.add", wall: {} });
    app.context.commandExecutor.execute({ type: "beam.add", beam: {} });
    app.context.selectionStore.select(added.objectId as string);

    await app.controller.submit("What is here now?");

    const second = app.backend.requests[1].projectContext;
    assertEqual(second.wallCount, 1, "second snapshot: wall count");
    assertEqual(second.beamCount, 1, "second snapshot: beam count");
    assertEqual(second.pillarCount, 0, "second snapshot: pillar count");
    assertEqual(second.selectedObjectId, added.objectId as string, "second snapshot: selected object id");
  });

  await check("the snapshot is rebuilt per submission, so it reflects the previous submission's own mutations", async () => {
    const app = wireApp(alwaysReply([{ type: "wall.add", wall: {} }]));

    await app.controller.submit("Add a wall");
    await app.controller.submit("Add another wall");

    assertEqual(app.backend.requests[0].projectContext.wallCount, 0, "first request saw an empty project");
    assertEqual(app.backend.requests[1].projectContext.wallCount, 1, "second request saw the wall the first one created");
    assertEqual(app.context.wallStore.getAll().length, 2, "both walls exist");
  });

  await check("the instruction and available object types reach the backend unchanged", async () => {
    const app = wireApp(alwaysReply([]));

    await app.controller.submit("Build a wall along the north edge");

    assertEqual(app.backend.requests[0].instruction, "Build a wall along the north edge", "instruction forwarded verbatim");
    assertEqual(app.backend.requests[0].method, "POST", "HTTP method");
    assertEqual(app.backend.requests[0].url, `${BASE_URL}/api/ai/interpret`, "endpoint URL");
    const types = app.backend.requests[0].availableObjectTypes as string[];
    assertTrue(Array.isArray(types) && types.includes("wall") && types.includes("window"), "available object types forwarded");
  });

  // --- Rejection before mutation ---

  await check("an unsupported object type is rejected before any store is touched", async () => {
    const app = wireApp(alwaysReply([{ type: "roof.add", roof: {} }]));

    await app.controller.submit("Add a roof");

    assertEqual(app.context.wallStore.getAll().length, 0, "no wall created");
    assertEqual(app.context.pillarStore.getAll().length, 0, "no pillar created");
    assertEqual(app.context.history.canUndo(), false, "nothing should have been recorded in history");
    assertEqual(app.controller.getState().status, "error", "controller status");
    assertIncludes(app.controller.getState().message, "Unsupported object type", "controller message");
  });

  await check("an unsupported command action is rejected before any store is touched", async () => {
    const app = wireApp(alwaysReply([{ type: "wall.frobnicate", id: "wall-1" }]));

    await app.controller.submit("Frobnicate a wall");

    assertEqual(app.context.wallStore.getAll().length, 0, "no wall created");
    assertEqual(app.context.history.canUndo(), false, "no history entry");
    assertIncludes(app.controller.getState().message, "Unsupported command type", "controller message");
  });

  await check("a structurally malformed command is rejected before any store is touched", async () => {
    const app = wireApp(alwaysReply([42]));

    await app.controller.submit("Do something odd");

    assertEqual(app.context.wallStore.getAll().length, 0, "no wall created");
    assertEqual(app.context.history.canUndo(), false, "no history entry");
    assertIncludes(app.controller.getState().message, "Malformed command", "controller message");
  });

  await check("a command with invalid dimensions is rejected by the real store validation, leaving nothing behind", async () => {
    const app = wireApp(alwaysReply([{ type: "wall.add", wall: { length: 0 } }]));

    await app.controller.submit("Build a wall with no length");

    assertEqual(app.context.wallStore.getAll().length, 0, "nothing should have been stored");
    assertEqual(app.context.history.canUndo(), false, "a rejected write records no undo entry");
    assertEqual(app.controller.getState().status, "error", "controller status");
    assertIncludes(app.controller.getState().message, "validation failed", "controller message");
  });

  await check("in a mixed batch, the valid command is applied and the invalid one is rejected", async () => {
    const app = wireApp(
      alwaysReply([
        { type: "wall.add", wall: {} },
        { type: "roof.add", roof: {} }
      ])
    );

    await app.controller.submit("Add a wall and a roof");

    assertEqual(app.context.wallStore.getAll().length, 1, "the valid wall should exist");
    assertTrue(app.context.history.canUndo(), "the valid wall should still be undoable");
    assertEqual(app.controller.getState().status, "error", "the batch as a whole failed");
    assertIncludes(app.controller.getState().message, "1 command of 2 succeeded", "controller message");
  });

  // --- Scene/UI refresh signal ---

  await check("store subscribers - the mechanism the scene and sidebars refresh through - are notified", async () => {
    const app = wireApp(alwaysReply([{ type: "wall.add", wall: { length: 7 } }]));

    // Exactly how WallLayer (scene) and rightSidebar (UI) observe changes.
    const observed: WallData[][] = [];
    app.context.wallStore.subscribe((walls) => observed.push(walls));
    const initialNotifications = observed.length;

    await app.controller.submit("Build a wall");

    assertTrue(observed.length > initialNotifications, "the AI-created wall should have notified store subscribers");
    const latest = observed[observed.length - 1];
    assertEqual(latest.length, 1, "subscriber saw one wall");
    assertEqual(latest[0].dimensions.length, 7, "subscriber saw the AI-supplied dimensions");
  });

  await check("history subscribers - what drives the toolbar's undo/redo buttons - are notified", async () => {
    const app = wireApp(alwaysReply([{ type: "pillar.add", pillar: {} }]));

    const undoStates: boolean[] = [];
    app.context.history.subscribe(() => undoStates.push(app.context.history.canUndo()));
    const before = undoStates.length;

    await app.controller.submit("Add a pillar");

    assertTrue(undoStates.length > before, "history should have notified its subscribers");
    assertEqual(undoStates[undoStates.length - 1], true, "the latest notification reports an undoable action");
  });

  await check("pillar subscribers see the AI-created pillar's real data", async () => {
    const app = wireApp(alwaysReply([{ type: "pillar.add", pillar: { width: 0.6, depth: 0.6 } }]));

    const observed: PillarData[][] = [];
    app.context.pillarStore.subscribe((pillars) => observed.push(pillars));

    await app.controller.submit("Add a wide pillar");

    const latest = observed[observed.length - 1];
    assertEqual(latest.length, 1, "one pillar");
    assertEqual(latest[0].dimensions.width, 0.6, "pillar width");
    assertEqual(latest[0].type, "pillar", "pillar type tag");
  });

  // --- Provider notes ---

  await check("provider notes reach the command-bar controller on a successful result", async () => {
    const app = wireApp(alwaysReply([{ type: "wall.add", wall: {} }], "assumed a default 4m length"));

    await app.controller.submit("Build a wall");

    assertEqual(app.controller.getState().status, "success", "controller status");
    assertEqual(app.controller.getState().notes, "assumed a default 4m length", "controller notes");
  });

  await check("provider notes reach the controller even when the result is a failure", async () => {
    const app = wireApp(alwaysReply([{ type: "roof.add", roof: {} }], "roofs are not supported yet"));

    await app.controller.submit("Add a roof");

    assertEqual(app.controller.getState().status, "error", "controller status");
    assertEqual(app.controller.getState().notes, "roofs are not supported yet", "controller notes");
  });

  await check("a backend that produced no commands surfaces its notes as the failure message", async () => {
    const app = wireApp(alwaysReply([], "nothing in that instruction maps to a construction object"));

    await app.controller.submit("Tell me a joke");

    assertEqual(app.controller.getState().status, "error", "controller status");
    assertIncludes(app.controller.getState().message, "nothing in that instruction", "controller message");
  });

  // --- Backend errors reach the UI ---

  await check("a backend 502 reaches the UI error state without mutating anything", async () => {
    const app = wireApp(() => ({ kind: "status", status: 502, error: "OpenAI request failed with status 401" }));

    await app.controller.submit("Build a wall");

    assertEqual(app.controller.getState().status, "error", "controller status");
    assertIncludes(app.controller.getState().message, "502", "controller message should carry the status code");
    assertEqual(app.context.wallStore.getAll().length, 0, "no mutation");
    assertEqual(app.context.history.canUndo(), false, "no history entry");
  });

  await check("a backend 400 reaches the UI error state", async () => {
    const app = wireApp(() => ({ kind: "status", status: 400, error: '"instruction" is required' }));

    await app.controller.submit("Build a wall");

    assertIncludes(app.controller.getState().message, "400", "controller message");
    assertEqual(app.context.wallStore.getAll().length, 0, "no mutation");
  });

  await check("an unreachable backend reaches the UI error state", async () => {
    const app = wireApp(() => ({ kind: "networkError", message: "Failed to fetch" }));

    await app.controller.submit("Build a wall");

    assertEqual(app.controller.getState().status, "error", "controller status");
    assertIncludes(app.controller.getState().message, "Backend request failed", "controller message");
    assertEqual(app.context.wallStore.getAll().length, 0, "no mutation");
  });

  await check("a malformed backend body reaches the UI error state", async () => {
    const app = wireApp(() => ({ kind: "malformedBody", body: { unexpected: true } }));

    await app.controller.submit("Build a wall");

    assertEqual(app.controller.getState().status, "error", "controller status");
    assertIncludes(app.controller.getState().message, "commands", "controller message should name the missing field");
    assertEqual(app.context.wallStore.getAll().length, 0, "no mutation");
  });

  await check("an empty instruction never reaches the backend at all", async () => {
    const app = wireApp(alwaysReply([{ type: "wall.add", wall: {} }]));

    await app.controller.submit("   ");

    assertEqual(app.backend.requests.length, 0, "no backend request should have been made");
    assertEqual(app.context.wallStore.getAll().length, 0, "no mutation");
    assertIncludes(app.controller.getState().message, "Instruction is empty", "controller message");
  });

  // --- Duplicate submissions ---

  await check("a duplicate submission while one is in flight produces only one backend request", async () => {
    const deferred = makeDeferred<void>();
    let handled = 0;
    const app = wireApp(async () => {
      handled += 1;
      await deferred.promise;
      return { kind: "ok", commands: [{ type: "wall.add", wall: {} }] };
    });

    const first = app.controller.submit("Build a wall");
    const second = app.controller.submit("Build a wall");
    await second;

    assertEqual(app.backend.requests.length, 1, "only one request should have reached the backend");
    assertEqual(handled, 1, "only one handler invocation");
    assertEqual(app.controller.getState().status, "submitting", "still in flight");

    deferred.resolve();
    await first;

    assertEqual(app.controller.getState().status, "success", "the in-flight submission still completes");
    assertEqual(app.context.wallStore.getAll().length, 1, "exactly one wall - not two");
  });

  await check("a submission after the previous one settles is allowed through", async () => {
    const app = wireApp(alwaysReply([{ type: "wall.add", wall: {} }]));

    await app.controller.submit("Build a wall");
    await app.controller.submit("Build another wall");

    assertEqual(app.backend.requests.length, 2, "both requests reached the backend");
    assertEqual(app.context.wallStore.getAll().length, 2, "both walls created");
  });

  // --- Construction context sent to the provider ---

  /** Compares two values by their JSON form, which is what the provider actually receives. */
  function assertSameJson(actual: unknown, expected: unknown, message: string): void {
    assertEqual(JSON.stringify(actual), JSON.stringify(expected), message);
  }

  /**
   * Fails if `value` holds anything but plain JSON data: a function, a
   * class instance (a Three.js mesh, a DOM node, a store), `undefined`
   * (which JSON silently drops), a non-finite number (which JSON turns
   * into null), or the same object reached twice (a shared reference).
   */
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
    assertTrue(
      prototype === Object.prototype || prototype === Array.prototype,
      `${path} must be a plain object or array, not a class instance`
    );
    for (const [key, child] of Object.entries(object)) {
      assertPlainJson(child, `${path}.${key}`, seen);
    }
  }

  await check("the context sent to the backend lists existing objects with ids, types, dimensions, and transforms", async () => {
    const app = wireApp(alwaysReply([]));

    // State built only through the CommandExecutor the toolbar uses.
    const wall = app.context.commandExecutor.execute({ type: "wall.add", wall: { length: 5, height: 3, color: "#336699" } });
    const pillar = app.context.commandExecutor.execute({
      type: "pillar.add",
      pillar: { position: { x: 2, z: -1 }, width: 0.5 }
    });
    app.context.commandExecutor.execute({ type: "wall.update", id: wall.objectId as string, changes: { rotation: 0.5 } });

    await app.controller.submit("Describe the model");

    const context = app.backend.requests[0].projectContext;
    assertEqual(context.objects.length, 2, "both objects are in the context");
    const sentWall = context.objects.find((object) => object.id === wall.objectId);
    const sentPillar = context.objects.find((object) => object.id === pillar.objectId);
    assertTrue(sentWall && sentPillar, "both objects are present under their real ids");

    assertEqual(sentWall.type, "wall", "wall type");
    assertSameJson(sentWall.dimensions, { height: 3, length: 5, thickness: 0.2 }, "wall dimensions, keys sorted");
    assertSameJson(sentWall.position, { x: 0, y: 1.5, z: 0 }, "wall position, grounded by the real store");
    assertEqual(sentWall.rotation, 0.5, "wall rotation reflects the later update");
    assertEqual(sentWall.color, "#336699", "wall color");
    assertEqual(sentWall.material, "generic", "wall material");

    assertEqual(sentPillar.type, "pillar", "pillar type");
    assertSameJson(sentPillar.position, { x: 2, y: 1.35, z: -1 }, "pillar position");
    assertEqual(sentPillar.dimensions.width, 0.5, "pillar width");
  });

  await check("assembly membership reaches the backend, taken from the assemblies' own records", async () => {
    const app = wireApp(alwaysReply([]));

    const wall = app.context.commandExecutor.execute({ type: "wall.add", wall: {} });
    const door = app.context.commandExecutor.execute({ type: "door.add", door: {} });
    const groundFloor = app.context.commandExecutor.execute({
      type: "assembly.create",
      assembly: { name: "Ground Floor", description: "Level 0" }
    });
    const facade = app.context.commandExecutor.execute({ type: "assembly.create", assembly: { name: "Facade" } });
    for (const assembly of [groundFloor, facade]) {
      const added = app.context.commandExecutor.execute({
        type: "assembly.addObject",
        assemblyId: assembly.objectId as string,
        objectId: wall.objectId as string
      });
      assertTrue(added.success, "precondition: the wall was added to the assembly");
    }

    await app.controller.submit("Describe the model");

    const context = app.backend.requests[0].projectContext;
    assertEqual(context.assemblyCount, 2, "assembly count");
    const sentWall = context.objects.find((object) => object.id === wall.objectId);
    const sentDoor = context.objects.find((object) => object.id === door.objectId);
    assertTrue(sentWall && sentDoor, "both objects present");
    assertEqual(sentWall.assemblyIds.length, 2, "the wall belongs to both assemblies");
    assertTrue(
      sentWall.assemblyIds.includes(groundFloor.objectId as string) && sentWall.assemblyIds.includes(facade.objectId as string),
      "the wall lists both assembly ids"
    );
    assertSameJson(sentDoor.assemblyIds, [], "the door is ungrouped");

    const sentGround = context.assemblies.find((assembly) => assembly.id === groundFloor.objectId);
    const sentFacade = context.assemblies.find((assembly) => assembly.id === facade.objectId);
    assertTrue(sentGround && sentFacade, "both assemblies present");
    assertEqual(sentGround.name, "Ground Floor", "assembly name");
    assertEqual(sentGround.description, "Level 0", "assembly description");
    assertSameJson(sentGround.objectIds, [wall.objectId], "assembly members");
    assertEqual(sentFacade.description, null, "an unset description is null, not absent");
  });

  await check("the context is plain JSON data - no class instances, functions, or shared references reach the provider", async () => {
    const app = wireApp(alwaysReply([]));

    const wall = app.context.commandExecutor.execute({ type: "wall.add", wall: {} });
    app.context.commandExecutor.execute({ type: "window.add", window: {} });
    const assembly = app.context.commandExecutor.execute({ type: "assembly.create", assembly: { name: "Core" } });
    app.context.commandExecutor.execute({
      type: "assembly.addObject",
      assemblyId: assembly.objectId as string,
      objectId: wall.objectId as string
    });

    await app.controller.submit("Describe the model");

    // What the builder produced in-process, before any serialization - the
    // stricter check, since a leaked reference would still be live here.
    const built = buildAIProjectSnapshot(app.context);
    assertPlainJson(built, "snapshot");

    // What actually reached the backend matches it exactly.
    assertSameJson(
      app.backend.requests[0].projectContext,
      buildAIProjectContext(built),
      "the backend received exactly the built snapshot, plus geometry derived from it"
    );
  });

  await check("the context is deterministic - undo reordering a store leaves it unchanged", async () => {
    const app = wireApp(alwaysReply([]));

    const first = app.context.commandExecutor.execute({ type: "wall.add", wall: { length: 3 } });
    app.context.commandExecutor.execute({ type: "wall.add", wall: { length: 6 } });
    const before = buildAIProjectSnapshot(app.context);

    // Delete then undo, through the real history: the restored wall
    // re-enters the store's map at the end, reversing the store's order.
    app.context.commandExecutor.execute({ type: "wall.delete", id: first.objectId as string });
    app.context.history.undo();

    const storeOrder = app.context.wallStore.getAll().map((wall) => wall.id);
    assertEqual(storeOrder[storeOrder.length - 1], first.objectId as string, "precondition: the store order really changed");

    const after = buildAIProjectSnapshot(app.context);
    assertSameJson(after.objects, before.objects, "objects are identical despite the reordering");
    assertSameJson(after.assemblies, before.assemblies, "assemblies are identical");
  });

  await check("an empty project still produces a valid, empty context", async () => {
    const app = wireApp(alwaysReply([]));

    await app.controller.submit("What is here?");

    // Reaching the mock at all proves the request passed the shared
    // parser, which requires `objects` and `assemblies` arrays.
    assertEqual(app.backend.requests.length, 1, "the request was accepted");
    const context = app.backend.requests[0].projectContext;
    assertSameJson(context.objects, [], "no objects");
    assertSameJson(context.assemblies, [], "no assemblies");
    assertEqual(context.wallCount, 0, "counts still present");
    assertPlainJson(context, "context");
  });

  await check("a provider can inspect the context - MockAIProvider sees an existing object through the whole path", async () => {
    const provider = new MockAIProvider();
    const app = wireApp((request) => {
      const response = provider.interpret({
        instruction: request.instruction,
        projectContext: request.projectContext,
        availableObjectTypes: AI_SUPPORTED_OBJECT_TYPES
      });
      return response.notes === undefined
        ? { kind: "ok", commands: response.commands }
        : { kind: "ok", commands: response.commands, notes: response.notes };
    });

    const door = app.context.commandExecutor.execute({ type: "door.add", door: {} });

    // "pillar" is matched before "door" in MockAIProvider's keyword order,
    // so naming the door by id doesn't change which command is produced.
    await app.controller.submit(`Add a pillar beside ${door.objectId}`);

    assertEqual(app.controller.getState().status, "success", "controller status");
    assertIncludes(
      app.controller.getState().notes,
      `Referenced existing objects: ${door.objectId} (door).`,
      "the provider found the door in the context it received"
    );
    assertEqual(app.context.pillarStore.getAll().length, 1, "the pillar was still built");
  });

  // --- update_object through the whole path ---

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

  /**
   * Wires the app with MockAIProvider answering behind the mock backend.
   * Each snapshot it receives is frozen first, so if anything in the
   * provider tried to modify the AI snapshot, the submission would fail.
   */
  function wireMockProviderApp(): WiredApp {
    const provider = new MockAIProvider();
    return wireApp((request) => {
      const response = provider.interpret({
        instruction: request.instruction,
        projectContext: deepFreeze(request.projectContext),
        availableObjectTypes: AI_SUPPORTED_OBJECT_TYPES
      });
      return response.notes === undefined
        ? { kind: "ok", commands: response.commands }
        : { kind: "ok", commands: response.commands, notes: response.notes };
    });
  }

  await check("AI updates an existing wall's length via MockAIProvider - same id, one wall, exact undo and redo", async () => {
    const app = wireMockProviderApp();
    const wallId = app.context.commandExecutor.execute({ type: "wall.add", wall: {} }).objectId as string;
    const original = app.context.wallStore.get(wallId);
    assertTrue(original, "precondition: the wall exists");

    await app.controller.submit(`Make ${wallId} 6 meters long.`);

    assertEqual(app.controller.getState().status, "success", "controller status");
    const walls = app.context.wallStore.getAll();
    assertEqual(walls.length, 1, "still exactly one wall");
    assertEqual(walls[0].id, wallId, "the same wall id");
    assertEqual(walls[0].dimensions.length, 6, "the length changed");
    assertEqual(walls[0].dimensions.height, original.dimensions.height, "height untouched");
    assertEqual(walls[0].dimensions.thickness, original.dimensions.thickness, "thickness untouched");
    const updated = walls[0];

    app.context.history.undo();
    assertSameJson(app.context.wallStore.get(wallId), original, "undo restores the exact original wall");
    assertEqual(app.context.wallStore.getAll().length, 1, "undo doesn't remove the wall");

    app.context.history.redo();
    assertSameJson(app.context.wallStore.get(wallId), updated, "redo restores the exact updated wall");
    assertEqual(app.context.wallStore.getAll().length, 1, "redo doesn't duplicate the wall");
  });

  await check("each explicit edit MockAIProvider understands reaches the real store: height, rotation, position", async () => {
    const app = wireMockProviderApp();
    const wallId = app.context.commandExecutor.execute({ type: "wall.add", wall: {} }).objectId as string;

    await app.controller.submit(`Change ${wallId} height to 3.2 meters.`);
    assertEqual(app.context.wallStore.get(wallId)?.dimensions.height, 3.2, "height");
    assertEqual(app.context.wallStore.get(wallId)?.position.y, 1.6, "the store's own rule re-grounded the wall");

    await app.controller.submit(`Rotate ${wallId} by 90 degrees.`);
    assertEqual(app.context.wallStore.get(wallId)?.rotation, Math.PI / 2, "rotation, relative to the fresh snapshot");

    await app.controller.submit(`Move ${wallId} to X=2.`);
    assertSameJson(app.context.wallStore.get(wallId)?.position, { x: 2, y: 1.6, z: 0 }, "only x moved");

    assertEqual(app.context.wallStore.getAll().length, 1, "still one wall after three edits");
  });

  await check("an AI update of material, color, position, and rotation goes through real validation and exact undo", async () => {
    // The "AI" picks the id out of the snapshot it receives, as a real model would.
    const app = wireApp((request) => ({
      kind: "ok",
      commands: [
        {
          type: "update_object",
          objectId: request.projectContext.objects[0].id,
          changes: { material: "concrete", color: "#224466", position: { z: 3 }, rotation: { y: 1.57 } }
        }
      ]
    }));
    const pillarId = app.context.commandExecutor.execute({ type: "pillar.add", pillar: {} }).objectId as string;
    const original = app.context.pillarStore.get(pillarId);
    assertTrue(original, "precondition");

    await app.controller.submit("Make the pillar concrete");

    const updated = app.context.pillarStore.get(pillarId);
    assertTrue(updated, "still stored");
    assertEqual(updated.material, "concrete", "material");
    assertEqual(updated.color, "#224466", "color");
    assertSameJson(updated.position, { x: original.position.x, y: original.position.y, z: 3 }, "only z moved");
    assertEqual(updated.rotation, 1.57, "rotation from { y }");

    app.context.history.undo();
    assertSameJson(app.context.pillarStore.get(pillarId), original, "one undo restores every property at once");
  });

  await check("assembly membership and selection are untouched by an AI update", async () => {
    const app = wireMockProviderApp();
    const wallId = app.context.commandExecutor.execute({ type: "wall.add", wall: {} }).objectId as string;
    const doorId = app.context.commandExecutor.execute({ type: "door.add", door: {} }).objectId as string;
    const assemblyId = app.context.commandExecutor.execute({ type: "assembly.create", assembly: { name: "Ground Floor" } })
      .objectId as string;
    app.context.commandExecutor.execute({ type: "assembly.addObject", assemblyId, objectId: wallId });
    app.context.selectionStore.select(doorId);

    await app.controller.submit(`Make ${wallId} 5 meters long.`);

    assertEqual(app.context.wallStore.get(wallId)?.dimensions.length, 5, "precondition: the update happened");
    assertSameJson(app.context.assemblyStore.get(assemblyId)?.objectIds, [wallId], "assembly still lists the wall");
    const snapshotWall = buildAIProjectSnapshot(app.context).objects.find((object) => object.id === wallId);
    assertSameJson(snapshotWall?.assemblyIds, [assemblyId], "membership still reported to the AI");
    assertEqual(app.context.selectionStore.get(), doorId, "the selected object is unchanged");
  });

  await check("an AI update naming an id that doesn't exist changes nothing and records no history", async () => {
    const app = wireApp(() => ({
      kind: "ok",
      commands: [{ type: "update_object", objectId: "wall-does-not-exist", changes: { dimensions: { length: 5 } } }]
    }));
    app.context.commandExecutor.execute({ type: "wall.add", wall: {} });
    const before = JSON.stringify(app.context.wallStore.getAll());

    await app.controller.submit("Make that wall 5 meters long");

    assertEqual(app.controller.getState().status, "error", "controller status");
    assertIncludes(app.controller.getState().message, "No construction object found", "clear message");
    assertEqual(JSON.stringify(app.context.wallStore.getAll()), before, "the wall is untouched");
    app.context.history.undo();
    assertEqual(app.context.wallStore.getAll().length, 0, "the latest history entry was still the add - no update entry");
  });

  await check("MockAIProvider won't turn an edit of an unknown id into a new object", async () => {
    const app = wireMockProviderApp();
    app.context.commandExecutor.execute({ type: "wall.add", wall: {} });

    await app.controller.submit("Make wall-999999 5 meters long.");

    assertEqual(app.context.wallStore.getAll().length, 1, "no wall was added");
    assertEqual(app.controller.getState().status, "error", "controller status");
    assertIncludes(app.controller.getState().message, 'No existing object with id "wall-999999"', "the note explains why");
  });

  await check("an invalid AI update is rejected by the real store validation, leaving the wall and history untouched", async () => {
    const app = wireApp((request) => ({
      kind: "ok",
      commands: [{ type: "update_object", objectId: request.projectContext.objects[0].id, changes: { dimensions: { length: 0 } } }]
    }));
    const wallId = app.context.commandExecutor.execute({ type: "wall.add", wall: {} }).objectId as string;
    const original = app.context.wallStore.get(wallId);

    await app.controller.submit("Make the wall zero meters long");

    assertEqual(app.controller.getState().status, "error", "controller status");
    assertIncludes(app.controller.getState().message, "validation failed", "rejected by validateWall");
    assertSameJson(app.context.wallStore.get(wallId), original, "wall untouched");
    app.context.history.undo();
    assertEqual(app.context.wallStore.getAll().length, 0, "no update entry was recorded");
  });

  // --- Construction geometry analysis over the real model ---
  // Real ProjectContext -> real stores (via CommandExecutor) -> the real
  // snapshot builder -> analyzeConstructionGeometry(). Expected values are
  // worked out by hand from the dimensions and positions given here.

  function addThroughExecutor(context: ProjectContext, command: unknown): string {
    const result = context.commandExecutor.execute(command);
    assertTrue(result.success && typeof result.objectId === "string", `setup command failed: ${JSON.stringify(result)}`);
    return result.objectId as string;
  }

  function buildGeometryModel(): { context: ProjectContext; wallA: string; wallB: string; pillar: string; beam: string } {
    const context = createProjectContext();
    // Two 4 m walls along X, grounded (y = height/2) by the real store rule.
    const wallA = addThroughExecutor(context, { type: "wall.add", wall: { length: 4, height: 3, thickness: 0.2, position: { x: 0, z: 0 } } });
    const wallB = addThroughExecutor(context, { type: "wall.add", wall: { length: 4, height: 3, thickness: 0.2, position: { x: 6, z: 0 } } });
    // A pillar between the walls and 2 m in front of them.
    const pillar = addThroughExecutor(context, {
      type: "pillar.add",
      pillar: { width: 0.4, depth: 0.4, height: 3, position: { x: 3, z: 2 } }
    });
    // A beam resting on top of the walls' height, turned 90 degrees so its 4 m length runs along Z.
    const beam = addThroughExecutor(context, {
      type: "beam.add",
      beam: { length: 4, width: 0.3, height: 0.4, rotation: Math.PI / 2, position: { x: 3, y: 3.2, z: 0 } }
    });
    return { context, wallA, wallB, pillar, beam };
  }

  await check("geometry analysis of a real ProjectContext snapshot gives the expected boxes and relationships", () => {
    const { context, wallA, wallB, pillar, beam } = buildGeometryModel();
    const snapshot = buildAIProjectSnapshot(context);
    const snapshotJson = JSON.stringify(snapshot);

    const analysis = analyzeConstructionGeometry(snapshot);

    assertEqual(JSON.stringify(snapshot), snapshotJson, "the snapshot is unchanged by the analysis");
    assertEqual(analysis.invalidObjects.length, 0, "objects from the real stores are all valid");
    assertSameJson(
      analysis.objects.map((object) => object.id),
      snapshot.objects.map((object) => object.id),
      "objects come out in the snapshot's id order"
    );
    assertEqual(analysis.relationships.length, 6, "one relationship per pair of four objects");

    const geometryOf = (id: string) => {
      const found = analysis.objects.find((object) => object.id === id);
      assertTrue(found, `no geometry for ${id}`);
      return found;
    };
    assertSameJson(geometryOf(wallA).aabb, { min: { x: -2, y: 0, z: -0.1 }, max: { x: 2, y: 3, z: 0.1 } }, "wall A box");
    assertSameJson(geometryOf(wallB).aabb, { min: { x: 4, y: 0, z: -0.1 }, max: { x: 8, y: 3, z: 0.1 } }, "wall B box");
    assertSameJson(geometryOf(pillar).aabb, { min: { x: 2.8, y: 0, z: 1.8 }, max: { x: 3.2, y: 3, z: 2.2 } }, "pillar box");
    // Rotated: the beam's length is on Z and its width on X. Unrotated it
    // would span x 1..5 and overlap both walls on X.
    assertSameJson(geometryOf(beam).aabb, { min: { x: 2.85, y: 3, z: -2 }, max: { x: 3.15, y: 3.4, z: 2 } }, "rotated beam box");
    assertSameJson(geometryOf(beam).size, { x: 0.3, y: 0.4, z: 4 }, "rotated beam size");

    const walls = relationBetween(analysis, wallA, wallB);
    assertSameJson(walls.firstRelativeToSecond, { leftOf: true, rightOf: false, inFrontOf: false, behind: false, above: false, below: false }, "wall A relative to wall B");
    assertSameJson(walls.pair.overlap, { x: false, y: true, z: true, aabb: false }, "wall A / wall B overlap");
    assertSameJson(walls.pair.gap, { x: 2, y: 0, z: 0 }, "2 m of clear space between the walls");
    assertEqual(walls.pair.centerDistance, 6, "wall centers are 6 m apart");
    assertEqual(walls.pair.horizontalDistance, 6, "all of it horizontal");
    assertEqual(walls.pair.verticalDistance, 0, "same height");

    const pillarToWallA = relationBetween(analysis, pillar, wallA);
    assertSameJson(pillarToWallA.firstRelativeToSecond, { leftOf: false, rightOf: true, inFrontOf: true, behind: false, above: false, below: false }, "pillar relative to wall A");
    assertSameJson(pillarToWallA.pair.gap, { x: 0.8, y: 0, z: 1.7 }, "pillar / wall A gap");
    assertEqual(pillarToWallA.pair.horizontalDistance, 3.605551275, "sqrt(3^2 + 2^2), rounded to 9 places");

    const pillarToWallB = relationBetween(analysis, pillar, wallB);
    assertSameJson(pillarToWallB.firstRelativeToSecond, { leftOf: true, rightOf: false, inFrontOf: true, behind: false, above: false, below: false }, "pillar relative to wall B");

    const beamToWallA = relationBetween(analysis, beam, wallA);
    assertSameJson(beamToWallA.firstRelativeToSecond, { leftOf: false, rightOf: true, inFrontOf: false, behind: false, above: true, below: false }, "beam relative to wall A");
    assertSameJson(beamToWallA.pair.overlap, { x: false, y: false, z: true, aabb: false }, "beam sits on wall A's height (touching, not overlapping)");
    assertEqual(beamToWallA.pair.verticalDistance, 1.7, "beam center 3.2 vs wall center 1.5");

    const beamToWallB = relationBetween(analysis, beam, wallB);
    assertSameJson(beamToWallB.firstRelativeToSecond, { leftOf: true, rightOf: false, inFrontOf: false, behind: false, above: true, below: false }, "beam relative to wall B");

    const beamToPillar = relationBetween(analysis, beam, pillar);
    assertSameJson(beamToPillar.firstRelativeToSecond, { leftOf: false, rightOf: false, inFrontOf: false, behind: false, above: true, below: false }, "beam directly above the pillar - no false horizontal relation");
    assertSameJson(beamToPillar.pair.overlap, { x: true, y: false, z: true, aabb: false }, "beam / pillar overlap on X and Z only");
  });

  await check("re-analysing after a real update_object rotation reflects the object's new box", () => {
    const { context, wallA, beam } = buildGeometryModel();
    const before = analyzeConstructionGeometry(buildAIProjectSnapshot(context));

    const result = context.commandExecutor.execute({ type: "update_object", objectId: beam, changes: { rotation: 0 } });
    assertTrue(result.success, `update_object failed: ${JSON.stringify(result)}`);
    const after = analyzeConstructionGeometry(buildAIProjectSnapshot(context));

    assertSameJson(
      after.objects.find((object) => object.id === beam)?.aabb,
      { min: { x: 1, y: 3, z: -0.15 }, max: { x: 5, y: 3.4, z: 0.15 } },
      "unrotated beam spans x 1..5"
    );
    assertEqual(relationBetween(before, beam, wallA).pair.overlap.x, false, "rotated: no X overlap with wall A");
    assertEqual(relationBetween(after, beam, wallA).pair.overlap.x, true, "unrotated: overlaps wall A on X");
    assertEqual(relationBetween(after, beam, wallA).firstRelativeToSecond.rightOf, false, "no longer entirely right of wall A");

    context.history.undo();
    assertSameJson(analyzeConstructionGeometry(buildAIProjectSnapshot(context)), before, "undo restores the original analysis exactly");
  });

  // --- Geometry in the AI context, through the whole real path ---
  // Real ProjectContext -> stores -> snapshot -> AICommandPipeline (derives
  // geometry) -> BackendAIProvider -> mock backend (re-derives geometry
  // from the sanitized snapshot, as the real server does) -> MockAIProvider.

  /**
   * Walls have no depth, so MockAIProvider produces no command for this
   * and the model is left untouched - its notes show what it saw. It
   * names both walls, so the notes include their geometry relationship.
   */
  const inspectBothWalls = (first: string, second: string): string => `Make ${first} 5 meters deep and make ${second} 5 meters deep`;

  await check("MockAIProvider sees two real walls' exact geometry relationship through the whole real path", async () => {
    const app = wireMockProviderApp();
    const wallA = addThroughExecutor(app.context, { type: "wall.add", wall: { length: 4, height: 3, thickness: 0.2, position: { x: 0, z: 0 } } });
    const wallB = addThroughExecutor(app.context, { type: "wall.add", wall: { length: 4, height: 3, thickness: 0.2, position: { x: 6, z: 0 } } });
    const modelBefore = JSON.stringify(buildAIProjectSnapshot(app.context));

    await app.controller.submit(inspectBothWalls(wallA, wallB));

    assertEqual(app.backend.requests.length, 1, "one request");
    const request = app.backend.requests[0];
    const { pair, firstRelativeToSecond } = relationBetween(request.projectContext.geometry, wallA, wallB);
    assertEqual(pair.a, wallA, "pairs are ordered by id");
    assertEqual(pair.centerDistance, 6, "6 m between centers");
    assertEqual(pair.horizontalDistance, 6, "all of it horizontal");
    assertEqual(pair.verticalDistance, 0, "same height");
    assertSameJson(pair.gap, { x: 2, y: 0, z: 0 }, "2 m clear between the walls");
    assertSameJson(pair.overlap, { x: false, y: true, z: true, aabb: false }, "overlap flags");
    assertSameJson(
      firstRelativeToSecond,
      { leftOf: true, rightOf: false, inFrontOf: false, behind: false, above: false, below: false },
      "wall A entirely left of wall B"
    );

    assertIncludes(
      app.controller.getState().notes ?? null,
      `Geometry relationship: ${JSON.stringify(pair)}.`,
      "the provider reported the exact relationship it received"
    );
    assertSameJson(
      request.projectContext.geometry,
      analyzeConstructionGeometry(buildAIProjectSnapshot(app.context)),
      "the geometry of the real model"
    );
    assertSameJson(
      request.clientGeometry,
      request.projectContext.geometry,
      "the browser sent geometry too - and the server's own derivation from the sanitized snapshot matches it exactly"
    );
    assertPlainJson(request.projectContext, "context");
    assertEqual(JSON.stringify(buildAIProjectSnapshot(app.context)), modelBefore, "the model is unchanged - no command was produced");
  });

  await check("moving and rotating real walls changes the geometry the provider receives", async () => {
    const app = wireMockProviderApp();
    const wallA = addThroughExecutor(app.context, { type: "wall.add", wall: { length: 4, height: 3, thickness: 0.2, position: { x: 0, z: 0 } } });
    const wallB = addThroughExecutor(app.context, { type: "wall.add", wall: { length: 4, height: 3, thickness: 0.2, position: { x: 6, z: 0 } } });

    await app.controller.submit(inspectBothWalls(wallA, wallB));
    assertEqual(relationBetween(app.backend.requests[0].projectContext.geometry, wallA, wallB).pair.centerDistance, 6, "before: 6 m apart");

    const moved = app.context.commandExecutor.execute({ type: "update_object", objectId: wallB, changes: { position: { x: 10 } } });
    assertTrue(moved.success, "moved wall B through the real executor");
    await app.controller.submit(inspectBothWalls(wallA, wallB));
    const afterMove = relationBetween(app.backend.requests[1].projectContext.geometry, wallA, wallB).pair;
    assertEqual(afterMove.centerDistance, 10, "after the move: 10 m apart");
    assertSameJson(afterMove.gap, { x: 6, y: 0, z: 0 }, "6 m clear between x 2 and x 8");

    const rotated = app.context.commandExecutor.execute({ type: "update_object", objectId: wallA, changes: { rotation: Math.PI / 2 } });
    assertTrue(rotated.success, "rotated wall A through the real executor");
    await app.controller.submit(inspectBothWalls(wallA, wallB));
    const rotatedGeometry = app.backend.requests[2].projectContext.geometry;
    assertSameJson(
      rotatedGeometry.objects.find((object) => object.id === wallA)?.aabb,
      { min: { x: -0.1, y: 0, z: -2 }, max: { x: 0.1, y: 3, z: 2 } },
      "wall A now runs along Z"
    );
    const afterRotation = relationBetween(rotatedGeometry, wallA, wallB).pair;
    assertSameJson(afterRotation.gap, { x: 7.9, y: 0, z: 0 }, "clear space now measured from wall A's new X extent");
    assertIncludes(
      app.controller.getState().notes ?? null,
      `Geometry relationship: ${JSON.stringify(afterRotation)}.`,
      "the provider saw the rotated geometry"
    );
  });

  // --- Mouse manipulation through the real engine ---
  // Real ProjectContext (real stores, real *HistoryController classes, the
  // real shared HistoryManager) -> ObjectManipulator -> update_object via
  // the real CommandExecutor. Points are what the scene's controller would
  // hand over after projecting the pointer onto the drag plane.

  function manipulatorFor(context: ProjectContext): ObjectManipulator {
    return new ObjectManipulator({
      commandExecutor: context.commandExecutor,
      history: context.history,
      readObject: createStoreObjectReader(context)
    });
  }

  function dragThrough(manipulator: ObjectManipulator, points: { x: number; y: number; z: number }[]): void {
    for (const point of points) {
      manipulator.update(point);
    }
    manipulator.end();
  }

  await check("mouse move of a real wall: position changes, one undo returns it, one redo moves it back", async () => {
    const context = createProjectContext();
    const manipulator = manipulatorFor(context);
    const wallId = addThroughExecutor(context, { type: "wall.add", wall: { length: 4, position: { x: 0, z: 0 } } });
    context.selectionStore.select(wallId);
    context.history.clearHistory();

    assertTrue(manipulator.begin(wallId, { kind: "move" }, { x: 0, y: 1.35, z: 0 }), "gesture started");
    dragThrough(manipulator, [0.6, 1.3, 2.2, 3.1, 4.0].map((x) => ({ x, y: 1.35, z: 0.02 })));

    assertSameJson(context.wallStore.get(wallId)?.position, { x: 4, y: 1.35, z: 0 }, "moved to x = 4, y untouched");
    context.history.undo();
    assertSameJson(context.wallStore.get(wallId)?.position, { x: 0, y: 1.35, z: 0 }, "undo: straight back to the original position");
    assertEqual(context.history.canUndo(), false, "the whole drag was a single entry");
    context.history.redo();
    assertSameJson(context.wallStore.get(wallId)?.position, { x: 4, y: 1.35, z: 0 }, "redo: straight to the moved position");
    assertEqual(context.wallStore.getAll().length, 1, "still one wall");
    assertEqual(context.wallStore.getAll()[0].id, wallId, "same id");
    assertEqual(context.selectionStore.get(), wallId, "still selected");
  });

  await check("mouse resize of a real wall from 4 m to 6 m by its end handle: undo gives 4, redo gives 6", async () => {
    const context = createProjectContext();
    const manipulator = manipulatorFor(context);
    const wallId = addThroughExecutor(context, { type: "wall.add", wall: { length: 4, position: { x: 0, z: 0 } } });
    context.history.clearHistory();

    // The +X handle sits 0.35 m outside the end face at x = 2, on the base plane; drag it 2 m further.
    assertTrue(manipulator.begin(wallId, { kind: "resize", axis: "x", side: 1 }, { x: 2.35, y: 0.15, z: 0 }), "gesture started");
    dragThrough(manipulator, [2.9, 3.5, 4.0, 4.35].map((x) => ({ x, y: 0.15, z: 0 })));

    const resized = context.wallStore.get(wallId);
    assertEqual(resized?.dimensions.length, 6, "length is 6 m in the store");
    assertEqual(resized?.position.x, 1, "the far end stayed at x = -2");
    context.history.undo();
    assertEqual(context.wallStore.get(wallId)?.dimensions.length, 4, "undo: 4 m");
    assertEqual(context.wallStore.get(wallId)?.position.x, 0, "undo: original center");
    assertEqual(context.history.canUndo(), false, "one entry for the whole resize");
    context.history.redo();
    assertEqual(context.wallStore.get(wallId)?.dimensions.length, 6, "redo: 6 m");
    assertEqual(context.wallStore.getAll().length, 1, "still one wall");
    assertEqual(context.wallStore.getAll()[0].id, wallId, "same id");
  });

  await check("mouse rotation of a real wall: rotation changes, undo restores the original, redo re-applies", async () => {
    const context = createProjectContext();
    const manipulator = manipulatorFor(context);
    const wallId = addThroughExecutor(context, { type: "wall.add", wall: { position: { x: 0, z: 0 } } });
    context.history.clearHistory();

    // Grab the ring on +X and sweep a quarter turn to -Z.
    assertTrue(manipulator.begin(wallId, { kind: "rotate" }, { x: 3, y: 0, z: 0 }), "gesture started");
    dragThrough(manipulator, [
      { x: 2.6, y: 0, z: -1.5 },
      { x: 1.5, y: 0, z: -2.6 },
      { x: 0, y: 0, z: -3 }
    ]);

    const rotated = context.wallStore.get(wallId)?.rotation ?? 0;
    assertTrue(Math.abs(rotated - Math.PI / 2) < 1e-6, `rotated a quarter turn, got ${rotated}`);
    context.history.undo();
    assertEqual(context.wallStore.get(wallId)?.rotation, 0, "undo: original rotation");
    assertEqual(context.history.canUndo(), false, "one entry for the whole rotation");
    context.history.redo();
    assertTrue(Math.abs((context.wallStore.get(wallId)?.rotation ?? 0) - Math.PI / 2) < 1e-6, "redo: rotated again");
    assertEqual(context.wallStore.getAll().length, 1, "still one wall");
    assertEqual(context.wallStore.getAll()[0].id, wallId, "same id");
  });

  await check("mouse manipulation keeps assembly membership, id, and selection, and never adds an object", async () => {
    const context = createProjectContext();
    const manipulator = manipulatorFor(context);
    const wallId = addThroughExecutor(context, { type: "wall.add", wall: {} });
    const assemblyId = addThroughExecutor(context, { type: "assembly.create", assembly: { name: "Ground Floor" } });
    assertTrue(context.commandExecutor.execute({ type: "assembly.addObject", assemblyId, objectId: wallId }).success, "precondition");
    context.selectionStore.select(wallId);
    const snapshotBefore = buildAIProjectSnapshot(context);

    manipulator.begin(wallId, { kind: "move" }, { x: 0, y: 1.35, z: 0 });
    dragThrough(manipulator, [{ x: 1.5, y: 1.35, z: 2 }]);
    manipulator.begin(wallId, { kind: "resize", axis: "z", side: 1 }, { x: 1.5, y: 1.35, z: 2.35 });
    dragThrough(manipulator, [{ x: 1.5, y: 1.35, z: 2.55 }]);
    manipulator.begin(wallId, { kind: "rotate" }, { x: 4.5, y: 0, z: 2 });
    dragThrough(manipulator, [{ x: 1.5, y: 0, z: -1 }]);

    const after = buildAIProjectSnapshot(context);
    assertSameJson(context.assemblyStore.get(assemblyId)?.objectIds, [wallId], "still exactly this wall");
    assertSameJson(after.objects.map((object) => [object.id, object.type, object.assemblyIds]), snapshotBefore.objects.map((object) => [object.id, object.type, object.assemblyIds]), "same objects, ids, types, memberships");
    assertEqual(after.wallCount, 1, "no wall added");
    assertEqual(context.selectionStore.get(), wallId, "still selected");
  });

  await check("all six object types move and resize through the real engine, each gesture one undo entry", async () => {
    const context = createProjectContext();
    const manipulator = manipulatorFor(context);
    const readObject = createStoreObjectReader(context);

    for (const type of ["wall", "pillar", "beam", "slab", "door", "window"]) {
      const id = addThroughExecutor(context, { type: `${type}.add`, [type]: {} });
      context.history.clearHistory();
      const before = readObject(id);
      assertTrue(before, `${type} exists`);

      manipulator.begin(id, { kind: "move" }, { x: 0, y: 1, z: 0 });
      dragThrough(manipulator, [{ x: 0.5, y: 1, z: 0 }, { x: 1, y: 1, z: 0.5 }]);
      manipulator.begin(id, { kind: "resize", axis: "x", side: -1 }, { x: 0, y: 1, z: 0 });
      dragThrough(manipulator, [{ x: -0.4, y: 1, z: 0 }]);

      const after = readObject(id);
      assertTrue(after, `${type} still exists`);
      assertEqual(after.position.z, before.position.z + 0.5, `${type}: moved 0.5 m in Z`);
      const xKey = Object.keys(before.dimensions).find((key) => after.dimensions[key] !== before.dimensions[key]);
      assertTrue(xKey, `${type}: a dimension changed`);
      assertTrue(Math.abs(after.dimensions[xKey] - before.dimensions[xKey] - 0.4) < 1e-9, `${type}.${xKey} grew by 0.4 m`);

      context.history.undo();
      context.history.undo();
      assertSameJson(readObject(id), before, `${type}: two undos (one per gesture) restore it exactly`);
      assertEqual(context.history.canUndo(), false, `${type}: exactly two entries`);
    }
  });

  // --- Manual home-building workflow (the house MVP) ---
  // Everything below goes through the same entry points the UI uses: the
  // ribbon's <type>.add commands, the Properties panel's per-type updates,
  // the Delete/Duplicate buttons' commands, ObjectManipulator for mouse
  // gestures, the assembly panel's assembly.* commands, and the shared
  // HistoryManager for Undo/Redo.

  /** 10 m x 8 m footprint centered on the origin: long walls on Z = +/-4, short walls (turned 90 degrees) on X = +/-5. */
  function buildHouse(context: ProjectContext) {
    const add = (command: Record<string, unknown>) => addThroughExecutor(context, command);
    const walls = [
      add({ type: "wall.add", wall: { length: 10, height: 3, thickness: 0.2, position: { x: 0, z: -4 } } }),
      add({ type: "wall.add", wall: { length: 10, height: 3, thickness: 0.2, position: { x: 0, z: 4 } } }),
      add({ type: "wall.add", wall: { length: 8, height: 3, thickness: 0.2, rotation: Math.PI / 2, position: { x: -5, z: 0 } } }),
      add({ type: "wall.add", wall: { length: 8, height: 3, thickness: 0.2, rotation: Math.PI / 2, position: { x: 5, z: 0 } } })
    ];
    const slab = add({ type: "slab.add", slab: { length: 10, width: 8, thickness: 0.2, position: { x: 0, z: 0 } } });
    const pillars = [
      [-5, -4],
      [5, -4],
      [-5, 4],
      [5, 4]
    ].map(([x, z]) => add({ type: "pillar.add", pillar: { width: 0.4, depth: 0.4, height: 3, position: { x, z } } }));
    const door = add({ type: "door.add", door: { position: { x: 0, z: -4 } } });
    const windows = [
      add({ type: "window.add", window: { position: { x: -2.5, y: 1.5, z: 4 } } }),
      add({ type: "window.add", window: { rotation: Math.PI / 2, position: { x: 5, y: 1.5, z: 0 } } })
    ];
    return { walls, slab, pillars, door, windows, all: [...walls, slab, ...pillars, door, ...windows] };
  }

  const objectsJson = (context: ProjectContext) => JSON.stringify(buildAIProjectSnapshot(context).objects);

  await check("house MVP: 4 walls, a slab, 4 pillars, a door and 2 windows form one coherent, valid model", async () => {
    const context = createProjectContext();
    const house = buildHouse(context);
    const stores = context;

    assertEqual(context.wallStore.getAll().length, 4, "walls");
    assertEqual(context.slabStore.getAll().length, 1, "slab");
    assertEqual(context.pillarStore.getAll().length, 4, "pillars");
    assertEqual(context.doorStore.getAll().length, 1, "door");
    assertEqual(context.windowStore.getAll().length, 2, "windows");
    assertEqual(context.beamStore.getAll().length, 0, "no beams");
    assertEqual(new Set(house.all).size, 12, "12 distinct ids");

    const expectedTypes = ["wall", "wall", "wall", "wall", "slab", "pillar", "pillar", "pillar", "pillar", "door", "window", "window"];
    house.all.forEach((id, index) => {
      assertTrue(new RegExp(`^${expectedTypes[index]}-\\d+$`).test(id), `stable, typed id: ${id}`);
      assertEqual(resolveConstructionObject(id, stores)?.type, expectedTypes[index], `${id} lives in the ${expectedTypes[index]} store`);
      context.selectionStore.select(id);
      assertEqual(context.selectionStore.get(), id, `${id} is selectable`);
    });

    const snapshot = buildAIProjectSnapshot(context);
    const parsed = parseAIProjectSnapshot(JSON.parse(JSON.stringify(snapshot)));
    assertTrue(parsed.ok, "the model snapshot passes the shared validator");
    assertEqual(snapshot.objects.length, 12, "12 objects in the snapshot");
    for (const object of snapshot.objects) {
      assertTrue(Object.values(object.dimensions).every((value) => Number.isFinite(value) && value > 0), `${object.id} has valid dimensions`);
    }

    const geometry = analyzeConstructionGeometry(snapshot);
    assertEqual(geometry.invalidObjects.length, 0, "no invalid objects");
    assertEqual(geometry.objects.length, 12, "every object has a box");
    assertEqual(geometry.relationships.length, 66, "12 * 11 / 2 pairs");
    assertSameJson(
      geometry.objects.find((object) => object.id === house.slab)?.aabb,
      { min: { x: -5, y: 0, z: -4 }, max: { x: 5, y: 0.2, z: 4 } },
      "the slab covers the 10 x 8 footprint"
    );
    assertSameJson(
      geometry.objects.find((object) => object.id === house.walls[2])?.size,
      { x: 0.2, y: 3, z: 8 },
      "the turned short wall runs 8 m along Z"
    );
  });

  await check("house MVP: move/resize/rotate walls, move the door, resize a window - all survive, and undo/redo walks them exactly", async () => {
    const context = createProjectContext();
    const house = buildHouse(context);
    const manipulator = manipulatorFor(context);
    context.history.clearHistory();
    const built = objectsJson(context);

    manipulator.begin(house.walls[1], { kind: "move" }, { x: 0, y: 1.5, z: 4 });
    dragThrough(manipulator, [{ x: 0, y: 1.5, z: 4.3 }, { x: 0, y: 1.5, z: 4.5 }]);
    manipulator.begin(house.walls[0], { kind: "resize", axis: "x", side: 1 }, { x: 5.35, y: 0.15, z: -4 });
    dragThrough(manipulator, [{ x: 6.35, y: 0.15, z: -4 }]);
    manipulator.begin(house.walls[2], { kind: "rotate" }, { x: -2, y: 0, z: 0 });
    dragThrough(manipulator, [{ x: -5, y: 0, z: -3 }]);
    manipulator.begin(house.door, { kind: "move" }, { x: 0, y: 1.05, z: -4 });
    dragThrough(manipulator, [{ x: 1, y: 1.05, z: -4 }]);
    manipulator.begin(house.windows[0], { kind: "resize", axis: "x", side: 1 }, { x: -1.55, y: 1.05, z: 4 });
    dragThrough(manipulator, [{ x: -1.15, y: 1.05, z: 4 }]);

    assertEqual(context.wallStore.get(house.walls[1])?.position.z, 4.5, "back wall moved to z = 4.5");
    assertEqual(context.wallStore.get(house.walls[0])?.dimensions.length, 11, "front wall resized to 11 m");
    assertEqual(context.wallStore.get(house.walls[0])?.position.x, 0.5, "with its -X end fixed");
    assertTrue(Math.abs((context.wallStore.get(house.walls[2])?.rotation ?? 0) - Math.PI) < 1e-6, "side wall turned another 90 degrees");
    assertEqual(context.doorStore.get(house.door)?.position.x, 1, "door moved to x = 1");
    assertEqual(context.windowStore.get(house.windows[0])?.dimensions.width, 1.6, "window widened to 1.6 m");
    const manipulated = objectsJson(context);

    for (let step = 0; step < 5; step += 1) {
      context.history.undo();
    }
    assertEqual(objectsJson(context), built, "five undos - one per gesture - return the house exactly as built");
    assertEqual(context.history.canUndo(), false, "and that was the whole history");
    for (let step = 0; step < 5; step += 1) {
      context.history.redo();
    }
    assertEqual(objectsJson(context), manipulated, "five redos restore every change");
    assertEqual(buildAIProjectSnapshot(context).objects.length, 12, "still 12 objects");
    assertSameJson(buildAIProjectSnapshot(context).objects.map((object) => object.id).sort(), [...house.all].sort(), "same ids");
  });

  await check("mixed workflow: add wall, move, resize, rotate, add door, move door, delete window - undo reverses in order, redo replays", async () => {
    const context = createProjectContext();
    const manipulator = manipulatorFor(context);
    const windowId = addThroughExecutor(context, { type: "window.add", window: { position: { x: 8, z: 0 } } });
    context.history.clearHistory();
    const states = [objectsJson(context)];

    const wallId = addThroughExecutor(context, { type: "wall.add", wall: { position: { x: 0, z: 0 } } });
    states.push(objectsJson(context));
    manipulator.begin(wallId, { kind: "move" }, { x: 0, y: 1.35, z: 0 });
    dragThrough(manipulator, [{ x: 1, y: 1.35, z: 1 }]);
    states.push(objectsJson(context));
    manipulator.begin(wallId, { kind: "resize", axis: "x", side: 1 }, { x: 3.35, y: 0.15, z: 1 });
    dragThrough(manipulator, [{ x: 4.35, y: 0.15, z: 1 }]);
    states.push(objectsJson(context));
    manipulator.begin(wallId, { kind: "rotate" }, { x: 4.5, y: 0, z: 1 });
    dragThrough(manipulator, [{ x: 1.5, y: 0, z: -2 }]);
    states.push(objectsJson(context));
    const doorId = addThroughExecutor(context, { type: "door.add", door: { position: { x: -3, z: 0 } } });
    states.push(objectsJson(context));
    manipulator.begin(doorId, { kind: "move" }, { x: -3, y: 1.05, z: 0 });
    dragThrough(manipulator, [{ x: -3, y: 1.05, z: 2 }]);
    states.push(objectsJson(context));
    assertTrue(context.commandExecutor.execute({ type: "window.delete", id: windowId }).success, "window deleted");
    states.push(objectsJson(context));
    assertEqual(new Set(states).size, states.length, "precondition: every step changed the model");

    for (let step = states.length - 2; step >= 0; step -= 1) {
      context.history.undo();
      assertEqual(objectsJson(context), states[step], `undo back to state ${step}`);
    }
    assertEqual(context.history.canUndo(), false, "exactly seven entries - one per action");
    for (let step = 1; step < states.length; step += 1) {
      context.history.redo();
      assertEqual(objectsJson(context), states[step], `redo forward to state ${step}`);
    }
  });

  await check("all six types: add, select, delete, undo restores the same object, redo removes it again", async () => {
    const context = createProjectContext();
    for (const type of ["wall", "pillar", "beam", "slab", "door", "window"]) {
      const id = addThroughExecutor(context, { type: `${type}.add`, [type]: {} });
      assertEqual(resolveConstructionObject(id, context)?.type, type, `${type} added to its store`);
      context.selectionStore.select(id);
      const before = objectsJson(context);

      assertTrue(context.commandExecutor.execute({ type: `${type}.delete`, id }).success, `${type} deleted`);
      assertEqual(resolveConstructionObject(id, context), undefined, `${type} gone from its store`);
      assertEqual(context.selectionStore.get(), null, `${type}: selection cleared`);

      context.history.undo();
      assertEqual(objectsJson(context), before, `${type}: undo restores it exactly, same id`);
      assertEqual(context.selectionStore.get(), id, `${type}: and selects it again`);

      context.history.redo();
      assertEqual(resolveConstructionObject(id, context), undefined, `${type}: redo deletes it again`);
      context.history.undo();
    }
    assertEqual(buildAIProjectSnapshot(context).objects.length, 6, "one of each type remains");
  });

  await check("duplicate makes an independent object: new id, its own transform, its own history", async () => {
    const context = createProjectContext();
    const manipulator = manipulatorFor(context);
    const original = addThroughExecutor(context, { type: "wall.add", wall: { length: 5, position: { x: 0, z: 0 } } });
    context.history.clearHistory();
    const originalBefore = JSON.stringify(context.wallStore.get(original));

    const copy = context.commandExecutor.execute({ type: "wall.duplicate", id: original }).objectId as string;
    assertTrue(copy && copy !== original, "a new id");
    assertEqual(context.wallStore.get(copy)?.dimensions.length, 5, "same dimensions");

    manipulator.begin(copy, { kind: "rotate" }, { x: 3.75, y: 0, z: 0.75 });
    dragThrough(manipulator, [{ x: 0.75, y: 0, z: -2.25 }]);
    manipulator.begin(copy, { kind: "move" }, { x: 0.75, y: 1.35, z: 0.75 });
    dragThrough(manipulator, [{ x: 0.75, y: 1.35, z: 3.75 }]);

    assertEqual(JSON.stringify(context.wallStore.get(original)), originalBefore, "the original never changed");
    assertTrue(Math.abs((context.wallStore.get(copy)?.rotation ?? 0) - Math.PI / 2) < 1e-6, "the copy rotated");
    assertEqual(context.wallStore.get(copy)?.position.z, 3.75, "and moved");

    context.history.undo();
    context.history.undo();
    assertEqual(context.wallStore.get(copy)?.position.z, 0.75, "undoing the copy's gestures touches only the copy");
    context.history.undo();
    assertEqual(context.wallStore.get(copy), undefined, "one more undo removes the duplicate");
    assertEqual(JSON.stringify(context.wallStore.get(original)), originalBefore, "the original is untouched throughout");
  });

  await check("assemblies for a house: create, rename, add members, remove one; a deleted member drops out and undo brings it back; deleting the assembly keeps its objects", async () => {
    const context = createProjectContext();
    const house = buildHouse(context);
    const liveMembers = (assemblyId: string) =>
      (context.assemblyStore.get(assemblyId)?.objectIds ?? []).filter((id) => resolveConstructionObject(id, context) !== undefined);

    const assemblyId = addThroughExecutor(context, { type: "assembly.create", assembly: { name: "Assembly 1" } });
    assertTrue(context.commandExecutor.execute({ type: "assembly.update", id: assemblyId, changes: { name: "Ground Floor" } }).success, "renamed");
    assertEqual(context.assemblyStore.get(assemblyId)?.name, "Ground Floor", "name");
    for (const id of [...house.walls, house.door]) {
      assertTrue(context.commandExecutor.execute({ type: "assembly.addObject", assemblyId, objectId: id }).success, `added ${id}`);
    }
    assertTrue(context.commandExecutor.execute({ type: "assembly.removeObject", assemblyId, objectId: house.door }).success, "door removed");
    assertSameJson(liveMembers(assemblyId), house.walls, "four walls");
    context.selectionStore.select(house.walls[2]);
    assertEqual(context.selectionStore.get(), house.walls[2], "a member can be selected");

    assertTrue(context.commandExecutor.execute({ type: "wall.delete", id: house.walls[0] }).success, "a member wall deleted");
    assertSameJson(liveMembers(assemblyId), house.walls.slice(1), "the deleted wall is no longer a (live) member");
    context.history.undo();
    assertSameJson(liveMembers(assemblyId), house.walls, "undo restores the wall - and with it its membership");

    assertTrue(context.commandExecutor.execute({ type: "assembly.delete", id: assemblyId }).success, "assembly deleted");
    assertEqual(context.assemblyStore.getAll().length, 0, "no assemblies left");
    assertEqual(buildAIProjectSnapshot(context).objects.length, 12, "all 12 objects still there");
  });

  await check("New Project empties objects, assemblies, selection and history; ids are never reused", async () => {
    const context = createProjectContext();
    const house = buildHouse(context);
    addThroughExecutor(context, { type: "assembly.create", assembly: { name: "Ground Floor" } });
    context.selectionStore.select(house.walls[0]);

    clearProject(context);

    assertEqual(buildAIProjectSnapshot(context).objects.length, 0, "no objects");
    assertEqual(context.assemblyStore.getAll().length, 0, "no assemblies");
    assertEqual(context.selectionStore.get(), null, "nothing selected");
    assertEqual(context.history.canUndo(), false, "nothing to undo");
    assertEqual(context.history.canRedo(), false, "nothing to redo");
    const next = addThroughExecutor(context, { type: "wall.add", wall: {} });
    assertTrue(!house.all.includes(next), `a fresh id (${next})`);
  });

  await check("default placement takes the first free slot, so adding after a delete never lands on a survivor", async () => {
    const slot = (index: number) => ({ x: 0, z: -4 + index * 2.5 });
    assertEqual(firstFreeSlot([], slot), 0, "empty: first slot");
    assertEqual(firstFreeSlot([slot(0), slot(2)], slot), 1, "the gap left by a delete");
    assertEqual(firstFreeSlot([slot(0), slot(1), slot(2)], slot), 3, "all taken: the next one");
    assertEqual(firstFreeSlot([{ x: 3, z: -4 }], slot), 0, "an object moved away frees its slot");
    assertEqual(firstFreeSlot([{ x: 0.3, z: -4.2 }], slot), 1, "one still sitting near its slot keeps it");
  });

  // --- Secrets and harness discipline ---

  await check("no OpenAI key, secret, or environment secret read exists anywhere under src/", () => {
    const files = collectSourceFiles(SRC_ROOT);
    assertTrue(files.length > 30, "the scan should have found the source tree");

    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      // A real OpenAI key literal. The short fake placeholders used in
      // the provider unit fixtures are deliberately allowed through by
      // the length requirement - they are not secrets.
      if (/sk-[A-Za-z0-9_-]{20,}/.test(source)) {
        offenders.push(`${file}: key-shaped literal`);
      }
      // Any attempt to read a secret from the environment, by either the
      // Node or the Vite mechanism.
      if (/process\.env\.[A-Za-z_]*(OPENAI|SECRET|TOKEN|KEY)/i.test(source)) {
        offenders.push(`${file}: process.env secret read`);
      }
      if (/import\.meta\.env\.[A-Za-z_]*(OPENAI|SECRET|TOKEN|KEY)/i.test(source)) {
        offenders.push(`${file}: import.meta.env secret read`);
      }
    }

    assertEqual(offenders.join(" | "), "", "no source file under src/ may contain or read a secret");
  });

  await check("the shipped application never constructs the OpenAI provider client-side", () => {
    const mainSource = readFileSync(`${SRC_ROOT}/main.ts`, "utf8");
    assertTrue(!mainSource.includes("OpenAIProvider"), "main.ts must not reference OpenAIProvider");

    const uiFiles = collectSourceFiles(`${SRC_ROOT}/ui`);
    const uiOffenders = uiFiles.filter((file) => readFileSync(file, "utf8").includes("OpenAIProvider"));
    assertEqual(uiOffenders.join(" | "), "", "no UI file may reference OpenAIProvider");
  });

  await check("this end-to-end harness contains no key material of its own", () => {
    // These patterns match actual *usage* - a key being passed as an
    // option, a key-shaped literal, a header being built - rather than
    // the bare words, which appear legitimately in this check's own
    // assertion messages describing what is forbidden.
    for (const fixture of ["verify.ts", "mockBackend.ts"]) {
      const source = readFileSync(fileURLToPath(new URL(`./${fixture}`, import.meta.url)), "utf8");
      assertTrue(!/["']?apiKey["']?\s*:/.test(source), `${fixture} must not pass a key as an option`);
      assertTrue(!/sk-[A-Za-z0-9]/.test(source), `${fixture} must not contain a key-shaped literal`);
      assertTrue(!/["']?Authorization["']?\s*:/i.test(source), `${fixture} must not build an authorization header`);
    }
  });

  await check("this harness never writes to a store directly - every mutation goes through CommandExecutor", () => {
    const source = readFileSync(fileURLToPath(new URL("./verify.ts", import.meta.url)), "utf8");
    const directWrites = source.match(/\w*Store\.(add|update|set|remove)\(/g) ?? [];
    assertEqual(directWrites.join(" | "), "", "the harness must not call a store's write methods");
  });

  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) {
    throw new Error(`${failed} verification check(s) failed`);
  }
}

// See src/engine/ai/verify.ts's matching comment for why this rethrows
// instead of setting `process.exitCode` - an unhandled rejection already
// exits Node with a non-zero code, and `process` isn't typed here.
run().catch((error) => {
  console.error(error);
  throw error;
});
