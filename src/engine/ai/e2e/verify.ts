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
import { createProjectContext } from "../../project/ProjectContext.ts";
import type { ProjectContext } from "../../project/ProjectContext.ts";
import { AIService } from "../AIService.ts";
import { AiPromptController } from "../AiPromptController.ts";
import { BackendAIProvider } from "../providers/BackendAIProvider.ts";
import { createMockBackend } from "./mockBackend.ts";
import { MockAIProvider } from "../MockAIProvider.ts";
import { AI_SUPPORTED_OBJECT_TYPES, buildAIProjectSnapshot } from "../types.ts";
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
    assertSameJson(app.backend.requests[0].projectContext, built, "the backend received exactly the built snapshot");
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
