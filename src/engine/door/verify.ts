/**
 * Lightweight in-memory verification for door validation -
 * validateDoor() directly, and DoorStore's integration of it
 * (rejecting invalid add()/update()/set(), leaving prior state
 * untouched, not notifying subscribers), plus duplicate-id rejection
 * and height-grounding. Mirrors src/engine/beam/verify.ts and
 * src/engine/slab/verify.ts exactly - same approach: no test
 * framework, plain assertion helpers, run directly by Node. Run with:
 *   npm run verify
 * or directly:
 *   node src/engine/door/verify.ts
 *
 * DoorHistoryController is intentionally NOT exercised here - its
 * constructor uses TypeScript parameter-property shorthand, which
 * Node's native TypeScript support cannot run directly (only erasable
 * syntax is supported). That requirement (undo/redo for door
 * add/update/delete/duplicate) is instead verified in the browser,
 * against the real compiled module - see the implementation report.
 *
 * Explicit .ts extensions below are required for Node's native
 * TypeScript support to resolve these relative imports (see
 * allowImportingTsExtensions in tsconfig.json) - this file is run
 * directly by Node, not bundled by Vite.
 */
import { validateDoor } from "./validateDoor.ts";
import { createDoorData } from "./createDoor.ts";
import { DoorStore } from "./DoorStore.ts";

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

function hasError(result: { errors: { field: string }[] }, field: string): boolean {
  return result.errors.some((error) => error.field === field);
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

  console.log("Door validation verification\n");

  // --- validateDoor() directly ---

  check("a freshly created door is valid", () => {
    assertTrue(validateDoor(createDoorData()).valid, "createDoorData() output should validate");
  });

  check("zero width is rejected", () => {
    const door = createDoorData();
    door.dimensions.width = 0;
    const result = validateDoor(door);
    assertEqual(result.valid, false, "valid");
    assertTrue(hasError(result, "dimensions.width"), "expected a dimensions.width error");
  });

  check("negative height is rejected", () => {
    const door = createDoorData();
    door.dimensions.height = -0.2;
    const result = validateDoor(door);
    assertEqual(result.valid, false, "valid");
    assertTrue(hasError(result, "dimensions.height"), "expected a dimensions.height error");
  });

  check("zero or negative thickness is rejected", () => {
    const door = createDoorData();
    door.dimensions.thickness = 0;
    const result = validateDoor(door);
    assertEqual(result.valid, false, "valid");
    assertTrue(hasError(result, "dimensions.thickness"), "expected a dimensions.thickness error");
  });

  check("NaN dimensions/position/rotation are all rejected together", () => {
    const door = createDoorData();
    door.dimensions.height = NaN;
    door.position.x = NaN;
    door.rotation = NaN;
    const result = validateDoor(door);
    assertEqual(result.valid, false, "valid");
    assertTrue(hasError(result, "dimensions.height"), "expected a dimensions.height error");
    assertTrue(hasError(result, "position.x"), "expected a position.x error");
    assertTrue(hasError(result, "rotation"), "expected a rotation error");
  });

  check("Infinity position and dimensions are rejected", () => {
    const door = createDoorData();
    door.position.z = Infinity;
    door.dimensions.width = -Infinity;
    const result = validateDoor(door);
    assertEqual(result.valid, false, "valid");
    assertTrue(hasError(result, "position.z"), "expected a position.z error");
    assertTrue(hasError(result, "dimensions.width"), "expected a dimensions.width error");
  });

  check("non-finite rotation is rejected", () => {
    const door = createDoorData();
    door.rotation = Infinity;
    const result = validateDoor(door);
    assertEqual(result.valid, false, "valid");
    assertTrue(hasError(result, "rotation"), "expected a rotation error");
  });

  check("empty id is rejected", () => {
    const door = createDoorData();
    door.id = "";
    assertEqual(validateDoor(door).valid, false, "valid");
  });

  check("a non-door type is rejected", () => {
    const door = createDoorData();
    (door as { type: string }).type = "wall";
    assertEqual(validateDoor(door).valid, false, "valid");
  });

  check("a non-hex color is rejected", () => {
    const door = createDoorData();
    door.color = "blue";
    assertEqual(validateDoor(door).valid, false, "valid");
  });

  check("a valid 6-digit hex color is accepted", () => {
    assertTrue(validateDoor(createDoorData({ color: "#123ABC" })).valid, "6-digit hex should validate");
  });

  check("an empty material is rejected", () => {
    const door = createDoorData();
    door.material = "";
    const result = validateDoor(door);
    assertEqual(result.valid, false, "valid");
    assertTrue(hasError(result, "material"), "expected a material error");
  });

  check("a null assemblyId is accepted", () => {
    const door = createDoorData();
    door.assemblyId = null;
    assertTrue(validateDoor(door).valid, "null assemblyId should validate");
  });

  check("a non-empty string assemblyId is accepted", () => {
    const door = createDoorData();
    door.assemblyId = "assembly-1";
    assertTrue(validateDoor(door).valid, "a real assemblyId should validate");
  });

  check("an empty string assemblyId is rejected", () => {
    const door = createDoorData();
    door.assemblyId = "";
    const result = validateDoor(door);
    assertEqual(result.valid, false, "valid");
    assertTrue(hasError(result, "assemblyId"), "expected an assemblyId error");
  });

  // --- DoorStore integration ---

  check("DoorStore.add() accepts a valid door", () => {
    const store = new DoorStore();
    const door = createDoorData();
    const result = store.add(door);
    assertTrue(result.valid, "add() result.valid");
    assertDeepEqual(store.get(door.id), door, "get() after a valid add()");
  });

  check("DoorStore.add() rejects an invalid door and stores nothing", () => {
    const store = new DoorStore();
    const door = createDoorData();
    door.dimensions.width = 0;
    const result = store.add(door);
    assertEqual(result.valid, false, "add() result.valid");
    assertEqual(store.get(door.id), undefined, "invalid door should not be stored");
  });

  check("DoorStore.add() rejects a duplicate id", () => {
    const store = new DoorStore();
    const door = createDoorData();
    store.add(door);

    const collidingDoor = { ...createDoorData(), id: door.id };
    const result = store.add(collidingDoor);

    assertEqual(result.valid, false, "duplicate add() result.valid");
    assertTrue(hasError(result, "id"), "expected an id error");
    assertDeepEqual(store.get(door.id), door, "the original door should be unchanged");
  });

  check("DoorStore.add() rejecting a door does not notify subscribers", () => {
    const store = new DoorStore();
    let notifiedCount = -1;
    store.subscribe((doors) => {
      notifiedCount = doors.length;
    });
    assertEqual(notifiedCount, 0, "initial subscribe callback");

    const door = createDoorData();
    door.dimensions.height = NaN;
    store.add(door);
    assertEqual(notifiedCount, 0, "notifiedCount should be unchanged after a rejected add()");
  });

  check("DoorStore.update() rejects a merge that would be invalid, preserving the previous door", () => {
    const store = new DoorStore();
    const door = createDoorData();
    store.add(door);
    const before = store.get(door.id);

    const result = store.update(door.id, { dimensions: { ...door.dimensions, thickness: -1 } });

    assertEqual(result.valid, false, "update() result.valid");
    assertDeepEqual(store.get(door.id), before, "door should be byte-for-byte unchanged after a rejected update()");
  });

  check("DoorStore.update() rejecting a change does not notify subscribers", () => {
    const store = new DoorStore();
    const door = createDoorData();
    store.add(door);

    let notifiedCount = -1;
    store.subscribe((doors) => {
      notifiedCount = doors.length;
    });
    assertEqual(notifiedCount, 1, "initial subscribe callback");

    store.update(door.id, { rotation: Infinity });
    assertEqual(notifiedCount, 1, "notifiedCount should be unchanged after a rejected update()");
  });

  check("DoorStore.update() on a missing id is rejected without throwing", () => {
    const store = new DoorStore();
    const result = store.update("does-not-exist", { color: "#000000" });
    assertEqual(result.valid, false, "update() on a missing id should be invalid");
  });

  check("DoorStore.set() rejects an invalid door, preserving the previous one", () => {
    const store = new DoorStore();
    const door = createDoorData();
    store.add(door);

    const result = store.set(door.id, { ...door, color: "not-a-color" });

    assertEqual(result.valid, false, "set() result.valid");
    assertDeepEqual(store.get(door.id), door, "door should be unchanged after a rejected set()");
  });

  check("height-grounding behavior matches the sibling types', through a valid update()", () => {
    const store = new DoorStore();
    const door = createDoorData(); // default height 2.1 -> position.y 1.05
    store.add(door);

    const result = store.update(door.id, { dimensions: { ...door.dimensions, height: 2.4 } });
    assertTrue(result.valid, "a valid height update should be accepted");
    assertEqual(store.get(door.id)?.position.y, 1.2, "position.y should be re-derived to height / 2");
  });

  check("an explicit position with a height change is respected (no auto-grounding)", () => {
    const store = new DoorStore();
    const door = createDoorData();
    store.add(door);

    const result = store.update(door.id, {
      dimensions: { ...door.dimensions, height: 2.4 },
      position: { x: 1, y: 3, z: 1 }
    });
    assertTrue(result.valid, "a valid update with an explicit position should be accepted");
    assertEqual(store.get(door.id)?.position.y, 3, "explicit position.y should win over auto-grounding");
  });

  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) {
    throw new Error(`${failed} verification check(s) failed`);
  }
}

run();
