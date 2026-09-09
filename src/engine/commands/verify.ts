/**
 * Lightweight in-memory verification for CommandExecutor - wall,
 * pillar, beam, slab, door, and window commands, plus assembly
 * commands. Same approach as the other verify.ts scripts in this
 * project: no test framework, plain assertion helpers, run directly by
 * Node. Run with:
 *   npm run verify
 * or directly:
 *   node src/engine/commands/verify.ts
 *
 * None of WallHistoryController, PillarHistoryController,
 * BeamHistoryController, SlabHistoryController, DoorHistoryController,
 * or WindowHistoryController is instantiated here - all six
 * constructors use TypeScript parameter-property shorthand, which
 * Node's native TypeScript support cannot run directly (only erasable
 * syntax is supported). Instead this uses small stand-ins that satisfy
 * the WallHistoryLike/PillarHistoryLike/BeamHistoryLike/SlabHistoryLike/
 * DoorHistoryLike/WindowHistoryLike interfaces (add/update/remove) and
 * mirror each controller's one real rule for testing purposes: an
 * update/add only "records history" when the underlying store write
 * actually succeeds. That's enough to verify CommandExecutor's own
 * routing logic (this file's actual unit under test). Full integration
 * with the real *HistoryController classes (real undo/redo) is
 * verified separately in the browser, against the real compiled
 * module - see the implementation report.
 *
 * Assembly commands need no such stand-in - AssemblyStore has no
 * parameter-property constructor, so the real class is used directly.
 * Assembly commands don't touch history at all (see commands/README.md
 * and assemblies/README.md), so there's nothing to stand in for there.
 *
 * Explicit .ts extensions below are required for Node's native
 * TypeScript support to resolve these relative imports (see
 * allowImportingTsExtensions in tsconfig.json) - this file is run
 * directly by Node, not bundled by Vite.
 */
import { CommandExecutor } from "./CommandExecutor.ts";
import { WallStore } from "../wall/WallStore.ts";
import { PillarStore } from "../pillar/PillarStore.ts";
import { BeamStore } from "../beam/BeamStore.ts";
import { SlabStore } from "../slab/SlabStore.ts";
import { DoorStore } from "../door/DoorStore.ts";
import { WindowStore } from "../window/WindowStore.ts";
import { AssemblyStore } from "../assemblies/AssemblyStore.ts";
import type { WallData, WallId } from "../wall/types.ts";
import type { WallValidationResult } from "../wall/validateWall.ts";
import type { PillarData, PillarId } from "../pillar/types.ts";
import type { PillarValidationResult } from "../pillar/validatePillar.ts";
import type { BeamData, BeamId } from "../beam/types.ts";
import type { BeamValidationResult } from "../beam/validateBeam.ts";
import type { SlabData, SlabId } from "../slab/types.ts";
import type { SlabValidationResult } from "../slab/validateSlab.ts";
import type { DoorData, DoorId } from "../door/types.ts";
import type { DoorValidationResult } from "../door/validateDoor.ts";
import type { WindowData, WindowId } from "../window/types.ts";
import type { WindowValidationResult } from "../window/validateWindow.ts";
import type {
  WallHistoryLike,
  PillarHistoryLike,
  BeamHistoryLike,
  SlabHistoryLike,
  DoorHistoryLike,
  WindowHistoryLike
} from "./types.ts";

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

/** A PillarHistoryLike stand-in backed by a real PillarStore - mirrors makeWallHistoryStub above. */
function makePillarHistoryStub(store: PillarStore): PillarHistoryLike & { recordedCount: number } {
  let recordedCount = 0;
  return {
    get recordedCount(): number {
      return recordedCount;
    },
    add(pillar: PillarData): PillarValidationResult {
      const result = store.add(pillar);
      if (result.valid) {
        recordedCount += 1;
      }
      return result;
    },
    update(id: PillarId, changes: Parameters<PillarHistoryLike["update"]>[1]): PillarValidationResult {
      const result = store.update(id, changes);
      if (result.valid) {
        recordedCount += 1;
      }
      return result;
    },
    remove(id: PillarId): void {
      store.remove(id);
    }
  };
}

/** A BeamHistoryLike stand-in backed by a real BeamStore - mirrors makeWallHistoryStub/makePillarHistoryStub above. */
function makeBeamHistoryStub(store: BeamStore): BeamHistoryLike & { recordedCount: number } {
  let recordedCount = 0;
  return {
    get recordedCount(): number {
      return recordedCount;
    },
    add(beam: BeamData): BeamValidationResult {
      const result = store.add(beam);
      if (result.valid) {
        recordedCount += 1;
      }
      return result;
    },
    update(id: BeamId, changes: Parameters<BeamHistoryLike["update"]>[1]): BeamValidationResult {
      const result = store.update(id, changes);
      if (result.valid) {
        recordedCount += 1;
      }
      return result;
    },
    remove(id: BeamId): void {
      store.remove(id);
    }
  };
}

/** A SlabHistoryLike stand-in backed by a real SlabStore - mirrors makeWallHistoryStub/makePillarHistoryStub/makeBeamHistoryStub above. */
function makeSlabHistoryStub(store: SlabStore): SlabHistoryLike & { recordedCount: number } {
  let recordedCount = 0;
  return {
    get recordedCount(): number {
      return recordedCount;
    },
    add(slab: SlabData): SlabValidationResult {
      const result = store.add(slab);
      if (result.valid) {
        recordedCount += 1;
      }
      return result;
    },
    update(id: SlabId, changes: Parameters<SlabHistoryLike["update"]>[1]): SlabValidationResult {
      const result = store.update(id, changes);
      if (result.valid) {
        recordedCount += 1;
      }
      return result;
    },
    remove(id: SlabId): void {
      store.remove(id);
    }
  };
}

/** A DoorHistoryLike stand-in backed by a real DoorStore - mirrors makeWallHistoryStub and every sibling stub above. */
function makeDoorHistoryStub(store: DoorStore): DoorHistoryLike & { recordedCount: number } {
  let recordedCount = 0;
  return {
    get recordedCount(): number {
      return recordedCount;
    },
    add(door: DoorData): DoorValidationResult {
      const result = store.add(door);
      if (result.valid) {
        recordedCount += 1;
      }
      return result;
    },
    update(id: DoorId, changes: Parameters<DoorHistoryLike["update"]>[1]): DoorValidationResult {
      const result = store.update(id, changes);
      if (result.valid) {
        recordedCount += 1;
      }
      return result;
    },
    remove(id: DoorId): void {
      store.remove(id);
    }
  };
}

/** A WindowHistoryLike stand-in backed by a real WindowStore - mirrors makeWallHistoryStub and every sibling stub above. */
function makeWindowHistoryStub(store: WindowStore): WindowHistoryLike & { recordedCount: number } {
  let recordedCount = 0;
  return {
    get recordedCount(): number {
      return recordedCount;
    },
    add(windowData: WindowData): WindowValidationResult {
      const result = store.add(windowData);
      if (result.valid) {
        recordedCount += 1;
      }
      return result;
    },
    update(id: WindowId, changes: Parameters<WindowHistoryLike["update"]>[1]): WindowValidationResult {
      const result = store.update(id, changes);
      if (result.valid) {
        recordedCount += 1;
      }
      return result;
    },
    remove(id: WindowId): void {
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

  // --- Pillar commands ---

  function makePillarExecutor(): { executor: CommandExecutor; pillars: PillarStore } {
    const wallStoreStub = new WallStore();
    const wallHistory = makeWallHistoryStub(wallStoreStub);
    const pillars = new PillarStore();
    const pillarHistory = makePillarHistoryStub(pillars);
    return {
      executor: new CommandExecutor(wallStoreStub, wallHistory, new AssemblyStore(), pillars, pillarHistory),
      pillars
    };
  }

  check("a valid pillar.add command succeeds and stores a pillar", () => {
    const { executor, pillars } = makePillarExecutor();

    const result = executor.execute({ type: "pillar.add", pillar: { width: 0.5, color: "#ff0000" } });

    assertTrue(result.success, "result.success");
    assertTrue(!!result.objectId, "result.objectId should be set");
    const stored = pillars.get(result.objectId as PillarId);
    assertTrue(stored, "pillar should be stored");
    assertEqual(stored.dimensions.width, 0.5, "stored width");
    assertEqual(stored.color, "#ff0000", "stored color");
  });

  check("a valid pillar.update command succeeds and applies the change", () => {
    const { executor, pillars } = makePillarExecutor();

    const added = executor.execute({ type: "pillar.add", pillar: {} });
    const id = added.objectId as PillarId;

    const result = executor.execute({
      type: "pillar.update",
      id,
      changes: { color: "#00ff00" }
    });

    assertTrue(result.success, "result.success");
    assertEqual(result.objectId, id, "result.objectId");
    assertEqual(pillars.get(id)?.color, "#00ff00", "stored color after update");
  });

  check("a valid pillar.delete command succeeds and removes the pillar", () => {
    const { executor, pillars } = makePillarExecutor();

    const added = executor.execute({ type: "pillar.add", pillar: {} });
    const id = added.objectId as PillarId;

    const result = executor.execute({ type: "pillar.delete", id });

    assertTrue(result.success, "result.success");
    assertEqual(pillars.get(id), undefined, "pillar should be gone");
  });

  check("a valid pillar.duplicate command succeeds and creates an independent pillar", () => {
    const { executor, pillars } = makePillarExecutor();

    const added = executor.execute({ type: "pillar.add", pillar: { width: 0.6, color: "#123456" } });
    const originalId = added.objectId as PillarId;

    const result = executor.execute({ type: "pillar.duplicate", id: originalId });

    assertTrue(result.success, "result.success");
    assertTrue(!!result.objectId, "result.objectId should be set");
    assertTrue(result.objectId !== originalId, "duplicate should have a different id");
    const duplicate = pillars.get(result.objectId as PillarId);
    assertTrue(duplicate, "duplicate should be stored");
    assertEqual(duplicate.dimensions.width, 0.6, "duplicate width matches source");
    assertEqual(duplicate.color, "#123456", "duplicate color matches source");
    assertTrue(pillars.get(originalId) !== undefined, "original pillar should still exist");
  });

  check("pillar.update with a missing id is rejected", () => {
    const { executor } = makePillarExecutor();
    const result = executor.execute({ type: "pillar.update", changes: { color: "#000000" } });
    assertEqual(result.success, false, "result.success");
  });

  check("pillar.delete with a missing id is rejected", () => {
    const { executor } = makePillarExecutor();
    assertEqual(executor.execute({ type: "pillar.delete" }).success, false, "result.success");
  });

  check("pillar.add with invalid dimensions is rejected and reports field errors", () => {
    const { executor, pillars } = makePillarExecutor();

    const result = executor.execute({ type: "pillar.add", pillar: { width: 0 } });

    assertEqual(result.success, false, "result.success");
    assertTrue(
      result.errors && result.errors.some((e) => e.field === "dimensions.width"),
      "expected a dimensions.width error"
    );
    assertEqual(pillars.getAll().length, 0, "nothing should have been stored");
  });

  check("an invalid pillar.update preserves the existing pillar", () => {
    const { executor, pillars } = makePillarExecutor();

    const added = executor.execute({ type: "pillar.add", pillar: {} });
    const id = added.objectId as PillarId;
    const before = pillars.get(id);

    const result = executor.execute({
      type: "pillar.update",
      id,
      changes: { dimensions: { ...before!.dimensions, depth: -1 } }
    });

    assertEqual(result.success, false, "result.success");
    assertDeepEqual(pillars.get(id), before, "pillar should be byte-for-byte unchanged");
  });

  check("successful pillar commands are recorded as history (via the PillarHistoryLike stub)", () => {
    const wallStoreStub = new WallStore();
    const wallHistory = makeWallHistoryStub(wallStoreStub);
    const pillars = new PillarStore();
    const pillarHistory = makePillarHistoryStub(pillars);
    const executor = new CommandExecutor(wallStoreStub, wallHistory, new AssemblyStore(), pillars, pillarHistory);

    assertEqual(pillarHistory.recordedCount, 0, "no history yet");

    const added = executor.execute({ type: "pillar.add", pillar: {} });
    assertEqual(pillarHistory.recordedCount, 1, "a valid add() should record history");

    executor.execute({ type: "pillar.update", id: added.objectId as PillarId, changes: { color: "#abcdef" } });
    assertEqual(pillarHistory.recordedCount, 2, "a valid update() should record history");
  });

  check("failed pillar commands create no history entry (via the PillarHistoryLike stub)", () => {
    const wallStoreStub = new WallStore();
    const wallHistory = makeWallHistoryStub(wallStoreStub);
    const pillars = new PillarStore();
    const pillarHistory = makePillarHistoryStub(pillars);
    const executor = new CommandExecutor(wallStoreStub, wallHistory, new AssemblyStore(), pillars, pillarHistory);

    executor.execute({ type: "pillar.add", pillar: { width: -1 } });
    assertEqual(pillarHistory.recordedCount, 0, "an invalid add() should not record history");

    const added = executor.execute({ type: "pillar.add", pillar: {} });
    assertEqual(pillarHistory.recordedCount, 1, "sanity: the valid add() above should have recorded");

    executor.execute({
      type: "pillar.update",
      id: added.objectId as PillarId,
      changes: { rotation: Infinity }
    });
    assertEqual(pillarHistory.recordedCount, 1, "an invalid update() should not record additional history");

    executor.execute({ type: "pillar.update", id: "does-not-exist", changes: { color: "#000000" } });
    assertEqual(pillarHistory.recordedCount, 1, "an update() for a missing id should not record history");
  });

  check("wall and pillar commands do not interfere with each other's stores", () => {
    const wallStoreStub = new WallStore();
    const wallHistory = makeWallHistoryStub(wallStoreStub);
    const pillars = new PillarStore();
    const pillarHistory = makePillarHistoryStub(pillars);
    const executor = new CommandExecutor(wallStoreStub, wallHistory, new AssemblyStore(), pillars, pillarHistory);

    const wallResult = executor.execute({ type: "wall.add", wall: {} });
    const pillarResult = executor.execute({ type: "pillar.add", pillar: {} });

    assertTrue(wallStoreStub.get(wallResult.objectId as WallId) !== undefined, "wall should be in wallStore");
    assertEqual(pillars.get(wallResult.objectId as PillarId), undefined, "wall id should not leak into pillarStore");
    assertTrue(pillars.get(pillarResult.objectId as PillarId) !== undefined, "pillar should be in pillarStore");
    assertEqual(wallStoreStub.get(pillarResult.objectId as WallId), undefined, "pillar id should not leak into wallStore");
  });

  // --- Beam commands ---

  function makeBeamExecutor(): { executor: CommandExecutor; beams: BeamStore } {
    const wallStoreStub = new WallStore();
    const wallHistory = makeWallHistoryStub(wallStoreStub);
    const beams = new BeamStore();
    const beamHistory = makeBeamHistoryStub(beams);
    return {
      executor: new CommandExecutor(
        wallStoreStub,
        wallHistory,
        new AssemblyStore(),
        new PillarStore(),
        undefined,
        beams,
        beamHistory
      ),
      beams
    };
  }

  check("a valid beam.add command succeeds and stores a beam", () => {
    const { executor, beams } = makeBeamExecutor();

    const result = executor.execute({ type: "beam.add", beam: { length: 4, color: "#ff0000" } });

    assertTrue(result.success, "result.success");
    assertTrue(!!result.objectId, "result.objectId should be set");
    const stored = beams.get(result.objectId as BeamId);
    assertTrue(stored, "beam should be stored");
    assertEqual(stored.dimensions.length, 4, "stored length");
    assertEqual(stored.color, "#ff0000", "stored color");
  });

  check("a valid beam.update command succeeds and applies the change", () => {
    const { executor, beams } = makeBeamExecutor();

    const added = executor.execute({ type: "beam.add", beam: {} });
    const id = added.objectId as BeamId;

    const result = executor.execute({
      type: "beam.update",
      id,
      changes: { color: "#00ff00" }
    });

    assertTrue(result.success, "result.success");
    assertEqual(result.objectId, id, "result.objectId");
    assertEqual(beams.get(id)?.color, "#00ff00", "stored color after update");
  });

  check("a valid beam.delete command succeeds and removes the beam", () => {
    const { executor, beams } = makeBeamExecutor();

    const added = executor.execute({ type: "beam.add", beam: {} });
    const id = added.objectId as BeamId;

    const result = executor.execute({ type: "beam.delete", id });

    assertTrue(result.success, "result.success");
    assertEqual(beams.get(id), undefined, "beam should be gone");
  });

  check("a valid beam.duplicate command succeeds and creates an independent beam", () => {
    const { executor, beams } = makeBeamExecutor();

    const added = executor.execute({ type: "beam.add", beam: { length: 5, color: "#123456" } });
    const originalId = added.objectId as BeamId;

    const result = executor.execute({ type: "beam.duplicate", id: originalId });

    assertTrue(result.success, "result.success");
    assertTrue(!!result.objectId, "result.objectId should be set");
    assertTrue(result.objectId !== originalId, "duplicate should have a different id");
    const duplicate = beams.get(result.objectId as BeamId);
    assertTrue(duplicate, "duplicate should be stored");
    assertEqual(duplicate.dimensions.length, 5, "duplicate length matches source");
    assertEqual(duplicate.color, "#123456", "duplicate color matches source");
    assertTrue(beams.get(originalId) !== undefined, "original beam should still exist");
  });

  check("beam.update with a missing id is rejected", () => {
    const { executor } = makeBeamExecutor();
    const result = executor.execute({ type: "beam.update", changes: { color: "#000000" } });
    assertEqual(result.success, false, "result.success");
  });

  check("beam.delete with a missing id is rejected", () => {
    const { executor } = makeBeamExecutor();
    assertEqual(executor.execute({ type: "beam.delete" }).success, false, "result.success");
  });

  check("beam.add with invalid dimensions is rejected and reports field errors", () => {
    const { executor, beams } = makeBeamExecutor();

    const result = executor.execute({ type: "beam.add", beam: { length: 0 } });

    assertEqual(result.success, false, "result.success");
    assertTrue(
      result.errors && result.errors.some((e) => e.field === "dimensions.length"),
      "expected a dimensions.length error"
    );
    assertEqual(beams.getAll().length, 0, "nothing should have been stored");
  });

  check("an invalid beam.update preserves the existing beam", () => {
    const { executor, beams } = makeBeamExecutor();

    const added = executor.execute({ type: "beam.add", beam: {} });
    const id = added.objectId as BeamId;
    const before = beams.get(id);

    const result = executor.execute({
      type: "beam.update",
      id,
      changes: { dimensions: { ...before!.dimensions, width: -1 } }
    });

    assertEqual(result.success, false, "result.success");
    assertDeepEqual(beams.get(id), before, "beam should be byte-for-byte unchanged");
  });

  check("successful beam commands are recorded as history (via the BeamHistoryLike stub)", () => {
    const wallStoreStub = new WallStore();
    const wallHistory = makeWallHistoryStub(wallStoreStub);
    const beams = new BeamStore();
    const beamHistory = makeBeamHistoryStub(beams);
    const executor = new CommandExecutor(
      wallStoreStub,
      wallHistory,
      new AssemblyStore(),
      new PillarStore(),
      undefined,
      beams,
      beamHistory
    );

    assertEqual(beamHistory.recordedCount, 0, "no history yet");

    const added = executor.execute({ type: "beam.add", beam: {} });
    assertEqual(beamHistory.recordedCount, 1, "a valid add() should record history");

    executor.execute({ type: "beam.update", id: added.objectId as BeamId, changes: { color: "#abcdef" } });
    assertEqual(beamHistory.recordedCount, 2, "a valid update() should record history");
  });

  check("failed beam commands create no history entry (via the BeamHistoryLike stub)", () => {
    const wallStoreStub = new WallStore();
    const wallHistory = makeWallHistoryStub(wallStoreStub);
    const beams = new BeamStore();
    const beamHistory = makeBeamHistoryStub(beams);
    const executor = new CommandExecutor(
      wallStoreStub,
      wallHistory,
      new AssemblyStore(),
      new PillarStore(),
      undefined,
      beams,
      beamHistory
    );

    executor.execute({ type: "beam.add", beam: { length: -1 } });
    assertEqual(beamHistory.recordedCount, 0, "an invalid add() should not record history");

    const added = executor.execute({ type: "beam.add", beam: {} });
    assertEqual(beamHistory.recordedCount, 1, "sanity: the valid add() above should have recorded");

    executor.execute({
      type: "beam.update",
      id: added.objectId as BeamId,
      changes: { rotation: Infinity }
    });
    assertEqual(beamHistory.recordedCount, 1, "an invalid update() should not record additional history");

    executor.execute({ type: "beam.update", id: "does-not-exist", changes: { color: "#000000" } });
    assertEqual(beamHistory.recordedCount, 1, "an update() for a missing id should not record history");
  });

  check("wall, pillar, beam, slab, door, and window commands do not interfere with each other's stores", () => {
    const wallStoreStub = new WallStore();
    const wallHistory = makeWallHistoryStub(wallStoreStub);
    const pillars = new PillarStore();
    const pillarHistory = makePillarHistoryStub(pillars);
    const beams = new BeamStore();
    const beamHistory = makeBeamHistoryStub(beams);
    const slabs = new SlabStore();
    const slabHistory = makeSlabHistoryStub(slabs);
    const doors = new DoorStore();
    const doorHistory = makeDoorHistoryStub(doors);
    const windows = new WindowStore();
    const windowHistory = makeWindowHistoryStub(windows);
    const executor = new CommandExecutor(
      wallStoreStub,
      wallHistory,
      new AssemblyStore(),
      pillars,
      pillarHistory,
      beams,
      beamHistory,
      slabs,
      slabHistory,
      doors,
      doorHistory,
      windows,
      windowHistory
    );

    const results: Record<string, ReturnType<CommandExecutor["execute"]>> = {
      wall: executor.execute({ type: "wall.add", wall: {} }),
      pillar: executor.execute({ type: "pillar.add", pillar: {} }),
      beam: executor.execute({ type: "beam.add", beam: {} }),
      slab: executor.execute({ type: "slab.add", slab: {} }),
      door: executor.execute({ type: "door.add", door: {} }),
      window: executor.execute({ type: "window.add", window: {} })
    };

    const stores: Record<string, { get(id: string): unknown }> = {
      wall: wallStoreStub,
      pillar: pillars,
      beam: beams,
      slab: slabs,
      door: doors,
      window: windows
    };

    for (const ownerType of Object.keys(results)) {
      const id = results[ownerType].objectId as string;
      for (const storeType of Object.keys(stores)) {
        const found = stores[storeType].get(id) !== undefined;
        if (storeType === ownerType) {
          assertTrue(found, `${ownerType} should be in ${storeType}Store`);
        } else {
          assertEqual(found, false, `${ownerType} id should not leak into ${storeType}Store`);
        }
      }
    }
  });

  // --- Slab commands ---

  function makeSlabExecutor(): { executor: CommandExecutor; slabs: SlabStore } {
    const wallStoreStub = new WallStore();
    const wallHistory = makeWallHistoryStub(wallStoreStub);
    const slabs = new SlabStore();
    const slabHistory = makeSlabHistoryStub(slabs);
    return {
      executor: new CommandExecutor(
        wallStoreStub,
        wallHistory,
        new AssemblyStore(),
        new PillarStore(),
        undefined,
        new BeamStore(),
        undefined,
        slabs,
        slabHistory
      ),
      slabs
    };
  }

  check("a valid slab.add command succeeds and stores a slab", () => {
    const { executor, slabs } = makeSlabExecutor();

    const result = executor.execute({ type: "slab.add", slab: { length: 6, color: "#ff0000" } });

    assertTrue(result.success, "result.success");
    assertTrue(!!result.objectId, "result.objectId should be set");
    const stored = slabs.get(result.objectId as SlabId);
    assertTrue(stored, "slab should be stored");
    assertEqual(stored.dimensions.length, 6, "stored length");
    assertEqual(stored.color, "#ff0000", "stored color");
  });

  check("a valid slab.update command succeeds and applies the change", () => {
    const { executor, slabs } = makeSlabExecutor();

    const added = executor.execute({ type: "slab.add", slab: {} });
    const id = added.objectId as SlabId;

    const result = executor.execute({
      type: "slab.update",
      id,
      changes: { color: "#00ff00" }
    });

    assertTrue(result.success, "result.success");
    assertEqual(result.objectId, id, "result.objectId");
    assertEqual(slabs.get(id)?.color, "#00ff00", "stored color after update");
  });

  check("a valid slab.delete command succeeds and removes the slab", () => {
    const { executor, slabs } = makeSlabExecutor();

    const added = executor.execute({ type: "slab.add", slab: {} });
    const id = added.objectId as SlabId;

    const result = executor.execute({ type: "slab.delete", id });

    assertTrue(result.success, "result.success");
    assertEqual(slabs.get(id), undefined, "slab should be gone");
  });

  check("a valid slab.duplicate command succeeds and creates an independent slab", () => {
    const { executor, slabs } = makeSlabExecutor();

    const added = executor.execute({ type: "slab.add", slab: { length: 7, color: "#123456" } });
    const originalId = added.objectId as SlabId;

    const result = executor.execute({ type: "slab.duplicate", id: originalId });

    assertTrue(result.success, "result.success");
    assertTrue(!!result.objectId, "result.objectId should be set");
    assertTrue(result.objectId !== originalId, "duplicate should have a different id");
    const duplicate = slabs.get(result.objectId as SlabId);
    assertTrue(duplicate, "duplicate should be stored");
    assertEqual(duplicate.dimensions.length, 7, "duplicate length matches source");
    assertEqual(duplicate.color, "#123456", "duplicate color matches source");
    assertTrue(slabs.get(originalId) !== undefined, "original slab should still exist");
  });

  check("slab.update with a missing id is rejected", () => {
    const { executor } = makeSlabExecutor();
    const result = executor.execute({ type: "slab.update", changes: { color: "#000000" } });
    assertEqual(result.success, false, "result.success");
  });

  check("slab.delete with a missing id is rejected", () => {
    const { executor } = makeSlabExecutor();
    assertEqual(executor.execute({ type: "slab.delete" }).success, false, "result.success");
  });

  check("slab.add with invalid dimensions is rejected and reports field errors", () => {
    const { executor, slabs } = makeSlabExecutor();

    const result = executor.execute({ type: "slab.add", slab: { length: 0 } });

    assertEqual(result.success, false, "result.success");
    assertTrue(
      result.errors && result.errors.some((e) => e.field === "dimensions.length"),
      "expected a dimensions.length error"
    );
    assertEqual(slabs.getAll().length, 0, "nothing should have been stored");
  });

  check("an invalid slab.update preserves the existing slab", () => {
    const { executor, slabs } = makeSlabExecutor();

    const added = executor.execute({ type: "slab.add", slab: {} });
    const id = added.objectId as SlabId;
    const before = slabs.get(id);

    const result = executor.execute({
      type: "slab.update",
      id,
      changes: { dimensions: { ...before!.dimensions, width: -1 } }
    });

    assertEqual(result.success, false, "result.success");
    assertDeepEqual(slabs.get(id), before, "slab should be byte-for-byte unchanged");
  });

  check("successful slab commands are recorded as history (via the SlabHistoryLike stub)", () => {
    const wallStoreStub = new WallStore();
    const wallHistory = makeWallHistoryStub(wallStoreStub);
    const slabs = new SlabStore();
    const slabHistory = makeSlabHistoryStub(slabs);
    const executor = new CommandExecutor(
      wallStoreStub,
      wallHistory,
      new AssemblyStore(),
      new PillarStore(),
      undefined,
      new BeamStore(),
      undefined,
      slabs,
      slabHistory
    );

    assertEqual(slabHistory.recordedCount, 0, "no history yet");

    const added = executor.execute({ type: "slab.add", slab: {} });
    assertEqual(slabHistory.recordedCount, 1, "a valid add() should record history");

    executor.execute({ type: "slab.update", id: added.objectId as SlabId, changes: { color: "#abcdef" } });
    assertEqual(slabHistory.recordedCount, 2, "a valid update() should record history");
  });

  check("failed slab commands create no history entry (via the SlabHistoryLike stub)", () => {
    const wallStoreStub = new WallStore();
    const wallHistory = makeWallHistoryStub(wallStoreStub);
    const slabs = new SlabStore();
    const slabHistory = makeSlabHistoryStub(slabs);
    const executor = new CommandExecutor(
      wallStoreStub,
      wallHistory,
      new AssemblyStore(),
      new PillarStore(),
      undefined,
      new BeamStore(),
      undefined,
      slabs,
      slabHistory
    );

    executor.execute({ type: "slab.add", slab: { length: -1 } });
    assertEqual(slabHistory.recordedCount, 0, "an invalid add() should not record history");

    const added = executor.execute({ type: "slab.add", slab: {} });
    assertEqual(slabHistory.recordedCount, 1, "sanity: the valid add() above should have recorded");

    executor.execute({
      type: "slab.update",
      id: added.objectId as SlabId,
      changes: { rotation: Infinity }
    });
    assertEqual(slabHistory.recordedCount, 1, "an invalid update() should not record additional history");

    executor.execute({ type: "slab.update", id: "does-not-exist", changes: { color: "#000000" } });
    assertEqual(slabHistory.recordedCount, 1, "an update() for a missing id should not record history");
  });

  // --- Door commands ---

  function makeDoorExecutor(): { executor: CommandExecutor; doors: DoorStore } {
    const wallStoreStub = new WallStore();
    const wallHistory = makeWallHistoryStub(wallStoreStub);
    const doors = new DoorStore();
    const doorHistory = makeDoorHistoryStub(doors);
    return {
      executor: new CommandExecutor(
        wallStoreStub,
        wallHistory,
        new AssemblyStore(),
        new PillarStore(),
        undefined,
        new BeamStore(),
        undefined,
        new SlabStore(),
        undefined,
        doors,
        doorHistory
      ),
      doors
    };
  }

  check("a valid door.add command succeeds and stores a door", () => {
    const { executor, doors } = makeDoorExecutor();

    const result = executor.execute({ type: "door.add", door: { width: 1, color: "#ff0000" } });

    assertTrue(result.success, "result.success");
    assertTrue(!!result.objectId, "result.objectId should be set");
    const stored = doors.get(result.objectId as DoorId);
    assertTrue(stored, "door should be stored");
    assertEqual(stored.dimensions.width, 1, "stored width");
    assertEqual(stored.color, "#ff0000", "stored color");
  });

  check("a valid door.update command succeeds and applies the change", () => {
    const { executor, doors } = makeDoorExecutor();

    const added = executor.execute({ type: "door.add", door: {} });
    const id = added.objectId as DoorId;

    const result = executor.execute({
      type: "door.update",
      id,
      changes: { color: "#00ff00" }
    });

    assertTrue(result.success, "result.success");
    assertEqual(result.objectId, id, "result.objectId");
    assertEqual(doors.get(id)?.color, "#00ff00", "stored color after update");
  });

  check("a valid door.delete command succeeds and removes the door", () => {
    const { executor, doors } = makeDoorExecutor();

    const added = executor.execute({ type: "door.add", door: {} });
    const id = added.objectId as DoorId;

    const result = executor.execute({ type: "door.delete", id });

    assertTrue(result.success, "result.success");
    assertEqual(doors.get(id), undefined, "door should be gone");
  });

  check("a valid door.duplicate command succeeds and creates an independent door", () => {
    const { executor, doors } = makeDoorExecutor();

    const added = executor.execute({ type: "door.add", door: { width: 1.1, color: "#123456" } });
    const originalId = added.objectId as DoorId;

    const result = executor.execute({ type: "door.duplicate", id: originalId });

    assertTrue(result.success, "result.success");
    assertTrue(!!result.objectId, "result.objectId should be set");
    assertTrue(result.objectId !== originalId, "duplicate should have a different id");
    const duplicate = doors.get(result.objectId as DoorId);
    assertTrue(duplicate, "duplicate should be stored");
    assertEqual(duplicate.dimensions.width, 1.1, "duplicate width matches source");
    assertEqual(duplicate.color, "#123456", "duplicate color matches source");
    assertTrue(doors.get(originalId) !== undefined, "original door should still exist");
  });

  check("door.update with a missing id is rejected", () => {
    const { executor } = makeDoorExecutor();
    const result = executor.execute({ type: "door.update", changes: { color: "#000000" } });
    assertEqual(result.success, false, "result.success");
  });

  check("door.delete with a missing id is rejected", () => {
    const { executor } = makeDoorExecutor();
    assertEqual(executor.execute({ type: "door.delete" }).success, false, "result.success");
  });

  check("door.add with invalid dimensions is rejected and reports field errors", () => {
    const { executor, doors } = makeDoorExecutor();

    const result = executor.execute({ type: "door.add", door: { width: 0 } });

    assertEqual(result.success, false, "result.success");
    assertTrue(
      result.errors && result.errors.some((e) => e.field === "dimensions.width"),
      "expected a dimensions.width error"
    );
    assertEqual(doors.getAll().length, 0, "nothing should have been stored");
  });

  check("an invalid door.update preserves the existing door", () => {
    const { executor, doors } = makeDoorExecutor();

    const added = executor.execute({ type: "door.add", door: {} });
    const id = added.objectId as DoorId;
    const before = doors.get(id);

    const result = executor.execute({
      type: "door.update",
      id,
      changes: { dimensions: { ...before!.dimensions, thickness: -1 } }
    });

    assertEqual(result.success, false, "result.success");
    assertDeepEqual(doors.get(id), before, "door should be byte-for-byte unchanged");
  });

  check("successful door commands are recorded as history (via the DoorHistoryLike stub)", () => {
    const wallStoreStub = new WallStore();
    const wallHistory = makeWallHistoryStub(wallStoreStub);
    const doors = new DoorStore();
    const doorHistory = makeDoorHistoryStub(doors);
    const executor = new CommandExecutor(
      wallStoreStub,
      wallHistory,
      new AssemblyStore(),
      new PillarStore(),
      undefined,
      new BeamStore(),
      undefined,
      new SlabStore(),
      undefined,
      doors,
      doorHistory
    );

    assertEqual(doorHistory.recordedCount, 0, "no history yet");

    const added = executor.execute({ type: "door.add", door: {} });
    assertEqual(doorHistory.recordedCount, 1, "a valid add() should record history");

    executor.execute({ type: "door.update", id: added.objectId as DoorId, changes: { color: "#abcdef" } });
    assertEqual(doorHistory.recordedCount, 2, "a valid update() should record history");
  });

  check("failed door commands create no history entry (via the DoorHistoryLike stub)", () => {
    const wallStoreStub = new WallStore();
    const wallHistory = makeWallHistoryStub(wallStoreStub);
    const doors = new DoorStore();
    const doorHistory = makeDoorHistoryStub(doors);
    const executor = new CommandExecutor(
      wallStoreStub,
      wallHistory,
      new AssemblyStore(),
      new PillarStore(),
      undefined,
      new BeamStore(),
      undefined,
      new SlabStore(),
      undefined,
      doors,
      doorHistory
    );

    executor.execute({ type: "door.add", door: { width: -1 } });
    assertEqual(doorHistory.recordedCount, 0, "an invalid add() should not record history");

    const added = executor.execute({ type: "door.add", door: {} });
    assertEqual(doorHistory.recordedCount, 1, "sanity: the valid add() above should have recorded");

    executor.execute({
      type: "door.update",
      id: added.objectId as DoorId,
      changes: { rotation: Infinity }
    });
    assertEqual(doorHistory.recordedCount, 1, "an invalid update() should not record additional history");

    executor.execute({ type: "door.update", id: "does-not-exist", changes: { color: "#000000" } });
    assertEqual(doorHistory.recordedCount, 1, "an update() for a missing id should not record history");
  });

  // --- Window commands ---

  function makeWindowExecutor(): { executor: CommandExecutor; windows: WindowStore } {
    const wallStoreStub = new WallStore();
    const wallHistory = makeWallHistoryStub(wallStoreStub);
    const windows = new WindowStore();
    const windowHistory = makeWindowHistoryStub(windows);
    return {
      executor: new CommandExecutor(
        wallStoreStub,
        wallHistory,
        new AssemblyStore(),
        new PillarStore(),
        undefined,
        new BeamStore(),
        undefined,
        new SlabStore(),
        undefined,
        new DoorStore(),
        undefined,
        windows,
        windowHistory
      ),
      windows
    };
  }

  check("a valid window.add command succeeds and stores a window", () => {
    const { executor, windows } = makeWindowExecutor();

    const result = executor.execute({ type: "window.add", window: { width: 1.5, color: "#ff0000" } });

    assertTrue(result.success, "result.success");
    assertTrue(!!result.objectId, "result.objectId should be set");
    const stored = windows.get(result.objectId as WindowId);
    assertTrue(stored, "window should be stored");
    assertEqual(stored.dimensions.width, 1.5, "stored width");
    assertEqual(stored.color, "#ff0000", "stored color");
  });

  check("a valid window.update command succeeds and applies the change", () => {
    const { executor, windows } = makeWindowExecutor();

    const added = executor.execute({ type: "window.add", window: {} });
    const id = added.objectId as WindowId;

    const result = executor.execute({
      type: "window.update",
      id,
      changes: { color: "#00ff00" }
    });

    assertTrue(result.success, "result.success");
    assertEqual(result.objectId, id, "result.objectId");
    assertEqual(windows.get(id)?.color, "#00ff00", "stored color after update");
  });

  check("a valid window.delete command succeeds and removes the window", () => {
    const { executor, windows } = makeWindowExecutor();

    const added = executor.execute({ type: "window.add", window: {} });
    const id = added.objectId as WindowId;

    const result = executor.execute({ type: "window.delete", id });

    assertTrue(result.success, "result.success");
    assertEqual(windows.get(id), undefined, "window should be gone");
  });

  check("a valid window.duplicate command succeeds and creates an independent window", () => {
    const { executor, windows } = makeWindowExecutor();

    const added = executor.execute({ type: "window.add", window: { width: 1.3, color: "#123456" } });
    const originalId = added.objectId as WindowId;

    const result = executor.execute({ type: "window.duplicate", id: originalId });

    assertTrue(result.success, "result.success");
    assertTrue(!!result.objectId, "result.objectId should be set");
    assertTrue(result.objectId !== originalId, "duplicate should have a different id");
    const duplicate = windows.get(result.objectId as WindowId);
    assertTrue(duplicate, "duplicate should be stored");
    assertEqual(duplicate.dimensions.width, 1.3, "duplicate width matches source");
    assertEqual(duplicate.color, "#123456", "duplicate color matches source");
    assertTrue(windows.get(originalId) !== undefined, "original window should still exist");
  });

  check("window.update with a missing id is rejected", () => {
    const { executor } = makeWindowExecutor();
    const result = executor.execute({ type: "window.update", changes: { color: "#000000" } });
    assertEqual(result.success, false, "result.success");
  });

  check("window.delete with a missing id is rejected", () => {
    const { executor } = makeWindowExecutor();
    assertEqual(executor.execute({ type: "window.delete" }).success, false, "result.success");
  });

  check("window.add with invalid dimensions is rejected and reports field errors", () => {
    const { executor, windows } = makeWindowExecutor();

    const result = executor.execute({ type: "window.add", window: { width: 0 } });

    assertEqual(result.success, false, "result.success");
    assertTrue(
      result.errors && result.errors.some((e) => e.field === "dimensions.width"),
      "expected a dimensions.width error"
    );
    assertEqual(windows.getAll().length, 0, "nothing should have been stored");
  });

  check("an invalid window.update preserves the existing window", () => {
    const { executor, windows } = makeWindowExecutor();

    const added = executor.execute({ type: "window.add", window: {} });
    const id = added.objectId as WindowId;
    const before = windows.get(id);

    const result = executor.execute({
      type: "window.update",
      id,
      changes: { dimensions: { ...before!.dimensions, thickness: -1 } }
    });

    assertEqual(result.success, false, "result.success");
    assertDeepEqual(windows.get(id), before, "window should be byte-for-byte unchanged");
  });

  check("successful window commands are recorded as history (via the WindowHistoryLike stub)", () => {
    const wallStoreStub = new WallStore();
    const wallHistory = makeWallHistoryStub(wallStoreStub);
    const windows = new WindowStore();
    const windowHistory = makeWindowHistoryStub(windows);
    const executor = new CommandExecutor(
      wallStoreStub,
      wallHistory,
      new AssemblyStore(),
      new PillarStore(),
      undefined,
      new BeamStore(),
      undefined,
      new SlabStore(),
      undefined,
      new DoorStore(),
      undefined,
      windows,
      windowHistory
    );

    assertEqual(windowHistory.recordedCount, 0, "no history yet");

    const added = executor.execute({ type: "window.add", window: {} });
    assertEqual(windowHistory.recordedCount, 1, "a valid add() should record history");

    executor.execute({ type: "window.update", id: added.objectId as WindowId, changes: { color: "#abcdef" } });
    assertEqual(windowHistory.recordedCount, 2, "a valid update() should record history");
  });

  check("failed window commands create no history entry (via the WindowHistoryLike stub)", () => {
    const wallStoreStub = new WallStore();
    const wallHistory = makeWallHistoryStub(wallStoreStub);
    const windows = new WindowStore();
    const windowHistory = makeWindowHistoryStub(windows);
    const executor = new CommandExecutor(
      wallStoreStub,
      wallHistory,
      new AssemblyStore(),
      new PillarStore(),
      undefined,
      new BeamStore(),
      undefined,
      new SlabStore(),
      undefined,
      new DoorStore(),
      undefined,
      windows,
      windowHistory
    );

    executor.execute({ type: "window.add", window: { width: -1 } });
    assertEqual(windowHistory.recordedCount, 0, "an invalid add() should not record history");

    const added = executor.execute({ type: "window.add", window: {} });
    assertEqual(windowHistory.recordedCount, 1, "sanity: the valid add() above should have recorded");

    executor.execute({
      type: "window.update",
      id: added.objectId as WindowId,
      changes: { rotation: Infinity }
    });
    assertEqual(windowHistory.recordedCount, 1, "an invalid update() should not record additional history");

    executor.execute({ type: "window.update", id: "does-not-exist", changes: { color: "#000000" } });
    assertEqual(windowHistory.recordedCount, 1, "an update() for a missing id should not record history");
  });

  // --- Assembly commands ---

  function makeAssemblyExecutor(): { executor: CommandExecutor; assemblies: AssemblyStore } {
    const wallStoreStub = new WallStore();
    const history = makeWallHistoryStub(wallStoreStub);
    const assemblies = new AssemblyStore();
    return { executor: new CommandExecutor(wallStoreStub, history, assemblies), assemblies };
  }

  check("a valid assembly.create command succeeds and stores an assembly", () => {
    const { executor, assemblies } = makeAssemblyExecutor();

    const result = executor.execute({ type: "assembly.create", assembly: { name: "Ground Floor" } });

    assertTrue(result.success, "result.success");
    assertTrue(!!result.objectId, "result.objectId should be set");
    assertEqual(assemblies.get(result.objectId as string)?.name, "Ground Floor", "stored name");
  });

  check("assembly.create with no name is rejected", () => {
    const { executor, assemblies } = makeAssemblyExecutor();

    const result = executor.execute({ type: "assembly.create", assembly: {} });

    assertEqual(result.success, false, "result.success");
    assertEqual(assemblies.getAll().length, 0, "nothing should have been stored");
  });

  check("a valid assembly.update command succeeds and applies the change", () => {
    const { executor, assemblies } = makeAssemblyExecutor();
    const created = executor.execute({ type: "assembly.create", assembly: { name: "Ground Floor" } });
    const id = created.objectId as string;

    const result = executor.execute({ type: "assembly.update", id, changes: { name: "Renamed" } });

    assertTrue(result.success, "result.success");
    assertEqual(assemblies.get(id)?.name, "Renamed", "stored name after update");
  });

  check("assembly.update always sets updatedAt to the current time, ignoring a caller-supplied value", () => {
    const { executor, assemblies } = makeAssemblyExecutor();
    const created = executor.execute({ type: "assembly.create", assembly: { name: "Ground Floor" } });
    const id = created.objectId as string;
    const originalUpdatedAt = assemblies.get(id)!.updatedAt;

    executor.execute({ type: "assembly.update", id, changes: { name: "Renamed", updatedAt: 1 } });

    assertTrue((assemblies.get(id)?.updatedAt ?? 0) >= originalUpdatedAt, "updatedAt should not go backwards");
  });

  check("an invalid assembly.update preserves the existing assembly", () => {
    const { executor, assemblies } = makeAssemblyExecutor();
    const created = executor.execute({
      type: "assembly.create",
      assembly: { name: "Ground Floor", objectIds: ["wall-1"] }
    });
    const id = created.objectId as string;
    const before = assemblies.get(id);

    const result = executor.execute({ type: "assembly.update", id, changes: { objectIds: ["wall-1", "wall-1"] } });

    assertEqual(result.success, false, "result.success");
    assertDeepEqual(assemblies.get(id), before, "assembly should be byte-for-byte unchanged");
  });

  check("a valid assembly.delete command succeeds and removes the assembly", () => {
    const { executor, assemblies } = makeAssemblyExecutor();
    const created = executor.execute({ type: "assembly.create", assembly: { name: "Ground Floor" } });
    const id = created.objectId as string;

    const result = executor.execute({ type: "assembly.delete", id });

    assertTrue(result.success, "result.success");
    assertEqual(assemblies.get(id), undefined, "assembly should be gone");
  });

  check("assembly.delete with a missing id is rejected", () => {
    const { executor } = makeAssemblyExecutor();
    assertEqual(executor.execute({ type: "assembly.delete", id: "does-not-exist" }).success, false, "result.success");
  });

  check("assembly.addObject adds an object id", () => {
    const { executor, assemblies } = makeAssemblyExecutor();
    const created = executor.execute({ type: "assembly.create", assembly: { name: "Ground Floor" } });
    const id = created.objectId as string;

    const result = executor.execute({ type: "assembly.addObject", assemblyId: id, objectId: "wall-1" });

    assertTrue(result.success, "result.success");
    assertDeepEqual(assemblies.get(id)?.objectIds, ["wall-1"], "objectIds after addObject");
  });

  check("assembly.addObject rejects adding a duplicate object id", () => {
    const { executor, assemblies } = makeAssemblyExecutor();
    const created = executor.execute({
      type: "assembly.create",
      assembly: { name: "Ground Floor", objectIds: ["wall-1"] }
    });
    const id = created.objectId as string;

    const result = executor.execute({ type: "assembly.addObject", assemblyId: id, objectId: "wall-1" });

    assertEqual(result.success, false, "result.success");
    assertDeepEqual(assemblies.get(id)?.objectIds, ["wall-1"], "objectIds should be unchanged");
  });

  check("assembly.removeObject removes an object id", () => {
    const { executor, assemblies } = makeAssemblyExecutor();
    const created = executor.execute({
      type: "assembly.create",
      assembly: { name: "Ground Floor", objectIds: ["wall-1", "wall-2"] }
    });
    const id = created.objectId as string;

    const result = executor.execute({ type: "assembly.removeObject", assemblyId: id, objectId: "wall-1" });

    assertTrue(result.success, "result.success");
    assertDeepEqual(assemblies.get(id)?.objectIds, ["wall-2"], "objectIds after removeObject");
  });

  check("assembly.removeObject rejects removing an object id that isn't present", () => {
    const { executor, assemblies } = makeAssemblyExecutor();
    const created = executor.execute({ type: "assembly.create", assembly: { name: "Ground Floor" } });
    const id = created.objectId as string;

    const result = executor.execute({ type: "assembly.removeObject", assemblyId: id, objectId: "wall-1" });

    assertEqual(result.success, false, "result.success");
    assertDeepEqual(assemblies.get(id)?.objectIds, [], "objectIds should be unchanged");
  });

  check("an unknown command type is still rejected the same way with assemblyStore present", () => {
    const { executor } = makeAssemblyExecutor();
    assertEqual(executor.execute({ type: "assembly.frobnicate" }).success, false, "result.success");
  });

  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) {
    throw new Error(`${failed} verification check(s) failed`);
  }
}

run();
