/**
 * Lightweight in-memory verification for slab validation -
 * validateSlab() directly, and SlabStore's integration of it
 * (rejecting invalid add()/update()/set(), leaving prior state
 * untouched, not notifying subscribers), plus duplicate-id rejection
 * and thickness-grounding. Mirrors src/engine/beam/verify.ts exactly -
 * same approach: no test framework, plain assertion helpers, run
 * directly by Node. Run with:
 *   npm run verify
 * or directly:
 *   node src/engine/slab/verify.ts
 *
 * SlabHistoryController is intentionally NOT exercised here - its
 * constructor uses TypeScript parameter-property shorthand, which
 * Node's native TypeScript support cannot run directly (only erasable
 * syntax is supported). That requirement (undo/redo for slab
 * add/update/delete/duplicate) is instead verified in the browser,
 * against the real compiled module - see the implementation report.
 *
 * Explicit .ts extensions below are required for Node's native
 * TypeScript support to resolve these relative imports (see
 * allowImportingTsExtensions in tsconfig.json) - this file is run
 * directly by Node, not bundled by Vite.
 */
import { validateSlab } from "./validateSlab.ts";
import { createSlabData } from "./createSlab.ts";
import { SlabStore } from "./SlabStore.ts";

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

  console.log("Slab validation verification\n");

  // --- validateSlab() directly ---

  check("a freshly created slab is valid", () => {
    assertTrue(validateSlab(createSlabData()).valid, "createSlabData() output should validate");
  });

  check("zero length is rejected", () => {
    const slab = createSlabData();
    slab.dimensions.length = 0;
    const result = validateSlab(slab);
    assertEqual(result.valid, false, "valid");
    assertTrue(hasError(result, "dimensions.length"), "expected a dimensions.length error");
  });

  check("negative width is rejected", () => {
    const slab = createSlabData();
    slab.dimensions.width = -0.2;
    const result = validateSlab(slab);
    assertEqual(result.valid, false, "valid");
    assertTrue(hasError(result, "dimensions.width"), "expected a dimensions.width error");
  });

  check("zero or negative thickness is rejected", () => {
    const slab = createSlabData();
    slab.dimensions.thickness = 0;
    const result = validateSlab(slab);
    assertEqual(result.valid, false, "valid");
    assertTrue(hasError(result, "dimensions.thickness"), "expected a dimensions.thickness error");
  });

  check("NaN dimensions/position/rotation are all rejected together", () => {
    const slab = createSlabData();
    slab.dimensions.thickness = NaN;
    slab.position.x = NaN;
    slab.rotation = NaN;
    const result = validateSlab(slab);
    assertEqual(result.valid, false, "valid");
    assertTrue(hasError(result, "dimensions.thickness"), "expected a dimensions.thickness error");
    assertTrue(hasError(result, "position.x"), "expected a position.x error");
    assertTrue(hasError(result, "rotation"), "expected a rotation error");
  });

  check("Infinity position and dimensions are rejected", () => {
    const slab = createSlabData();
    slab.position.z = Infinity;
    slab.dimensions.length = -Infinity;
    const result = validateSlab(slab);
    assertEqual(result.valid, false, "valid");
    assertTrue(hasError(result, "position.z"), "expected a position.z error");
    assertTrue(hasError(result, "dimensions.length"), "expected a dimensions.length error");
  });

  check("non-finite rotation is rejected", () => {
    const slab = createSlabData();
    slab.rotation = Infinity;
    const result = validateSlab(slab);
    assertEqual(result.valid, false, "valid");
    assertTrue(hasError(result, "rotation"), "expected a rotation error");
  });

  check("empty id is rejected", () => {
    const slab = createSlabData();
    slab.id = "";
    assertEqual(validateSlab(slab).valid, false, "valid");
  });

  check("a non-slab type is rejected", () => {
    const slab = createSlabData();
    (slab as { type: string }).type = "wall";
    assertEqual(validateSlab(slab).valid, false, "valid");
  });

  check("a non-hex color is rejected", () => {
    const slab = createSlabData();
    slab.color = "blue";
    assertEqual(validateSlab(slab).valid, false, "valid");
  });

  check("a valid 6-digit hex color is accepted", () => {
    assertTrue(validateSlab(createSlabData({ color: "#123ABC" })).valid, "6-digit hex should validate");
  });

  check("an empty material is rejected", () => {
    const slab = createSlabData();
    slab.material = "";
    const result = validateSlab(slab);
    assertEqual(result.valid, false, "valid");
    assertTrue(hasError(result, "material"), "expected a material error");
  });

  check("a null assemblyId is accepted", () => {
    const slab = createSlabData();
    slab.assemblyId = null;
    assertTrue(validateSlab(slab).valid, "null assemblyId should validate");
  });

  check("a non-empty string assemblyId is accepted", () => {
    const slab = createSlabData();
    slab.assemblyId = "assembly-1";
    assertTrue(validateSlab(slab).valid, "a real assemblyId should validate");
  });

  check("an empty string assemblyId is rejected", () => {
    const slab = createSlabData();
    slab.assemblyId = "";
    const result = validateSlab(slab);
    assertEqual(result.valid, false, "valid");
    assertTrue(hasError(result, "assemblyId"), "expected an assemblyId error");
  });

  // --- SlabStore integration ---

  check("SlabStore.add() accepts a valid slab", () => {
    const store = new SlabStore();
    const slab = createSlabData();
    const result = store.add(slab);
    assertTrue(result.valid, "add() result.valid");
    assertDeepEqual(store.get(slab.id), slab, "get() after a valid add()");
  });

  check("SlabStore.add() rejects an invalid slab and stores nothing", () => {
    const store = new SlabStore();
    const slab = createSlabData();
    slab.dimensions.length = 0;
    const result = store.add(slab);
    assertEqual(result.valid, false, "add() result.valid");
    assertEqual(store.get(slab.id), undefined, "invalid slab should not be stored");
  });

  check("SlabStore.add() rejects a duplicate id", () => {
    const store = new SlabStore();
    const slab = createSlabData();
    store.add(slab);

    const collidingSlab = { ...createSlabData(), id: slab.id };
    const result = store.add(collidingSlab);

    assertEqual(result.valid, false, "duplicate add() result.valid");
    assertTrue(hasError(result, "id"), "expected an id error");
    assertDeepEqual(store.get(slab.id), slab, "the original slab should be unchanged");
  });

  check("SlabStore.add() rejecting a slab does not notify subscribers", () => {
    const store = new SlabStore();
    let notifiedCount = -1;
    store.subscribe((slabs) => {
      notifiedCount = slabs.length;
    });
    assertEqual(notifiedCount, 0, "initial subscribe callback");

    const slab = createSlabData();
    slab.dimensions.thickness = NaN;
    store.add(slab);
    assertEqual(notifiedCount, 0, "notifiedCount should be unchanged after a rejected add()");
  });

  check("SlabStore.update() rejects a merge that would be invalid, preserving the previous slab", () => {
    const store = new SlabStore();
    const slab = createSlabData();
    store.add(slab);
    const before = store.get(slab.id);

    const result = store.update(slab.id, { dimensions: { ...slab.dimensions, width: -1 } });

    assertEqual(result.valid, false, "update() result.valid");
    assertDeepEqual(store.get(slab.id), before, "slab should be byte-for-byte unchanged after a rejected update()");
  });

  check("SlabStore.update() rejecting a change does not notify subscribers", () => {
    const store = new SlabStore();
    const slab = createSlabData();
    store.add(slab);

    let notifiedCount = -1;
    store.subscribe((slabs) => {
      notifiedCount = slabs.length;
    });
    assertEqual(notifiedCount, 1, "initial subscribe callback");

    store.update(slab.id, { rotation: Infinity });
    assertEqual(notifiedCount, 1, "notifiedCount should be unchanged after a rejected update()");
  });

  check("SlabStore.update() on a missing id is rejected without throwing", () => {
    const store = new SlabStore();
    const result = store.update("does-not-exist", { color: "#000000" });
    assertEqual(result.valid, false, "update() on a missing id should be invalid");
  });

  check("SlabStore.set() rejects an invalid slab, preserving the previous one", () => {
    const store = new SlabStore();
    const slab = createSlabData();
    store.add(slab);

    const result = store.set(slab.id, { ...slab, color: "not-a-color" });

    assertEqual(result.valid, false, "set() result.valid");
    assertDeepEqual(store.get(slab.id), slab, "slab should be unchanged after a rejected set()");
  });

  check("thickness-grounding behavior matches the sibling types', through a valid update()", () => {
    const store = new SlabStore();
    const slab = createSlabData(); // default thickness 0.2 -> position.y 0.1
    store.add(slab);

    const result = store.update(slab.id, { dimensions: { ...slab.dimensions, thickness: 0.4 } });
    assertTrue(result.valid, "a valid thickness update should be accepted");
    assertEqual(store.get(slab.id)?.position.y, 0.2, "position.y should be re-derived to thickness / 2");
  });

  check("an explicit position with a thickness change is respected (no auto-grounding)", () => {
    const store = new SlabStore();
    const slab = createSlabData();
    store.add(slab);

    const result = store.update(slab.id, {
      dimensions: { ...slab.dimensions, thickness: 0.4 },
      position: { x: 1, y: 3, z: 1 }
    });
    assertTrue(result.valid, "a valid update with an explicit position should be accepted");
    assertEqual(store.get(slab.id)?.position.y, 3, "explicit position.y should win over auto-grounding");
  });

  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) {
    throw new Error(`${failed} verification check(s) failed`);
  }
}

run();
