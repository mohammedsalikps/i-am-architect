/**
 * Lightweight in-memory verification for window validation -
 * validateWindow() directly, and WindowStore's integration of it
 * (rejecting invalid add()/update()/set(), leaving prior state
 * untouched, not notifying subscribers), plus duplicate-id rejection
 * and height-grounding. Mirrors src/engine/door/verify.ts exactly -
 * same approach: no test framework, plain assertion helpers, run
 * directly by Node. Run with:
 *   npm run verify
 * or directly:
 *   node src/engine/window/verify.ts
 *
 * WindowHistoryController is intentionally NOT exercised here - its
 * constructor uses TypeScript parameter-property shorthand, which
 * Node's native TypeScript support cannot run directly (only erasable
 * syntax is supported). That requirement (undo/redo for window
 * add/update/delete/duplicate) is instead verified in the browser,
 * against the real compiled module - see the implementation report.
 *
 * Explicit .ts extensions below are required for Node's native
 * TypeScript support to resolve these relative imports (see
 * allowImportingTsExtensions in tsconfig.json) - this file is run
 * directly by Node, not bundled by Vite.
 */
import { validateWindow } from "./validateWindow.ts";
import { createWindowData } from "./createWindow.ts";
import { WindowStore } from "./WindowStore.ts";

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

  console.log("Window validation verification\n");

  // --- validateWindow() directly ---

  check("a freshly created window is valid", () => {
    assertTrue(validateWindow(createWindowData()).valid, "createWindowData() output should validate");
  });

  check("zero width is rejected", () => {
    const windowData = createWindowData();
    windowData.dimensions.width = 0;
    const result = validateWindow(windowData);
    assertEqual(result.valid, false, "valid");
    assertTrue(hasError(result, "dimensions.width"), "expected a dimensions.width error");
  });

  check("negative height is rejected", () => {
    const windowData = createWindowData();
    windowData.dimensions.height = -0.2;
    const result = validateWindow(windowData);
    assertEqual(result.valid, false, "valid");
    assertTrue(hasError(result, "dimensions.height"), "expected a dimensions.height error");
  });

  check("zero or negative thickness is rejected", () => {
    const windowData = createWindowData();
    windowData.dimensions.thickness = 0;
    const result = validateWindow(windowData);
    assertEqual(result.valid, false, "valid");
    assertTrue(hasError(result, "dimensions.thickness"), "expected a dimensions.thickness error");
  });

  check("NaN dimensions/position/rotation are all rejected together", () => {
    const windowData = createWindowData();
    windowData.dimensions.height = NaN;
    windowData.position.x = NaN;
    windowData.rotation = NaN;
    const result = validateWindow(windowData);
    assertEqual(result.valid, false, "valid");
    assertTrue(hasError(result, "dimensions.height"), "expected a dimensions.height error");
    assertTrue(hasError(result, "position.x"), "expected a position.x error");
    assertTrue(hasError(result, "rotation"), "expected a rotation error");
  });

  check("Infinity position and dimensions are rejected", () => {
    const windowData = createWindowData();
    windowData.position.z = Infinity;
    windowData.dimensions.width = -Infinity;
    const result = validateWindow(windowData);
    assertEqual(result.valid, false, "valid");
    assertTrue(hasError(result, "position.z"), "expected a position.z error");
    assertTrue(hasError(result, "dimensions.width"), "expected a dimensions.width error");
  });

  check("non-finite rotation is rejected", () => {
    const windowData = createWindowData();
    windowData.rotation = Infinity;
    const result = validateWindow(windowData);
    assertEqual(result.valid, false, "valid");
    assertTrue(hasError(result, "rotation"), "expected a rotation error");
  });

  check("empty id is rejected", () => {
    const windowData = createWindowData();
    windowData.id = "";
    assertEqual(validateWindow(windowData).valid, false, "valid");
  });

  check("a non-window type is rejected", () => {
    const windowData = createWindowData();
    (windowData as { type: string }).type = "door";
    assertEqual(validateWindow(windowData).valid, false, "valid");
  });

  check("a non-hex color is rejected", () => {
    const windowData = createWindowData();
    windowData.color = "blue";
    assertEqual(validateWindow(windowData).valid, false, "valid");
  });

  check("a valid 6-digit hex color is accepted", () => {
    assertTrue(validateWindow(createWindowData({ color: "#123ABC" })).valid, "6-digit hex should validate");
  });

  check("an empty material is rejected", () => {
    const windowData = createWindowData();
    windowData.material = "";
    const result = validateWindow(windowData);
    assertEqual(result.valid, false, "valid");
    assertTrue(hasError(result, "material"), "expected a material error");
  });

  check("a null assemblyId is accepted", () => {
    const windowData = createWindowData();
    windowData.assemblyId = null;
    assertTrue(validateWindow(windowData).valid, "null assemblyId should validate");
  });

  check("a non-empty string assemblyId is accepted", () => {
    const windowData = createWindowData();
    windowData.assemblyId = "assembly-1";
    assertTrue(validateWindow(windowData).valid, "a real assemblyId should validate");
  });

  check("an empty string assemblyId is rejected", () => {
    const windowData = createWindowData();
    windowData.assemblyId = "";
    const result = validateWindow(windowData);
    assertEqual(result.valid, false, "valid");
    assertTrue(hasError(result, "assemblyId"), "expected an assemblyId error");
  });

  // --- WindowStore integration ---

  check("WindowStore.add() accepts a valid window", () => {
    const store = new WindowStore();
    const windowData = createWindowData();
    const result = store.add(windowData);
    assertTrue(result.valid, "add() result.valid");
    assertDeepEqual(store.get(windowData.id), windowData, "get() after a valid add()");
  });

  check("WindowStore.add() rejects an invalid window and stores nothing", () => {
    const store = new WindowStore();
    const windowData = createWindowData();
    windowData.dimensions.width = 0;
    const result = store.add(windowData);
    assertEqual(result.valid, false, "add() result.valid");
    assertEqual(store.get(windowData.id), undefined, "invalid window should not be stored");
  });

  check("WindowStore.add() rejects a duplicate id", () => {
    const store = new WindowStore();
    const windowData = createWindowData();
    store.add(windowData);

    const collidingWindow = { ...createWindowData(), id: windowData.id };
    const result = store.add(collidingWindow);

    assertEqual(result.valid, false, "duplicate add() result.valid");
    assertTrue(hasError(result, "id"), "expected an id error");
    assertDeepEqual(store.get(windowData.id), windowData, "the original window should be unchanged");
  });

  check("WindowStore.add() rejecting a window does not notify subscribers", () => {
    const store = new WindowStore();
    let notifiedCount = -1;
    store.subscribe((windows) => {
      notifiedCount = windows.length;
    });
    assertEqual(notifiedCount, 0, "initial subscribe callback");

    const windowData = createWindowData();
    windowData.dimensions.height = NaN;
    store.add(windowData);
    assertEqual(notifiedCount, 0, "notifiedCount should be unchanged after a rejected add()");
  });

  check("WindowStore.update() rejects a merge that would be invalid, preserving the previous window", () => {
    const store = new WindowStore();
    const windowData = createWindowData();
    store.add(windowData);
    const before = store.get(windowData.id);

    const result = store.update(windowData.id, { dimensions: { ...windowData.dimensions, thickness: -1 } });

    assertEqual(result.valid, false, "update() result.valid");
    assertDeepEqual(store.get(windowData.id), before, "window should be byte-for-byte unchanged after a rejected update()");
  });

  check("WindowStore.update() rejecting a change does not notify subscribers", () => {
    const store = new WindowStore();
    const windowData = createWindowData();
    store.add(windowData);

    let notifiedCount = -1;
    store.subscribe((windows) => {
      notifiedCount = windows.length;
    });
    assertEqual(notifiedCount, 1, "initial subscribe callback");

    store.update(windowData.id, { rotation: Infinity });
    assertEqual(notifiedCount, 1, "notifiedCount should be unchanged after a rejected update()");
  });

  check("WindowStore.update() on a missing id is rejected without throwing", () => {
    const store = new WindowStore();
    const result = store.update("does-not-exist", { color: "#000000" });
    assertEqual(result.valid, false, "update() on a missing id should be invalid");
  });

  check("WindowStore.set() rejects an invalid window, preserving the previous one", () => {
    const store = new WindowStore();
    const windowData = createWindowData();
    store.add(windowData);

    const result = store.set(windowData.id, { ...windowData, color: "not-a-color" });

    assertEqual(result.valid, false, "set() result.valid");
    assertDeepEqual(store.get(windowData.id), windowData, "window should be unchanged after a rejected set()");
  });

  check("height-grounding behavior matches the sibling types', through a valid update()", () => {
    const store = new WindowStore();
    const windowData = createWindowData(); // default height 1.2 -> position.y 0.6
    store.add(windowData);

    const result = store.update(windowData.id, { dimensions: { ...windowData.dimensions, height: 1.6 } });
    assertTrue(result.valid, "a valid height update should be accepted");
    assertEqual(store.get(windowData.id)?.position.y, 0.8, "position.y should be re-derived to height / 2");
  });

  check("an explicit position with a height change is respected (no auto-grounding)", () => {
    const store = new WindowStore();
    const windowData = createWindowData();
    store.add(windowData);

    const result = store.update(windowData.id, {
      dimensions: { ...windowData.dimensions, height: 1.6 },
      position: { x: 1, y: 3, z: 1 }
    });
    assertTrue(result.valid, "a valid update with an explicit position should be accepted");
    assertEqual(store.get(windowData.id)?.position.y, 3, "explicit position.y should win over auto-grounding");
  });

  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) {
    throw new Error(`${failed} verification check(s) failed`);
  }
}

run();
