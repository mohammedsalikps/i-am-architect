/**
 * Lightweight in-memory verification for AssemblyStore - validateAssembly()
 * directly, and AssemblyStore's integration of it (rejecting invalid
 * add()/update(), rejecting duplicate ids, leaving prior state untouched,
 * not notifying subscribers on a rejected write). Same approach as the
 * other verify.ts scripts in this project: no test framework, plain
 * assertion helpers, run directly by Node. Run with:
 *   npm run verify
 * or directly:
 *   node src/engine/assemblies/verify.ts
 *
 * Explicit .ts extensions below are required for Node's native
 * TypeScript support to resolve these relative imports (see
 * allowImportingTsExtensions in tsconfig.json) - this file is run
 * directly by Node, not bundled by Vite.
 */
import { AssemblyStore, createAssemblyData, validateAssembly } from "./AssemblyStore.ts";
import type { AssemblyData } from "./types.ts";

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

  console.log("AssemblyStore verification\n");

  // --- validateAssembly() directly ---

  check("a freshly created assembly is valid", () => {
    assertTrue(validateAssembly(createAssemblyData({ name: "Ground Floor Walls" })).valid, "should validate");
  });

  check("an empty name is rejected", () => {
    const assembly = createAssemblyData({ name: "Ground Floor" });
    assembly.name = "";
    const result = validateAssembly(assembly);
    assertEqual(result.valid, false, "valid");
    assertTrue(hasError(result, "name"), "expected a name error");
  });

  check("an empty id is rejected", () => {
    const assembly = createAssemblyData({ name: "Ground Floor" });
    assembly.id = "";
    const result = validateAssembly(assembly);
    assertEqual(result.valid, false, "valid");
    assertTrue(hasError(result, "id"), "expected an id error");
  });

  check("duplicate object ids within one assembly are rejected", () => {
    const assembly = createAssemblyData({ name: "Ground Floor", objectIds: ["wall-1", "wall-2", "wall-1"] });
    const result = validateAssembly(assembly);
    assertEqual(result.valid, false, "valid");
    assertTrue(hasError(result, "objectIds"), "expected an objectIds error");
  });

  check("a non-string object id is rejected", () => {
    const assembly = createAssemblyData({ name: "Ground Floor" });
    (assembly.objectIds as unknown[]) = ["wall-1", 42, ""];
    const result = validateAssembly(assembly);
    assertEqual(result.valid, false, "valid");
    assertTrue(hasError(result, "objectIds"), "expected an objectIds error");
  });

  check("a non-array objectIds is rejected", () => {
    const assembly = createAssemblyData({ name: "Ground Floor" });
    (assembly as unknown as { objectIds: unknown }).objectIds = "not-an-array";
    const result = validateAssembly(assembly);
    assertEqual(result.valid, false, "valid");
    assertTrue(hasError(result, "objectIds"), "expected an objectIds error");
  });

  check("non-finite timestamps are rejected", () => {
    const assembly = createAssemblyData({ name: "Ground Floor" });
    assembly.createdAt = NaN;
    assembly.updatedAt = Infinity;
    const result = validateAssembly(assembly);
    assertEqual(result.valid, false, "valid");
    assertTrue(hasError(result, "createdAt"), "expected a createdAt error");
    assertTrue(hasError(result, "updatedAt"), "expected an updatedAt error");
  });

  check("updatedAt earlier than createdAt is rejected", () => {
    const assembly = createAssemblyData({ name: "Ground Floor" });
    assembly.createdAt = 1000;
    assembly.updatedAt = 500;
    const result = validateAssembly(assembly);
    assertEqual(result.valid, false, "valid");
    assertTrue(hasError(result, "updatedAt"), "expected an updatedAt error");
  });

  check("updatedAt equal to createdAt is accepted", () => {
    const assembly = createAssemblyData({ name: "Ground Floor" });
    assembly.createdAt = 1000;
    assembly.updatedAt = 1000;
    assertTrue(validateAssembly(assembly).valid, "equal timestamps should be valid");
  });

  // --- AssemblyStore integration ---

  check("AssemblyStore.add() accepts a valid assembly", () => {
    const store = new AssemblyStore();
    const assembly = createAssemblyData({ name: "Ground Floor", objectIds: ["wall-1"] });
    const result = store.add(assembly);
    assertTrue(result.valid, "add() result.valid");
    assertDeepEqual(store.get(assembly.id), assembly, "get() after add()");
  });

  check("AssemblyStore.add() rejects an invalid assembly and stores nothing", () => {
    const store = new AssemblyStore();
    const assembly = createAssemblyData({ name: "" });
    const result = store.add(assembly);
    assertEqual(result.valid, false, "add() result.valid");
    assertEqual(store.get(assembly.id), undefined, "invalid assembly should not be stored");
  });

  check("AssemblyStore.add() rejects a duplicate assembly id", () => {
    const store = new AssemblyStore();
    const first = createAssemblyData({ name: "Ground Floor" });
    store.add(first);

    const second: AssemblyData = { ...createAssemblyData({ name: "Different Name" }), id: first.id };
    const result = store.add(second);

    assertEqual(result.valid, false, "duplicate id add() result.valid");
    assertTrue(hasError(result, "id"), "expected an id error");
    assertEqual(store.get(first.id)?.name, "Ground Floor", "original assembly should be untouched");
  });

  check("AssemblyStore.add() rejecting a write does not notify subscribers", () => {
    const store = new AssemblyStore();
    let notifiedCount = -1;
    store.subscribe((assemblies) => {
      notifiedCount = assemblies.length;
    });
    assertEqual(notifiedCount, 0, "initial subscribe callback");

    store.add(createAssemblyData({ name: "" }));
    assertEqual(notifiedCount, 0, "notifiedCount should be unchanged after a rejected add()");
  });

  check("AssemblyStore.update() applies a valid change", () => {
    const store = new AssemblyStore();
    const assembly = createAssemblyData({ name: "Ground Floor" });
    store.add(assembly);

    const result = store.update(assembly.id, { name: "Ground Floor Walls", objectIds: ["wall-1", "wall-2"] });
    assertTrue(result.valid, "update() result.valid");
    assertEqual(store.get(assembly.id)?.name, "Ground Floor Walls", "name after update()");
    assertDeepEqual(store.get(assembly.id)?.objectIds, ["wall-1", "wall-2"], "objectIds after update()");
  });

  check("AssemblyStore.update() rejects a change that would be invalid, preserving the previous assembly", () => {
    const store = new AssemblyStore();
    const assembly = createAssemblyData({ name: "Ground Floor", objectIds: ["wall-1"] });
    store.add(assembly);
    const before = store.get(assembly.id);

    const result = store.update(assembly.id, { objectIds: ["wall-1", "wall-1"] });

    assertEqual(result.valid, false, "update() result.valid");
    assertDeepEqual(store.get(assembly.id), before, "assembly should be byte-for-byte unchanged");
  });

  check("AssemblyStore.update() on a missing id is rejected without throwing", () => {
    const store = new AssemblyStore();
    const result = store.update("does-not-exist", { name: "X" });
    assertEqual(result.valid, false, "update() on a missing id should be invalid");
  });

  check("AssemblyStore.remove() removes an assembly", () => {
    const store = new AssemblyStore();
    const assembly = createAssemblyData({ name: "Ground Floor" });
    store.add(assembly);

    store.remove(assembly.id);
    assertEqual(store.get(assembly.id), undefined, "assembly should be gone");
  });

  check("get()/getAll() return clones, not live references (via the underlying ObjectRegistry)", () => {
    const store = new AssemblyStore();
    const assembly = createAssemblyData({ name: "Ground Floor" });
    store.add(assembly);

    const fetched = store.get(assembly.id);
    assertTrue(fetched, "should find the assembly");
    fetched.name = "Mutated";
    assertEqual(store.get(assembly.id)?.name, "Ground Floor", "stored name after mutating the returned clone");
  });

  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) {
    throw new Error(`${failed} verification check(s) failed`);
  }
}

run();
