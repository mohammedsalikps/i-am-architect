/**
 * Lightweight in-memory verification for CommandExecutor. Same
 * approach as src/engine/objects/verify.ts and src/engine/wall/verify.ts:
 * no test framework, plain assertion helpers, run directly by Node.
 * Run with:
 *   npm run verify
 * or directly:
 *   node src/engine/commands/verify.ts
 *
 * WallHistoryController is NOT instantiated here - its constructor
 * uses TypeScript parameter-property shorthand, which Node's native
 * TypeScript support cannot run directly (only erasable syntax is
 * supported). Instead this uses a small stand-in that satisfies the
 * WallHistoryLike interface (add/update/remove) and mirrors
 * WallHistoryController's one real rule for testing purposes: an
 * update/add only "records history" when the underlying WallStore
 * write actually succeeds. That's enough to verify CommandExecutor's
 * own routing logic (this file's actual unit under test). Full
 * integration with the real WallHistoryController (real undo/redo) is
 * verified separately in the browser, against the real compiled
 * module - see the implementation report.
 *
 * Explicit .ts extensions below are required for Node's native
 * TypeScript support to resolve these relative imports (see
 * allowImportingTsExtensions in tsconfig.json) - this file is run
 * directly by Node, not bundled by Vite.
 */
import { CommandExecutor } from "./CommandExecutor.ts";
import { WallStore } from "../wall/WallStore.ts";
import type { WallData, WallId } from "../wall/types.ts";
import type { WallValidationResult } from "../wall/validateWall.ts";
import type { WallHistoryLike } from "./types.ts";

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

/** A WallHistoryLike stand-in backed by a real WallStore - see the file header for why. */
function makeWallHistoryStub(store: WallStore): WallHistoryLike & { recordedCount: number } {
  let recordedCount = 0;
  return {
    get recordedCount(): number {
      return recordedCount;
    },
    add(wall: WallData): WallValidationResult {
      const result = store.add(wall);
      if (result.valid) {
        recordedCount += 1;
      }
      return result;
    },
    update(id: WallId, changes: Parameters<WallHistoryLike["update"]>[1]): WallValidationResult {
      const result = store.update(id, changes);
      if (result.valid) {
        recordedCount += 1;
      }
      return result;
    },
    remove(id: WallId): void {
      store.remove(id);
    }
  };
}

function run(): void {
  let passed = 0;
  let failed = 0;

  function check(name: string, fn: () => void): void {
    try {
      fn();
      passed += 1;
      console.log(`  ok - ${name}`);
    } catch (error) {
      failed += 1;
      console.error(`  FAIL - ${name}`);
      console.error(error);
    }
  }

  console.log("CommandExecutor verification\n");

  check("a valid wall.add command succeeds and stores a wall", () => {
    const store = new WallStore();
    const history = makeWallHistoryStub(store);
    const executor = new CommandExecutor(store, history);

    const result = executor.execute({ type: "wall.add", wall: { length: 3, color: "#ff0000" } });

    assertTrue(result.success, "result.success");
    assertTrue(!!result.objectId, "result.objectId should be set");
    const stored = store.get(result.objectId as WallId);
    assertTrue(stored, "wall should be stored");
    assertEqual(stored.dimensions.length, 3, "stored length");
    assertEqual(stored.color, "#ff0000", "stored color");
  });

  check("a valid wall.update command succeeds and applies the change", () => {
    const store = new WallStore();
    const history = makeWallHistoryStub(store);
    const executor = new CommandExecutor(store, history);

    const added = executor.execute({ type: "wall.add", wall: {} });
    const id = added.objectId as WallId;

    const result = executor.execute({
      type: "wall.update",
      id,
      changes: { color: "#00ff00" }
    });

    assertTrue(result.success, "result.success");
    assertEqual(result.objectId, id, "result.objectId");
    assertEqual(store.get(id)?.color, "#00ff00", "stored color after update");
  });

  check("a valid wall.delete command succeeds and removes the wall", () => {
    const store = new WallStore();
    const history = makeWallHistoryStub(store);
    const executor = new CommandExecutor(store, history);

    const added = executor.execute({ type: "wall.add", wall: {} });
    const id = added.objectId as WallId;

    const result = executor.execute({ type: "wall.delete", id });

    assertTrue(result.success, "result.success");
    assertEqual(store.get(id), undefined, "wall should be gone");
  });

  check("a valid wall.duplicate command succeeds and creates an independent wall", () => {
    const store = new WallStore();
    const history = makeWallHistoryStub(store);
    const executor = new CommandExecutor(store, history);

    const added = executor.execute({ type: "wall.add", wall: { length: 6, color: "#123456" } });
    const originalId = added.objectId as WallId;

    const result = executor.execute({ type: "wall.duplicate", id: originalId });

    assertTrue(result.success, "result.success");
    assertTrue(!!result.objectId, "result.objectId should be set");
    assertTrue(result.objectId !== originalId, "duplicate should have a different id");
    const duplicate = store.get(result.objectId as WallId);
    assertTrue(duplicate, "duplicate should be stored");
    assertEqual(duplicate.dimensions.length, 6, "duplicate length matches source");
    assertEqual(duplicate.color, "#123456", "duplicate color matches source");
    assertTrue(store.get(originalId) !== undefined, "original wall should still exist");
  });

  check("an unknown command type is rejected without throwing", () => {
    const store = new WallStore();
    const history = makeWallHistoryStub(store);
    const executor = new CommandExecutor(store, history);

    const result = executor.execute({ type: "wall.frobnicate", id: "x" });
    assertEqual(result.success, false, "result.success");
  });

  check("a malformed command (no type field) is rejected without throwing", () => {
    const store = new WallStore();
    const history = makeWallHistoryStub(store);
    const executor = new CommandExecutor(store, history);

    assertEqual(executor.execute({}).success, false, "empty object");
    assertEqual(executor.execute(null).success, false, "null");
    assertEqual(executor.execute("wall.add").success, false, "a bare string");
  });

  check("wall.update with a missing id is rejected", () => {
    const store = new WallStore();
    const history = makeWallHistoryStub(store);
    const executor = new CommandExecutor(store, history);

    const result = executor.execute({ type: "wall.update", changes: { color: "#000000" } });
    assertEqual(result.success, false, "result.success");
  });

  check("wall.delete with a missing id is rejected", () => {
    const store = new WallStore();
    const history = makeWallHistoryStub(store);
    const executor = new CommandExecutor(store, history);

    assertEqual(executor.execute({ type: "wall.delete" }).success, false, "result.success");
  });

  check("wall.add with invalid dimensions is rejected and reports field errors", () => {
    const store = new WallStore();
    const history = makeWallHistoryStub(store);
    const executor = new CommandExecutor(store, history);

    const result = executor.execute({ type: "wall.add", wall: { length: 0 } });

    assertEqual(result.success, false, "result.success");
    assertTrue(result.errors && result.errors.some((e) => e.field === "dimensions.length"), "expected a dimensions.length error");
    assertEqual(store.getAll().length, 0, "nothing should have been stored");
  });

  check("an invalid wall.update preserves the existing wall", () => {
    const store = new WallStore();
    const history = makeWallHistoryStub(store);
    const executor = new CommandExecutor(store, history);

    const added = executor.execute({ type: "wall.add", wall: {} });
    const id = added.objectId as WallId;
    const before = store.get(id);

    const result = executor.execute({
      type: "wall.update",
      id,
      changes: { dimensions: { ...before!.dimensions, thickness: -1 } }
    });

    assertEqual(result.success, false, "result.success");
    assertDeepEqual(store.get(id), before, "wall should be byte-for-byte unchanged");
  });

  check("successful commands are recorded as history (via the WallHistoryLike stub)", () => {
    const store = new WallStore();
    const history = makeWallHistoryStub(store);
    const executor = new CommandExecutor(store, history);

    assertEqual(history.recordedCount, 0, "no history yet");

    const added = executor.execute({ type: "wall.add", wall: {} });
    assertEqual(history.recordedCount, 1, "a valid add() should record history");

    executor.execute({ type: "wall.update", id: added.objectId as WallId, changes: { color: "#abcdef" } });
    assertEqual(history.recordedCount, 2, "a valid update() should record history");
  });

  check("failed commands create no history entry (via the WallHistoryLike stub)", () => {
    const store = new WallStore();
    const history = makeWallHistoryStub(store);
    const executor = new CommandExecutor(store, history);

    executor.execute({ type: "wall.add", wall: { length: -1 } });
    assertEqual(history.recordedCount, 0, "an invalid add() should not record history");

    const added = executor.execute({ type: "wall.add", wall: {} });
    assertEqual(history.recordedCount, 1, "sanity: the valid add() above should have recorded");

    executor.execute({
      type: "wall.update",
      id: added.objectId as WallId,
      changes: { rotation: Infinity }
    });
    assertEqual(history.recordedCount, 1, "an invalid update() should not record additional history");

    executor.execute({ type: "wall.update", id: "does-not-exist", changes: { color: "#000000" } });
    assertEqual(history.recordedCount, 1, "an update() for a missing id should not record history");
  });

  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) {
    throw new Error(`${failed} verification check(s) failed`);
  }
}

run();
