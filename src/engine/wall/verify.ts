/**
 * Lightweight in-memory verification for wall validation - validateWall()
 * directly, and WallStore's integration of it (rejecting invalid
 * add()/update()/set(), leaving prior state untouched, not notifying
 * subscribers). Same approach as src/engine/objects/verify.ts: no test
 * framework, plain assertion helpers, run directly by Node. Run with:
 *   npm run verify
 * or directly:
 *   node src/engine/wall/verify.ts
 *
 * WallHistoryController is intentionally NOT exercised here - its
 * constructor uses TypeScript parameter-property shorthand, which
 * Node's native TypeScript support cannot run directly (only erasable
 * syntax is supported). That requirement ("an invalid write creates no
 * undo-history entry") is instead verified in the browser, against the
 * real compiled module, as part of this milestone's manual regression
 * pass - see the implementation report.
 *
 * Explicit .ts extensions below are required for Node's native
 * TypeScript support to resolve these relative imports (see
 * allowImportingTsExtensions in tsconfig.json) - this file is run
 * directly by Node, not bundled by Vite.
 */
import { validateWall } from "./validateWall.ts";
import { createWallData } from "./createWall.ts";
import { WallStore } from "./WallStore.ts";

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

  console.log("Wall validation verification\n");

  // --- validateWall() directly ---

  check("a freshly created wall is valid", () => {
    assertTrue(validateWall(createWallData()).valid, "createWallData() output should validate");
  });

  check("zero length is rejected", () => {
    const wall = createWallData();
    wall.dimensions.length = 0;
    const result = validateWall(wall);
    assertEqual(result.valid, false, "valid");
    assertTrue(hasError(result, "dimensions.length"), "expected a dimensions.length error");
  });

  check("negative thickness is rejected", () => {
    const wall = createWallData();
    wall.dimensions.thickness = -0.2;
    const result = validateWall(wall);
    assertEqual(result.valid, false, "valid");
    assertTrue(hasError(result, "dimensions.thickness"), "expected a dimensions.thickness error");
  });

  check("NaN dimensions/position/rotation are all rejected together", () => {
    const wall = createWallData();
    wall.dimensions.height = NaN;
    wall.position.x = NaN;
    wall.rotation = NaN;
    const result = validateWall(wall);
    assertEqual(result.valid, false, "valid");
    assertTrue(hasError(result, "dimensions.height"), "expected a dimensions.height error");
    assertTrue(hasError(result, "position.x"), "expected a position.x error");
    assertTrue(hasError(result, "rotation"), "expected a rotation error");
  });

  check("Infinity position and dimensions are rejected", () => {
    const wall = createWallData();
    wall.position.z = Infinity;
    wall.dimensions.length = -Infinity;
    const result = validateWall(wall);
    assertEqual(result.valid, false, "valid");
    assertTrue(hasError(result, "position.z"), "expected a position.z error");
    assertTrue(hasError(result, "dimensions.length"), "expected a dimensions.length error");
  });

  check("non-finite rotation is rejected", () => {
    const wall = createWallData();
    wall.rotation = Infinity;
    const result = validateWall(wall);
    assertEqual(result.valid, false, "valid");
    assertTrue(hasError(result, "rotation"), "expected a rotation error");
  });

  check("empty id is rejected", () => {
    const wall = createWallData();
    wall.id = "";
    assertEqual(validateWall(wall).valid, false, "valid");
  });

  check("a non-wall type is rejected", () => {
    const wall = createWallData();
    (wall as { type: string }).type = "pillar";
    assertEqual(validateWall(wall).valid, false, "valid");
  });

  check("a non-hex color is rejected", () => {
    const wall = createWallData();
    wall.color = "blue";
    assertEqual(validateWall(wall).valid, false, "valid");
  });

  check("a valid 6-digit hex color is accepted", () => {
    assertTrue(validateWall(createWallData({ color: "#123ABC" })).valid, "6-digit hex should validate");
  });

  // --- WallStore integration ---

  check("WallStore.add() accepts a valid wall", () => {
    const store = new WallStore();
    const wall = createWallData();
    const result = store.add(wall);
    assertTrue(result.valid, "add() result.valid");
    assertDeepEqual(store.get(wall.id), wall, "get() after a valid add()");
  });

  check("WallStore.add() rejects an invalid wall and stores nothing", () => {
    const store = new WallStore();
    const wall = createWallData();
    wall.dimensions.length = 0;
    const result = store.add(wall);
    assertEqual(result.valid, false, "add() result.valid");
    assertEqual(store.get(wall.id), undefined, "invalid wall should not be stored");
  });

  check("WallStore.add() rejecting a wall does not notify subscribers", () => {
    const store = new WallStore();
    let notifiedCount = -1;
    store.subscribe((walls) => {
      notifiedCount = walls.length;
    });
    assertEqual(notifiedCount, 0, "initial subscribe callback");

    const wall = createWallData();
    wall.dimensions.height = NaN;
    store.add(wall);
    assertEqual(notifiedCount, 0, "notifiedCount should be unchanged after a rejected add()");
  });

  check("WallStore.update() rejects a merge that would be invalid, preserving the previous wall", () => {
    const store = new WallStore();
    const wall = createWallData();
    store.add(wall);
    const before = store.get(wall.id);

    const result = store.update(wall.id, { dimensions: { ...wall.dimensions, thickness: -1 } });

    assertEqual(result.valid, false, "update() result.valid");
    assertDeepEqual(store.get(wall.id), before, "wall should be byte-for-byte unchanged after a rejected update()");
  });

  check("WallStore.update() rejecting a change does not notify subscribers", () => {
    const store = new WallStore();
    const wall = createWallData();
    store.add(wall);

    let notifiedCount = -1;
    store.subscribe((walls) => {
      notifiedCount = walls.length;
    });
    assertEqual(notifiedCount, 1, "initial subscribe callback");

    store.update(wall.id, { rotation: Infinity });
    assertEqual(notifiedCount, 1, "notifiedCount should be unchanged after a rejected update()");
  });

  check("WallStore.update() on a missing id is rejected without throwing", () => {
    const store = new WallStore();
    const result = store.update("does-not-exist", { color: "#000000" });
    assertEqual(result.valid, false, "update() on a missing id should be invalid");
  });

  check("WallStore.set() rejects an invalid wall, preserving the previous one", () => {
    const store = new WallStore();
    const wall = createWallData();
    store.add(wall);

    const result = store.set(wall.id, { ...wall, color: "not-a-color" });

    assertEqual(result.valid, false, "set() result.valid");
    assertDeepEqual(store.get(wall.id), wall, "wall should be unchanged after a rejected set()");
  });

  check("height-grounding behavior remains intact through a valid update()", () => {
    const store = new WallStore();
    const wall = createWallData(); // default height 2.7 -> position.y 1.35
    store.add(wall);

    const result = store.update(wall.id, { dimensions: { ...wall.dimensions, height: 5 } });
    assertTrue(result.valid, "a valid height update should be accepted");
    assertEqual(store.get(wall.id)?.position.y, 2.5, "position.y should be re-derived to height / 2");
  });

  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) {
    throw new Error(`${failed} verification check(s) failed`);
  }
}

run();
