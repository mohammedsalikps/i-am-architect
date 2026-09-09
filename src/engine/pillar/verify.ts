/**
 * Lightweight in-memory verification for pillar validation -
 * validatePillar() directly, and PillarStore's integration of it
 * (rejecting invalid add()/update()/set(), leaving prior state
 * untouched, not notifying subscribers), plus duplicate-id rejection
 * and height-grounding. Mirrors src/engine/wall/verify.ts exactly -
 * same approach: no test framework, plain assertion helpers, run
 * directly by Node. Run with:
 *   npm run verify
 * or directly:
 *   node src/engine/pillar/verify.ts
 *
 * PillarHistoryController is intentionally NOT exercised here - its
 * constructor uses TypeScript parameter-property shorthand, which
 * Node's native TypeScript support cannot run directly (only erasable
 * syntax is supported). That requirement (undo/redo for pillar
 * add/update/delete/duplicate) is instead verified in the browser,
 * against the real compiled module - see the implementation report.
 *
 * Explicit .ts extensions below are required for Node's native
 * TypeScript support to resolve these relative imports (see
 * allowImportingTsExtensions in tsconfig.json) - this file is run
 * directly by Node, not bundled by Vite.
 */
import { validatePillar } from "./validatePillar.ts";
import { createPillarData } from "./createPillar.ts";
import { PillarStore } from "./PillarStore.ts";

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

  console.log("Pillar validation verification\n");

  // --- validatePillar() directly ---

  check("a freshly created pillar is valid", () => {
    assertTrue(validatePillar(createPillarData()).valid, "createPillarData() output should validate");
  });

  check("zero width is rejected", () => {
    const pillar = createPillarData();
    pillar.dimensions.width = 0;
    const result = validatePillar(pillar);
    assertEqual(result.valid, false, "valid");
    assertTrue(hasError(result, "dimensions.width"), "expected a dimensions.width error");
  });

  check("negative depth is rejected", () => {
    const pillar = createPillarData();
    pillar.dimensions.depth = -0.2;
    const result = validatePillar(pillar);
    assertEqual(result.valid, false, "valid");
    assertTrue(hasError(result, "dimensions.depth"), "expected a dimensions.depth error");
  });

  check("zero or negative height is rejected", () => {
    const pillar = createPillarData();
    pillar.dimensions.height = 0;
    const result = validatePillar(pillar);
    assertEqual(result.valid, false, "valid");
    assertTrue(hasError(result, "dimensions.height"), "expected a dimensions.height error");
  });

  check("NaN dimensions/position/rotation are all rejected together", () => {
    const pillar = createPillarData();
    pillar.dimensions.height = NaN;
    pillar.position.x = NaN;
    pillar.rotation = NaN;
    const result = validatePillar(pillar);
    assertEqual(result.valid, false, "valid");
    assertTrue(hasError(result, "dimensions.height"), "expected a dimensions.height error");
    assertTrue(hasError(result, "position.x"), "expected a position.x error");
    assertTrue(hasError(result, "rotation"), "expected a rotation error");
  });

  check("Infinity position and dimensions are rejected", () => {
    const pillar = createPillarData();
    pillar.position.z = Infinity;
    pillar.dimensions.width = -Infinity;
    const result = validatePillar(pillar);
    assertEqual(result.valid, false, "valid");
    assertTrue(hasError(result, "position.z"), "expected a position.z error");
    assertTrue(hasError(result, "dimensions.width"), "expected a dimensions.width error");
  });

  check("non-finite rotation is rejected", () => {
    const pillar = createPillarData();
    pillar.rotation = Infinity;
    const result = validatePillar(pillar);
    assertEqual(result.valid, false, "valid");
    assertTrue(hasError(result, "rotation"), "expected a rotation error");
  });

  check("empty id is rejected", () => {
    const pillar = createPillarData();
    pillar.id = "";
    assertEqual(validatePillar(pillar).valid, false, "valid");
  });

  check("a non-pillar type is rejected", () => {
    const pillar = createPillarData();
    (pillar as { type: string }).type = "wall";
    assertEqual(validatePillar(pillar).valid, false, "valid");
  });

  check("a non-hex color is rejected", () => {
    const pillar = createPillarData();
    pillar.color = "blue";
    assertEqual(validatePillar(pillar).valid, false, "valid");
  });

  check("a valid 6-digit hex color is accepted", () => {
    assertTrue(validatePillar(createPillarData({ color: "#123ABC" })).valid, "6-digit hex should validate");
  });

  check("an empty material is rejected", () => {
    const pillar = createPillarData();
    pillar.material = "";
    const result = validatePillar(pillar);
    assertEqual(result.valid, false, "valid");
    assertTrue(hasError(result, "material"), "expected a material error");
  });

  check("a null assemblyId is accepted", () => {
    const pillar = createPillarData();
    pillar.assemblyId = null;
    assertTrue(validatePillar(pillar).valid, "null assemblyId should validate");
  });

  check("a non-empty string assemblyId is accepted", () => {
    const pillar = createPillarData();
    pillar.assemblyId = "assembly-1";
    assertTrue(validatePillar(pillar).valid, "a real assemblyId should validate");
  });

  check("an empty string assemblyId is rejected", () => {
    const pillar = createPillarData();
    pillar.assemblyId = "";
    const result = validatePillar(pillar);
    assertEqual(result.valid, false, "valid");
    assertTrue(hasError(result, "assemblyId"), "expected an assemblyId error");
  });

  // --- PillarStore integration ---

  check("PillarStore.add() accepts a valid pillar", () => {
    const store = new PillarStore();
    const pillar = createPillarData();
    const result = store.add(pillar);
    assertTrue(result.valid, "add() result.valid");
    assertDeepEqual(store.get(pillar.id), pillar, "get() after a valid add()");
  });

  check("PillarStore.add() rejects an invalid pillar and stores nothing", () => {
    const store = new PillarStore();
    const pillar = createPillarData();
    pillar.dimensions.width = 0;
    const result = store.add(pillar);
    assertEqual(result.valid, false, "add() result.valid");
    assertEqual(store.get(pillar.id), undefined, "invalid pillar should not be stored");
  });

  check("PillarStore.add() rejects a duplicate id", () => {
    const store = new PillarStore();
    const pillar = createPillarData();
    store.add(pillar);

    const collidingPillar = { ...createPillarData(), id: pillar.id };
    const result = store.add(collidingPillar);

    assertEqual(result.valid, false, "duplicate add() result.valid");
    assertTrue(hasError(result, "id"), "expected an id error");
    assertDeepEqual(store.get(pillar.id), pillar, "the original pillar should be unchanged");
  });

  check("PillarStore.add() rejecting a pillar does not notify subscribers", () => {
    const store = new PillarStore();
    let notifiedCount = -1;
    store.subscribe((pillars) => {
      notifiedCount = pillars.length;
    });
    assertEqual(notifiedCount, 0, "initial subscribe callback");

    const pillar = createPillarData();
    pillar.dimensions.height = NaN;
    store.add(pillar);
    assertEqual(notifiedCount, 0, "notifiedCount should be unchanged after a rejected add()");
  });

  check("PillarStore.update() rejects a merge that would be invalid, preserving the previous pillar", () => {
    const store = new PillarStore();
    const pillar = createPillarData();
    store.add(pillar);
    const before = store.get(pillar.id);

    const result = store.update(pillar.id, { dimensions: { ...pillar.dimensions, depth: -1 } });

    assertEqual(result.valid, false, "update() result.valid");
    assertDeepEqual(store.get(pillar.id), before, "pillar should be byte-for-byte unchanged after a rejected update()");
  });

  check("PillarStore.update() rejecting a change does not notify subscribers", () => {
    const store = new PillarStore();
    const pillar = createPillarData();
    store.add(pillar);

    let notifiedCount = -1;
    store.subscribe((pillars) => {
      notifiedCount = pillars.length;
    });
    assertEqual(notifiedCount, 1, "initial subscribe callback");

    store.update(pillar.id, { rotation: Infinity });
    assertEqual(notifiedCount, 1, "notifiedCount should be unchanged after a rejected update()");
  });

  check("PillarStore.update() on a missing id is rejected without throwing", () => {
    const store = new PillarStore();
    const result = store.update("does-not-exist", { color: "#000000" });
    assertEqual(result.valid, false, "update() on a missing id should be invalid");
  });

  check("PillarStore.set() rejects an invalid pillar, preserving the previous one", () => {
    const store = new PillarStore();
    const pillar = createPillarData();
    store.add(pillar);

    const result = store.set(pillar.id, { ...pillar, color: "not-a-color" });

    assertEqual(result.valid, false, "set() result.valid");
    assertDeepEqual(store.get(pillar.id), pillar, "pillar should be unchanged after a rejected set()");
  });

  check("height-grounding behavior matches wall's, through a valid update()", () => {
    const store = new PillarStore();
    const pillar = createPillarData(); // default height 2.7 -> position.y 1.35
    store.add(pillar);

    const result = store.update(pillar.id, { dimensions: { ...pillar.dimensions, height: 5 } });
    assertTrue(result.valid, "a valid height update should be accepted");
    assertEqual(store.get(pillar.id)?.position.y, 2.5, "position.y should be re-derived to height / 2");
  });

  check("an explicit position with a height change is respected (no auto-grounding)", () => {
    const store = new PillarStore();
    const pillar = createPillarData();
    store.add(pillar);

    const result = store.update(pillar.id, {
      dimensions: { ...pillar.dimensions, height: 5 },
      position: { x: 1, y: 9, z: 1 }
    });
    assertTrue(result.valid, "a valid update with an explicit position should be accepted");
    assertEqual(store.get(pillar.id)?.position.y, 9, "explicit position.y should win over auto-grounding");
  });

  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) {
    throw new Error(`${failed} verification check(s) failed`);
  }
}

run();
