/**
 * Lightweight in-memory verification for beam validation -
 * validateBeam() directly, and BeamStore's integration of it
 * (rejecting invalid add()/update()/set(), leaving prior state
 * untouched, not notifying subscribers), plus duplicate-id rejection
 * and height-grounding. Mirrors src/engine/pillar/verify.ts exactly -
 * same approach: no test framework, plain assertion helpers, run
 * directly by Node. Run with:
 *   npm run verify
 * or directly:
 *   node src/engine/beam/verify.ts
 *
 * BeamHistoryController is intentionally NOT exercised here - its
 * constructor uses TypeScript parameter-property shorthand, which
 * Node's native TypeScript support cannot run directly (only erasable
 * syntax is supported). That requirement (undo/redo for beam
 * add/update/delete/duplicate) is instead verified in the browser,
 * against the real compiled module - see the implementation report.
 *
 * Explicit .ts extensions below are required for Node's native
 * TypeScript support to resolve these relative imports (see
 * allowImportingTsExtensions in tsconfig.json) - this file is run
 * directly by Node, not bundled by Vite.
 */
import { validateBeam } from "./validateBeam.ts";
import { createBeamData } from "./createBeam.ts";
import { BeamStore } from "./BeamStore.ts";

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

  console.log("Beam validation verification\n");

  // --- validateBeam() directly ---

  check("a freshly created beam is valid", () => {
    assertTrue(validateBeam(createBeamData()).valid, "createBeamData() output should validate");
  });

  check("zero length is rejected", () => {
    const beam = createBeamData();
    beam.dimensions.length = 0;
    const result = validateBeam(beam);
    assertEqual(result.valid, false, "valid");
    assertTrue(hasError(result, "dimensions.length"), "expected a dimensions.length error");
  });

  check("negative width is rejected", () => {
    const beam = createBeamData();
    beam.dimensions.width = -0.2;
    const result = validateBeam(beam);
    assertEqual(result.valid, false, "valid");
    assertTrue(hasError(result, "dimensions.width"), "expected a dimensions.width error");
  });

  check("zero or negative height is rejected", () => {
    const beam = createBeamData();
    beam.dimensions.height = 0;
    const result = validateBeam(beam);
    assertEqual(result.valid, false, "valid");
    assertTrue(hasError(result, "dimensions.height"), "expected a dimensions.height error");
  });

  check("NaN dimensions/position/rotation are all rejected together", () => {
    const beam = createBeamData();
    beam.dimensions.height = NaN;
    beam.position.x = NaN;
    beam.rotation = NaN;
    const result = validateBeam(beam);
    assertEqual(result.valid, false, "valid");
    assertTrue(hasError(result, "dimensions.height"), "expected a dimensions.height error");
    assertTrue(hasError(result, "position.x"), "expected a position.x error");
    assertTrue(hasError(result, "rotation"), "expected a rotation error");
  });

  check("Infinity position and dimensions are rejected", () => {
    const beam = createBeamData();
    beam.position.z = Infinity;
    beam.dimensions.length = -Infinity;
    const result = validateBeam(beam);
    assertEqual(result.valid, false, "valid");
    assertTrue(hasError(result, "position.z"), "expected a position.z error");
    assertTrue(hasError(result, "dimensions.length"), "expected a dimensions.length error");
  });

  check("non-finite rotation is rejected", () => {
    const beam = createBeamData();
    beam.rotation = Infinity;
    const result = validateBeam(beam);
    assertEqual(result.valid, false, "valid");
    assertTrue(hasError(result, "rotation"), "expected a rotation error");
  });

  check("empty id is rejected", () => {
    const beam = createBeamData();
    beam.id = "";
    assertEqual(validateBeam(beam).valid, false, "valid");
  });

  check("a non-beam type is rejected", () => {
    const beam = createBeamData();
    (beam as { type: string }).type = "wall";
    assertEqual(validateBeam(beam).valid, false, "valid");
  });

  check("a non-hex color is rejected", () => {
    const beam = createBeamData();
    beam.color = "blue";
    assertEqual(validateBeam(beam).valid, false, "valid");
  });

  check("a valid 6-digit hex color is accepted", () => {
    assertTrue(validateBeam(createBeamData({ color: "#123ABC" })).valid, "6-digit hex should validate");
  });

  check("an empty material is rejected", () => {
    const beam = createBeamData();
    beam.material = "";
    const result = validateBeam(beam);
    assertEqual(result.valid, false, "valid");
    assertTrue(hasError(result, "material"), "expected a material error");
  });

  check("a null assemblyId is accepted", () => {
    const beam = createBeamData();
    beam.assemblyId = null;
    assertTrue(validateBeam(beam).valid, "null assemblyId should validate");
  });

  check("a non-empty string assemblyId is accepted", () => {
    const beam = createBeamData();
    beam.assemblyId = "assembly-1";
    assertTrue(validateBeam(beam).valid, "a real assemblyId should validate");
  });

  check("an empty string assemblyId is rejected", () => {
    const beam = createBeamData();
    beam.assemblyId = "";
    const result = validateBeam(beam);
    assertEqual(result.valid, false, "valid");
    assertTrue(hasError(result, "assemblyId"), "expected an assemblyId error");
  });

  // --- BeamStore integration ---

  check("BeamStore.add() accepts a valid beam", () => {
    const store = new BeamStore();
    const beam = createBeamData();
    const result = store.add(beam);
    assertTrue(result.valid, "add() result.valid");
    assertDeepEqual(store.get(beam.id), beam, "get() after a valid add()");
  });

  check("BeamStore.add() rejects an invalid beam and stores nothing", () => {
    const store = new BeamStore();
    const beam = createBeamData();
    beam.dimensions.length = 0;
    const result = store.add(beam);
    assertEqual(result.valid, false, "add() result.valid");
    assertEqual(store.get(beam.id), undefined, "invalid beam should not be stored");
  });

  check("BeamStore.add() rejects a duplicate id", () => {
    const store = new BeamStore();
    const beam = createBeamData();
    store.add(beam);

    const collidingBeam = { ...createBeamData(), id: beam.id };
    const result = store.add(collidingBeam);

    assertEqual(result.valid, false, "duplicate add() result.valid");
    assertTrue(hasError(result, "id"), "expected an id error");
    assertDeepEqual(store.get(beam.id), beam, "the original beam should be unchanged");
  });

  check("BeamStore.add() rejecting a beam does not notify subscribers", () => {
    const store = new BeamStore();
    let notifiedCount = -1;
    store.subscribe((beams) => {
      notifiedCount = beams.length;
    });
    assertEqual(notifiedCount, 0, "initial subscribe callback");

    const beam = createBeamData();
    beam.dimensions.height = NaN;
    store.add(beam);
    assertEqual(notifiedCount, 0, "notifiedCount should be unchanged after a rejected add()");
  });

  check("BeamStore.update() rejects a merge that would be invalid, preserving the previous beam", () => {
    const store = new BeamStore();
    const beam = createBeamData();
    store.add(beam);
    const before = store.get(beam.id);

    const result = store.update(beam.id, { dimensions: { ...beam.dimensions, width: -1 } });

    assertEqual(result.valid, false, "update() result.valid");
    assertDeepEqual(store.get(beam.id), before, "beam should be byte-for-byte unchanged after a rejected update()");
  });

  check("BeamStore.update() rejecting a change does not notify subscribers", () => {
    const store = new BeamStore();
    const beam = createBeamData();
    store.add(beam);

    let notifiedCount = -1;
    store.subscribe((beams) => {
      notifiedCount = beams.length;
    });
    assertEqual(notifiedCount, 1, "initial subscribe callback");

    store.update(beam.id, { rotation: Infinity });
    assertEqual(notifiedCount, 1, "notifiedCount should be unchanged after a rejected update()");
  });

  check("BeamStore.update() on a missing id is rejected without throwing", () => {
    const store = new BeamStore();
    const result = store.update("does-not-exist", { color: "#000000" });
    assertEqual(result.valid, false, "update() on a missing id should be invalid");
  });

  check("BeamStore.set() rejects an invalid beam, preserving the previous one", () => {
    const store = new BeamStore();
    const beam = createBeamData();
    store.add(beam);

    const result = store.set(beam.id, { ...beam, color: "not-a-color" });

    assertEqual(result.valid, false, "set() result.valid");
    assertDeepEqual(store.get(beam.id), beam, "beam should be unchanged after a rejected set()");
  });

  check("height-grounding behavior matches wall's/pillar's, through a valid update()", () => {
    const store = new BeamStore();
    const beam = createBeamData(); // default height 0.4 -> position.y 0.2
    store.add(beam);

    const result = store.update(beam.id, { dimensions: { ...beam.dimensions, height: 1 } });
    assertTrue(result.valid, "a valid height update should be accepted");
    assertEqual(store.get(beam.id)?.position.y, 0.5, "position.y should be re-derived to height / 2");
  });

  check("an explicit position with a height change is respected (no auto-grounding)", () => {
    const store = new BeamStore();
    const beam = createBeamData();
    store.add(beam);

    const result = store.update(beam.id, {
      dimensions: { ...beam.dimensions, height: 1 },
      position: { x: 1, y: 3, z: 1 }
    });
    assertTrue(result.valid, "a valid update with an explicit position should be accepted");
    assertEqual(store.get(beam.id)?.position.y, 3, "explicit position.y should win over auto-grounding");
  });

  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) {
    throw new Error(`${failed} verification check(s) failed`);
  }
}

run();
