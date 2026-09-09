/**
 * Lightweight in-memory verification for ObjectRegistry. This project
 * has no test framework installed, so this is a plain runnable script
 * with its own tiny assertion helpers (deliberately not `node:assert` -
 * that needs @types/node, a package this milestone shouldn't add). Run
 * with:
 *   npm run verify
 * or directly:
 *   node src/engine/objects/verify.ts
 *
 * Explicit .ts extensions below are required for Node's native
 * TypeScript support to resolve these relative imports (see
 * allowImportingTsExtensions in tsconfig.json) - this file is run
 * directly by Node, not bundled by Vite.
 */
import { ObjectRegistry } from "./ObjectRegistry.ts";
import { resolveConstructionObject } from "./resolveConstructionObject.ts";
import { WallStore } from "../wall/WallStore.ts";
import { createWallData } from "../wall/createWall.ts";
import { PillarStore } from "../pillar/PillarStore.ts";
import { createPillarData } from "../pillar/createPillar.ts";
import { BeamStore } from "../beam/BeamStore.ts";
import { createBeamData } from "../beam/createBeam.ts";
import { SlabStore } from "../slab/SlabStore.ts";
import { createSlabData } from "../slab/createSlab.ts";
import type { ConstructionObjectBase } from "./types.ts";

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

function assertNotEqual<T>(actual: T, forbidden: T, message: string): void {
  if (actual === forbidden) {
    throw new Error(`${message}: expected value to differ from ${JSON.stringify(forbidden)}`);
  }
}

function assertDeepEqual(actual: unknown, expected: unknown, message: string): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`${message}: expected ${expectedJson}, got ${actualJson}`);
  }
}

// A throwaway, deliberately non-wall shape, to prove the registry is
// genuinely generic rather than accidentally wall-specific.
interface FixtureDimensions {
  radius: number;
}
type FixtureData = ConstructionObjectBase<"pillar", FixtureDimensions>;

function makeFixture(overrides: Partial<FixtureData> = {}): FixtureData {
  return {
    id: "pillar-1",
    type: "pillar",
    position: { x: 0, y: 0, z: 0 },
    rotation: 0,
    dimensions: { radius: 0.3 },
    material: "concrete",
    color: "#888888",
    assemblyId: null,
    ...overrides
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

  console.log("ObjectRegistry verification\n");

  const registry = new ObjectRegistry<FixtureData>();

  check("starts empty", () => {
    assertDeepEqual(registry.getAll(), [], "getAll()");
    assertEqual(registry.has("pillar-1"), false, "has()");
    assertEqual(registry.get("pillar-1"), undefined, "get()");
  });

  const original = makeFixture();
  check("add() stores the object", () => {
    registry.add(original);
    assertEqual(registry.has("pillar-1"), true, "has() after add");
    assertEqual(registry.getAll().length, 1, "getAll().length after add");
    assertDeepEqual(registry.get("pillar-1"), original, "get() after add");
  });

  check("add() defensively clones its input", () => {
    original.color = "#ff0000"; // mutate the caller's object after adding it
    assertNotEqual(registry.get("pillar-1")?.color, "#ff0000", "stored color after external mutation");
  });

  check("get() returns a clone, not a live reference", () => {
    const first = registry.get("pillar-1");
    assertTrue(first, "get() should find the object");
    first.color = "#00ff00";
    assertNotEqual(registry.get("pillar-1")?.color, "#00ff00", "stored color after mutating the returned clone");
  });

  check("getAll() returns clones too, including nested fields", () => {
    const all = registry.getAll();
    const first = all[0];
    assertTrue(first, "getAll() should return at least one object");
    first.dimensions.radius = 999;
    const secondAll = registry.getAll();
    const second = secondAll[0];
    assertTrue(second, "getAll() should still return the object");
    assertNotEqual(second.dimensions.radius, 999, "stored radius after mutating a getAll() clone");
  });

  check("update() merges a partial change without disturbing other fields", () => {
    registry.update("pillar-1", { color: "#123456" });
    assertEqual(registry.get("pillar-1")?.color, "#123456", "color after update()");
    assertEqual(registry.get("pillar-1")?.dimensions.radius, 0.3, "radius should survive an unrelated update()");
  });

  check("update() on a missing id is a no-op", () => {
    registry.update("does-not-exist", { color: "#000000" });
    assertEqual(registry.has("does-not-exist"), false, "has() for a never-added id");
  });

  check("set() replaces the object wholesale", () => {
    const replacement = makeFixture({ color: "#ffffff", dimensions: { radius: 1.5 } });
    registry.set("pillar-1", replacement);
    assertDeepEqual(registry.get("pillar-1"), replacement, "get() after set()");
  });

  let notifiedCount = -1;
  const unsubscribe = registry.subscribe((objects) => {
    notifiedCount = objects.length;
  });
  check("subscribe() calls the listener immediately with current state", () => {
    assertEqual(notifiedCount, 1, "notifiedCount right after subscribing");
  });

  check("subscribe() notifies on add/remove", () => {
    registry.add(makeFixture({ id: "pillar-2" }));
    assertEqual(notifiedCount, 2, "notifiedCount after add()");
    registry.remove("pillar-1");
    assertEqual(notifiedCount, 1, "notifiedCount after remove()");
  });

  check("unsubscribe() stops further notifications", () => {
    unsubscribe();
    registry.add(makeFixture({ id: "pillar-3" }));
    assertEqual(notifiedCount, 1, "notifiedCount should be unchanged - listener was already removed");
  });

  check("remove() on a missing id does not throw", () => {
    registry.remove("does-not-exist");
  });

  // --- resolveConstructionObject() ---

  function makeEmptyStores(): {
    wallStore: WallStore;
    pillarStore: PillarStore;
    beamStore: BeamStore;
    slabStore: SlabStore;
  } {
    return {
      wallStore: new WallStore(),
      pillarStore: new PillarStore(),
      beamStore: new BeamStore(),
      slabStore: new SlabStore()
    };
  }

  check("resolves a wall id to type 'wall'", () => {
    const stores = makeEmptyStores();
    const wall = createWallData();
    stores.wallStore.add(wall);

    const resolved = resolveConstructionObject(wall.id, stores);
    assertDeepEqual(resolved, { type: "wall", id: wall.id }, "resolved wall ref");
  });

  check("resolves a pillar id to type 'pillar'", () => {
    const stores = makeEmptyStores();
    const pillar = createPillarData();
    stores.pillarStore.add(pillar);

    const resolved = resolveConstructionObject(pillar.id, stores);
    assertDeepEqual(resolved, { type: "pillar", id: pillar.id }, "resolved pillar ref");
  });

  check("resolves a beam id to type 'beam'", () => {
    const stores = makeEmptyStores();
    const beam = createBeamData();
    stores.beamStore.add(beam);

    const resolved = resolveConstructionObject(beam.id, stores);
    assertDeepEqual(resolved, { type: "beam", id: beam.id }, "resolved beam ref");
  });

  check("resolves a slab id to type 'slab'", () => {
    const stores = makeEmptyStores();
    const slab = createSlabData();
    stores.slabStore.add(slab);

    const resolved = resolveConstructionObject(slab.id, stores);
    assertDeepEqual(resolved, { type: "slab", id: slab.id }, "resolved slab ref");
  });

  check("resolves an id in no store to undefined", () => {
    const stores = makeEmptyStores();

    const resolved = resolveConstructionObject("does-not-exist", stores);
    assertEqual(resolved, undefined, "unresolved id");
  });

  check("a wall id, a pillar id, a beam id, and a slab id never collide - each resolves to its own store only", () => {
    const stores = makeEmptyStores();
    const wall = createWallData();
    const pillar = createPillarData();
    const beam = createBeamData();
    const slab = createSlabData();
    stores.wallStore.add(wall);
    stores.pillarStore.add(pillar);
    stores.beamStore.add(beam);
    stores.slabStore.add(slab);

    assertEqual(resolveConstructionObject(wall.id, stores)?.type, "wall", "wall id resolves as wall");
    assertEqual(resolveConstructionObject(pillar.id, stores)?.type, "pillar", "pillar id resolves as pillar");
    assertEqual(resolveConstructionObject(beam.id, stores)?.type, "beam", "beam id resolves as beam");
    assertEqual(resolveConstructionObject(slab.id, stores)?.type, "slab", "slab id resolves as slab");
  });

  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) {
    throw new Error(`${failed} verification check(s) failed`);
  }
}

run();
