/**
 * Unit verification for mouse manipulation: the pure gesture math
 * (manipulationMath.ts), HistoryManager's gesture groups, and
 * ObjectManipulator driving a real CommandExecutor over real stores.
 * Same approach as every other verify.ts in this project: no test
 * framework, plain assertion helpers, run directly by Node. Run with:
 *   npm run verify
 * or directly:
 *   node src/engine/manipulation/verify.ts
 *
 * The real *HistoryController classes can't run under Node's strip-only
 * TypeScript (parameter-property constructors - see
 * src/engine/commands/verify.ts), so wall history here uses the same
 * store-backed stand-in pattern as ai/verify.ts, recording into a real
 * HistoryManager. The fully real path - createProjectContext(), real
 * history controllers - is covered in src/engine/ai/e2e/verify.ts.
 *
 * Explicit .ts extensions below are required for Node's native
 * TypeScript support to resolve these relative imports.
 */
// "node:fs"/"node:url" below are typed by src/node-builtins.d.ts, a
// minimal shared ambient shim - see that file for why it exists.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  computeMove,
  computeResize,
  computeRotation,
  dimensionForAxis,
  layoutHandles,
  localAxis,
  MOVE_STEP,
  RESIZE_STEP,
  ROTATE_STEP,
  snapToStep
} from "./manipulationMath.ts";
import { createStoreObjectReader, ObjectManipulator } from "./ObjectManipulator.ts";
import { HistoryManager } from "../history/HistoryManager.ts";
import { CommandExecutor } from "../commands/CommandExecutor.ts";
import { WallStore } from "../wall/WallStore.ts";
import { PillarStore } from "../pillar/PillarStore.ts";
import { BeamStore } from "../beam/BeamStore.ts";
import { SlabStore } from "../slab/SlabStore.ts";
import { DoorStore } from "../door/DoorStore.ts";
import { WindowStore } from "../window/WindowStore.ts";
import { AssemblyStore } from "../assemblies/AssemblyStore.ts";
import type { WallData, WallId } from "../wall/types.ts";
import type { WallValidationResult } from "../wall/validateWall.ts";
import type { CommandResult, WallHistoryLike } from "../commands/types.ts";

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

function assertSameJson(actual: unknown, expected: unknown, message: string): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`${message}: expected ${expectedJson}, got ${actualJson}`);
  }
}

function assertClose(actual: number, expected: number, message: string, tolerance = 1e-9): void {
  if (!(Math.abs(actual - expected) <= tolerance)) {
    throw new Error(`${message}: expected ${expected} (within ${tolerance}), got ${actual}`);
  }
}

/** A WallHistoryLike stand-in that records real undo/redo pairs on a real HistoryManager - what WallHistoryController does, without its parameter-property constructor. */
function makeUndoableWallHistory(store: WallStore, history: HistoryManager): WallHistoryLike {
  return {
    add(wall: WallData): WallValidationResult {
      const result = store.add(wall);
      if (result.valid) {
        history.record({ undo: () => store.remove(wall.id), redo: () => store.add(wall) });
      }
      return result;
    },
    update(id: WallId, changes: Parameters<WallHistoryLike["update"]>[1]): WallValidationResult {
      const before = store.get(id);
      const result = store.update(id, changes);
      const after = store.get(id);
      if (result.valid && before && after) {
        history.record({ undo: () => store.set(id, before), redo: () => store.set(id, after) });
      }
      return result;
    },
    remove(id: WallId): void {
      store.remove(id);
    }
  };
}

/** Real stores, a real CommandExecutor, a real HistoryManager (wall history recorded), and an ObjectManipulator over them. */
function makeEngine() {
  const history = new HistoryManager();
  const wallStore = new WallStore();
  const pillarStore = new PillarStore();
  const beamStore = new BeamStore();
  const slabStore = new SlabStore();
  const doorStore = new DoorStore();
  const windowStore = new WindowStore();
  const assemblyStore = new AssemblyStore();
  const executor = new CommandExecutor(
    wallStore,
    makeUndoableWallHistory(wallStore, history),
    assemblyStore,
    pillarStore,
    undefined,
    beamStore,
    undefined,
    slabStore,
    undefined,
    doorStore,
    undefined,
    windowStore
  );
  const stores = { wallStore, pillarStore, beamStore, slabStore, doorStore, windowStore };
  const manipulator = new ObjectManipulator({ commandExecutor: executor, history, readObject: createStoreObjectReader(stores) });
  return { history, executor, stores, assemblyStore, manipulator };
}

function addObject(executor: CommandExecutor, command: Record<string, unknown>): string {
  const result = executor.execute(command);
  assertTrue(result.success && typeof result.objectId === "string", `setup failed: ${JSON.stringify(result)}`);
  return result.objectId as string;
}

const point = (x: number, y: number, z: number) => ({ x, y, z });

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

  console.log("Object manipulation verification\n");

  // --- E. Snapping ---

  check("E. snapToStep rounds to the nearest whole increment, free of float noise", () => {
    assertEqual(snapToStep(0.26, 0.1), 0.3, "0.26 -> 0.3");
    assertEqual(snapToStep(0.24, 0.1), 0.2, "0.24 -> 0.2");
    assertEqual(snapToStep(-0.26, 0.1), -0.3, "-0.26 -> -0.3");
    assertEqual(snapToStep(0.04, 0.1), 0, "below half a step -> 0");
    assertEqual(snapToStep(0.1 + 0.2, 0.1), 0.3, "0.1 + 0.2 is exactly 0.3, not 0.30000000000000004");
    assertEqual(snapToStep(-0.04, 0.1), 0, "never -0");
    assertTrue(!Object.is(snapToStep(-0.04, 0.1), -0), "not negative zero");
    assertEqual(MOVE_STEP, 0.1, "move increment");
    assertEqual(RESIZE_STEP, 0.1, "resize increment");
    assertClose(ROTATE_STEP, Math.PI / 180, "rotate increment is 1 degree");
  });

  // --- A. Move ---

  check("A. move follows the pointer's X/Z travel in 0.1 m increments and never changes Y", () => {
    const moved = computeMove(point(0, 1.35, 0), point(1, 0.5, 1), point(3.04, 0.5, -0.96));
    assertSameJson(moved, { x: 2, y: 1.35, z: -2 }, "travel (2.04, -1.96) snaps to (2, -2)");
  });

  check("A. move is relative to the grab - an off-grid object keeps its offset, and a tiny drag changes nothing", () => {
    assertSameJson(computeMove(point(0.05, 1.35, 0.33), point(0, 0, 0), point(0.26, 0, 0)), { x: 0.35, y: 1.35, z: 0.33 }, "0.05 + 0.3");
    assertSameJson(computeMove(point(1, 1.35, 1), point(0, 0, 0), point(0.04, 0, -0.04)), { x: 1, y: 1.35, z: 1 }, "under half a step");
  });

  // --- B. Resize ---

  const wall0 = { position: point(0, 1.35, 0), rotation: 0, dimensions: { height: 2.7, length: 4, thickness: 0.2 } };

  check("B. dragging a wall's +X handle 1 m makes it 5 m long, with the -X face fixed", () => {
    const resized = computeResize(wall0, { axis: "x", side: 1, dimension: "length" }, point(2.25, 1.35, 0), point(3.25, 1.35, 0));
    assertSameJson(resized.dimensions, { length: 5 }, "length");
    assertSameJson(resized.position, { x: 0.5, y: 1.35, z: 0 }, "center moves half the change - left face stays at x = -2");
  });

  check("B. dragging the -X handle outward also grows the wall, with the +X face fixed", () => {
    const resized = computeResize(wall0, { axis: "x", side: -1, dimension: "length" }, point(-2.25, 1.35, 0), point(-3.25, 1.35, 0));
    assertSameJson(resized.dimensions, { length: 5 }, "length");
    assertSameJson(resized.position, { x: -0.5, y: 1.35, z: 0 }, "right face stays at x = 2");
  });

  check("B. on a wall rotated 90 degrees, the length handle works along its rotated axis (world -Z)", () => {
    const turned = { ...wall0, rotation: Math.PI / 2 };
    const axis = localAxis(Math.PI / 2, "x");
    assertClose(axis.x, 0, "local X has no world X");
    assertClose(axis.z, -1, "local X points along world -Z");

    const resized = computeResize(turned, { axis: "x", side: 1, dimension: "length" }, point(0, 1.35, -2.25), point(0, 1.35, -3.25));
    assertSameJson(resized.dimensions, { length: 5 }, "length");
    assertClose(resized.position.x, 0, "no X shift");
    assertClose(resized.position.z, -0.5, "center shifts half the change along world -Z");
  });

  check("B. the top handle changes the height with the bottom fixed - an explicit Y, so a raised object isn't re-grounded", () => {
    const raisedWindow = { position: point(0, 1.5, 0), rotation: 0, dimensions: { height: 1.2, thickness: 0.05, width: 1.2 } };
    const resized = computeResize(raisedWindow, { axis: "y", side: 1, dimension: "height" }, point(0, 2.35, 0), point(0, 2.85, 0));
    assertSameJson(resized.dimensions, { height: 1.7 }, "height grows by the 0.5 m drag");
    assertSameJson(resized.position, { x: 0, y: 1.75, z: 0 }, "bottom stays at 0.9");
  });

  check("B. a drag past the opposite face yields a non-positive size - returned as-is for validation to reject", () => {
    const resized = computeResize(wall0, { axis: "x", side: 1, dimension: "length" }, point(2.25, 1.35, 0), point(-2.75, 1.35, 0));
    assertEqual(resized.dimensions.length, -1, "4 - 5 = -1, not clamped");
  });

  check("B. every type's handles map to its real dimensions - the verified mesh-builder mapping", () => {
    const expected: Record<string, [string, string, string]> = {
      wall: ["length", "height", "thickness"],
      pillar: ["width", "height", "depth"],
      beam: ["length", "height", "width"],
      slab: ["length", "thickness", "width"],
      door: ["width", "height", "thickness"],
      window: ["width", "height", "thickness"]
    };
    for (const [type, [x, y, z]] of Object.entries(expected)) {
      assertEqual(dimensionForAxis(type, "x"), x, `${type} X`);
      assertEqual(dimensionForAxis(type, "y"), y, `${type} Y`);
      assertEqual(dimensionForAxis(type, "z"), z, `${type} Z`);
    }
    assertEqual(dimensionForAxis("roof", "x"), undefined, "no mapping for a type that has none");
  });

  check("B. handle layout: two handles on X, two on Z, one on top, a ring at the base - each tied to a real dimension", () => {
    const layout = layoutHandles({ type: "pillar", dimensions: { depth: 0.8, height: 3, width: 0.4 } });
    assertTrue(layout, "a pillar gets handles");
    assertSameJson(
      layout.resize.map((handle) => `${handle.axis}${handle.side > 0 ? "+" : "-"}:${handle.dimension}`),
      ["x+:width", "x-:width", "z+:depth", "z-:depth", "y+:height"],
      "handles"
    );
    assertSameJson(layout.resize[0].position, { x: 0.55, y: -1.35, z: 0 }, "outside the +X face (0.2 + 0.35), on the base plane lifted 0.15");
    assertSameJson(layout.resize[2].position, { x: 0, y: -1.35, z: 0.75 }, "outside the +Z face (0.4 + 0.35), on the base plane");
    assertSameJson(layout.resize[4].position, { x: 0, y: 1.85, z: 0 }, "above the top (1.5 + 0.35)");
    const ring = layout.rotate;
    assertTrue(ring, "a pillar gets a rotation ring");
    assertEqual(ring.y, -1.5, "ring at the base");
    assertClose(ring.radius, Math.hypot(0.2, 0.4) + 0.8, "ring clears the corners");
    assertSameJson(layout.endpoints, [], "no endpoint handles - it isn't a linear element");
    for (const handle of layout.resize.slice(0, 4)) {
      const reach = Math.hypot(handle.position.x, handle.position.z);
      // 0.2 m handle hit sphere + 0.25 m ring hit band (src/scene/manipulation/ManipulationHandles.ts) never overlap.
      assertTrue(ring.radius - reach >= 0.2 + 0.25, `side handle ${handle.axis}${handle.side} stays clear of the ring`);
    }
    assertEqual(layoutHandles({ type: "roof", dimensions: { length: 4 } }), null, "no handles for an unknown type");
    assertEqual(layoutHandles({ type: "wall", dimensions: { height: 2.7, length: 0, thickness: 0.2 } }), null, "no handles on a degenerate shape");
  });

  // --- C. Rotation ---

  check("C. sweeping the pointer a quarter turn around the center rotates by 90 degrees", () => {
    const rotated = computeRotation({ position: point(0, 0, 0), rotation: 0 }, point(2, 0, 0), point(0, 0, -2));
    assertClose(rotated, Math.PI / 2, "+X to -Z is +90 degrees in the app's rotation convention");
  });

  check("C. rotation is relative to the object's current rotation, and snaps to whole degrees", () => {
    const rotated = computeRotation({ position: point(1, 0, 1), rotation: 0.5 }, point(3, 0, 1), point(1, 0, -1));
    assertClose(rotated, 0.5 + Math.PI / 2, "0.5 rad + 90 degrees");
    const nudged = computeRotation({ position: point(0, 0, 0), rotation: 0 }, point(1, 0, 0), point(1, 0, -Math.tan((10.4 * Math.PI) / 180)));
    assertClose(nudged, (10 * Math.PI) / 180, "10.4 degrees snaps to 10");
  });

  check("C. crossing +/-180 degrees takes the short way round, and a pointer on the center changes nothing", () => {
    const at = (degrees: number) => point(Math.cos((degrees * Math.PI) / 180), 0, -Math.sin((degrees * Math.PI) / 180));
    const rotated = computeRotation({ position: point(0, 0, 0), rotation: 0 }, at(170), at(-170));
    assertClose(rotated, (20 * Math.PI) / 180, "+20 degrees, not -340");
    assertEqual(computeRotation({ position: point(0, 0, 0), rotation: 0.3 }, point(1, 0, 0), point(0, 0, 0)), 0.3, "unchanged");
  });

  // --- HistoryManager groups ---

  function counter() {
    const log: string[] = [];
    const command = (name: string) => ({ undo: () => log.push(`undo ${name}`), redo: () => log.push(`redo ${name}`) });
    return { log, command };
  }

  check("F. a group of recorded commands becomes one undo entry: undo newest first, redo oldest first", () => {
    const history = new HistoryManager();
    const { log, command } = counter();

    history.beginGroup();
    history.record(command("a"));
    history.record(command("b"));
    history.record(command("c"));
    assertEqual(history.canUndo(), false, "nothing on the stack until the group ends");
    history.endGroup();

    assertEqual(history.canUndo(), true, "one entry");
    history.undo();
    assertSameJson(log, ["undo c", "undo b", "undo a"], "one undo reverses the whole group");
    assertEqual(history.canUndo(), false, "and it was the only entry");
    history.redo();
    assertSameJson(log.slice(3), ["redo a", "redo b", "redo c"], "one redo replays it");
  });

  check("F. an empty group records nothing; ending a group clears the redo stack", () => {
    const history = new HistoryManager();
    const { command } = counter();
    history.beginGroup();
    history.endGroup();
    assertEqual(history.canUndo(), false, "empty group, no entry");

    history.record(command("a"));
    history.undo();
    assertEqual(history.canRedo(), true, "precondition: something to redo");
    history.beginGroup();
    history.record(command("b"));
    history.endGroup();
    assertEqual(history.canRedo(), false, "a new entry clears redo, as any record does");
  });

  check("F. cancelGroup undoes what the group collected and records nothing", () => {
    const history = new HistoryManager();
    const { log, command } = counter();
    history.record(command("before"));

    history.beginGroup();
    history.record(command("a"));
    history.record(command("b"));
    history.cancelGroup();

    assertSameJson(log, ["undo b", "undo a"], "rolled back, newest first");
    history.undo();
    assertSameJson(log.slice(2), ["undo before"], "the stack is exactly as before the group");
    assertEqual(history.canUndo(), false, "no entry for the cancelled group");
  });

  check("F. groups don't nest, and undo/redo wait while a group is open", () => {
    const history = new HistoryManager();
    const { log, command } = counter();
    history.record(command("a"));
    history.beginGroup();
    let threw = false;
    try {
      history.beginGroup();
    } catch {
      threw = true;
    }
    assertTrue(threw, "a second beginGroup throws");
    history.undo();
    assertSameJson(log, [], "undo ignored mid-group");
    assertEqual(history.isGrouping(), true, "still grouping");
    history.endGroup();
    assertEqual(history.isGrouping(), false, "closed");
  });

  // --- ObjectManipulator over real stores and a real CommandExecutor ---

  check("F/G. one move drag through the real engine is ONE history entry, and the wall keeps its id", () => {
    const { history, executor, stores, manipulator } = makeEngine();
    const wallId = addObject(executor, { type: "wall.add", wall: { position: { x: 0, z: 0 } } });
    history.clearHistory();

    assertTrue(manipulator.begin(wallId, { kind: "move" }, point(0, 1.35, 0)), "gesture started");
    for (const x of [0.5, 1.02, 1.7, 2.4, 3.3, 4.01]) {
      manipulator.update(point(x, 1.35, 0));
    }
    manipulator.end();

    assertSameJson(stores.wallStore.get(wallId)?.position, { x: 4, y: 1.35, z: 0 }, "moved to x = 4");
    assertEqual(stores.wallStore.getAll().length, 1, "still one wall");
    assertEqual(stores.wallStore.getAll()[0].id, wallId, "same id");

    history.undo();
    assertSameJson(stores.wallStore.get(wallId)?.position, { x: 0, y: 1.35, z: 0 }, "one undo returns straight to x = 0");
    assertEqual(history.canUndo(), false, "the whole drag was one entry");
    history.redo();
    assertSameJson(stores.wallStore.get(wallId)?.position, { x: 4, y: 1.35, z: 0 }, "one redo returns straight to x = 4");
  });

  check("D. a resize the validator rejects never reaches the store; the gesture keeps its last valid size", () => {
    const { history, executor, stores, manipulator } = makeEngine();
    const wallId = addObject(executor, { type: "wall.add", wall: {} });
    history.clearHistory();

    manipulator.begin(wallId, { kind: "resize", axis: "x", side: 1 }, point(2.25, 1.35, 0));
    const grown = manipulator.update(point(3.25, 1.35, 0));
    assertTrue(grown?.success, "5 m is valid");
    const crossed = manipulator.update(point(-2.75, 1.35, 0));
    assertTrue(crossed && !crossed.success, "-1 m is rejected by validateWall");
    assertEqual(stores.wallStore.get(wallId)?.dimensions.length, 5, "the store still holds the last valid length");
    const zero = manipulator.update(point(-1.75, 1.35, 0));
    assertTrue(zero && !zero.success, "0 m is rejected too");
    manipulator.end();

    assertEqual(stores.wallStore.get(wallId)?.dimensions.length, 5, "gesture ends on the last valid length");
    history.undo();
    assertEqual(stores.wallStore.get(wallId)?.dimensions.length, 4, "undo restores 4 m");
  });

  check("D. a gesture that only ever asks for invalid sizes changes nothing and records nothing", () => {
    const { history, executor, stores, manipulator } = makeEngine();
    const wallId = addObject(executor, { type: "wall.add", wall: {} });
    history.clearHistory();
    const before = JSON.stringify(stores.wallStore.get(wallId));

    manipulator.begin(wallId, { kind: "resize", axis: "z", side: 1 }, point(0, 1.35, 0.35));
    manipulator.update(point(0, 1.35, 0.05)); // thickness 0.2 - 0.3 < 0
    manipulator.end();

    assertEqual(JSON.stringify(stores.wallStore.get(wallId)), before, "wall unchanged");
    assertEqual(history.canUndo(), false, "no entry");
  });

  check("a press that never moves far enough records nothing; cancel restores the start exactly", () => {
    const { history, executor, stores, manipulator } = makeEngine();
    const wallId = addObject(executor, { type: "wall.add", wall: {} });
    history.clearHistory();
    const before = JSON.stringify(stores.wallStore.get(wallId));

    manipulator.begin(wallId, { kind: "move" }, point(0, 1.35, 0));
    manipulator.update(point(0.03, 1.35, 0.02));
    manipulator.end();
    assertEqual(history.canUndo(), false, "click without a real drag - no entry");

    manipulator.begin(wallId, { kind: "rotate" }, point(3, 0, 0));
    manipulator.update(point(0, 0, -3));
    assertTrue(stores.wallStore.get(wallId)?.rotation !== 0, "precondition: rotated mid-gesture");
    manipulator.cancel();
    assertEqual(JSON.stringify(stores.wallStore.get(wallId)), before, "cancel puts it back exactly");
    assertEqual(history.canUndo(), false, "and records nothing");
    assertEqual(history.isGrouping(), false, "the group is closed");
  });

  check("H. moving, resizing and rotating leave assembly membership untouched", () => {
    const { executor, assemblyStore, manipulator } = makeEngine();
    const wallId = addObject(executor, { type: "wall.add", wall: {} });
    const assemblyId = addObject(executor, { type: "assembly.create", assembly: { name: "Ground Floor" } });
    assertTrue(executor.execute({ type: "assembly.addObject", assemblyId, objectId: wallId }).success, "precondition: grouped");

    manipulator.begin(wallId, { kind: "move" }, point(0, 1.35, 0));
    manipulator.update(point(2, 1.35, 1));
    manipulator.end();
    manipulator.begin(wallId, { kind: "resize", axis: "x", side: 1 }, point(2.25, 1.35, 0));
    manipulator.update(point(3.25, 1.35, 0));
    manipulator.end();
    manipulator.begin(wallId, { kind: "rotate" }, point(3, 0, 0));
    manipulator.update(point(0, 0, -3));
    manipulator.end();

    assertSameJson(assemblyStore.get(assemblyId)?.objectIds, [wallId], "still exactly this wall");
  });

  check("B. resize through the real stores works for all six types, on their real dimensions", () => {
    const { executor, stores, manipulator } = makeEngine();
    const readObject = createStoreObjectReader(stores);

    for (const type of ["wall", "pillar", "beam", "slab", "door", "window"]) {
      const id = addObject(executor, { type: `${type}.add`, [type]: {} });
      const before = readObject(id);
      assertTrue(before, `${type} readable`);
      const xKey = dimensionForAxis(type, "x") as string;
      const yKey = dimensionForAxis(type, "y") as string;

      // +X handle, dragged 0.5 m along the object's (unrotated) X axis.
      assertTrue(manipulator.begin(id, { kind: "resize", axis: "x", side: 1 }, point(1, before.position.y, 0)), `${type}: begin X`);
      assertTrue(manipulator.update(point(1.5, before.position.y, 0))?.success, `${type}: X resize accepted`);
      manipulator.end();
      // Top handle, dragged 0.3 m up.
      assertTrue(manipulator.begin(id, { kind: "resize", axis: "y", side: 1 }, point(0, 5, 0)), `${type}: begin Y`);
      assertTrue(manipulator.update(point(0, 5.3, 0))?.success, `${type}: Y resize accepted`);
      manipulator.end();

      const after = readObject(id);
      assertTrue(after, `${type} still there`);
      assertClose(after.dimensions[xKey], before.dimensions[xKey] + 0.5, `${type}.${xKey} grew by 0.5`);
      assertClose(after.dimensions[yKey], before.dimensions[yKey] + 0.3, `${type}.${yKey} grew by 0.3`);
      const bottomBefore = before.position.y - before.dimensions[yKey] / 2;
      const bottomAfter = after.position.y - after.dimensions[yKey] / 2;
      assertClose(bottomAfter, bottomBefore, `${type}: the bottom stayed put`);
      assertEqual(after.id, id, `${type}: same id`);
    }
  });

  check("begin refuses an unknown id, a second gesture, and a resize on an axis the type has no dimension for", () => {
    const { history, executor, manipulator } = makeEngine();
    const wallId = addObject(executor, { type: "wall.add", wall: {} });

    assertEqual(manipulator.begin("wall-does-not-exist", { kind: "move" }, point(0, 0, 0)), false, "unknown id");
    assertEqual(history.isGrouping(), false, "no group opened for it");
    assertEqual(manipulator.begin(wallId, { kind: "move" }, point(0, 0, 0)), true, "first gesture");
    assertEqual(manipulator.begin(wallId, { kind: "rotate" }, point(0, 0, 0)), false, "second gesture while one runs");
    manipulator.end();
    assertEqual(manipulator.isActive(), false, "ended");
  });

  // --- I. Everything goes through the construction model ---

  check("I. the manipulator only ever issues update_object commands, and skips repeats of the same change", () => {
    const calls: unknown[] = [];
    const executorSpy = {
      execute(input: unknown): CommandResult {
        calls.push(input);
        return { success: true };
      }
    };
    const groups: string[] = [];
    const manipulator = new ObjectManipulator({
      commandExecutor: executorSpy,
      history: { beginGroup: () => groups.push("begin"), endGroup: () => groups.push("end"), cancelGroup: () => groups.push("cancel") },
      readObject: (id) => (id === "wall-1" ? { id, type: "wall", position: point(0, 1.35, 0), rotation: 0, dimensions: { height: 2.7, length: 4, thickness: 0.2 } } : undefined)
    });

    manipulator.begin("wall-1", { kind: "move" }, point(0, 1.35, 0));
    manipulator.update(point(1, 1.35, 0));
    manipulator.update(point(1.02, 1.35, 0)); // snaps to the same x = 1
    manipulator.update(point(2, 1.35, 0));
    manipulator.end();

    assertSameJson(
      calls,
      [
        { type: "update_object", objectId: "wall-1", changes: { position: { x: 1, y: 1.35, z: 0 } } },
        { type: "update_object", objectId: "wall-1", changes: { position: { x: 2, y: 1.35, z: 0 } } }
      ],
      "two commands, both update_object"
    );
    assertSameJson(groups, ["begin", "end"], "one history group around the gesture");
  });

  check("I. no manipulation code writes a store or a construction mesh directly", () => {
    const manipulatorSource = readFileSync(fileURLToPath(new URL("./ObjectManipulator.ts", import.meta.url)), "utf8");
    assertTrue(!/\.(add|update|set|remove)\(/.test(manipulatorSource.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")),
      "ObjectManipulator calls no store write method");

    const controllerSource = readFileSync(
      fileURLToPath(new URL("../../scene/manipulation/ManipulationController.ts", import.meta.url)),
      "utf8"
    );
    const controllerCode = controllerSource.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    for (const forbidden of [/\.position\.(set|copy|add|x\s*=|y\s*=|z\s*=)/, /\.rotation\.[xyz]\s*=/, /\.scale\./, /Store\b/, /\.execute\(/]) {
      assertTrue(!forbidden.test(controllerCode), `ManipulationController must not use ${forbidden}`);
    }
    assertTrue(/manipulator\.(begin|update|end|cancel)\(/.test(controllerCode), "the controller drives the model only through the manipulator");
  });

  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) {
    throw new Error(`${failed} verification check(s) failed`);
  }
}

run();
