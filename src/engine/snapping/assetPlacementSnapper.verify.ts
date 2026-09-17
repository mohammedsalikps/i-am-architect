/**
 * Node-runnable unit verification for createAssetPlacementSnapper() -
 * same "no test framework, plain assertion helpers" convention as every
 * other verify.ts in this project.
 */
import { createAssetPlacementSnapper } from "./assetPlacementSnapper.ts";

function assertTrue(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function assertClose(actual: number, expected: number, message: string, epsilon = 1e-6): void {
  if (Math.abs(actual - expected) > epsilon) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

interface FakeRecord {
  id: string;
  type: string;
  kind?: string;
  position: { x: number; y: number; z: number };
  rotation: number;
  dimensions: Record<string, number>;
}

function fakeStores(records: readonly FakeRecord[]) {
  const of = (type: string) => ({ getAll: () => records.filter((record) => record.type === type) });
  return {
    wallStore: of("wall"),
    pillarStore: of("pillar"),
    beamStore: of("beam"),
    slabStore: of("slab"),
    doorStore: of("door"),
    windowStore: of("window"),
    // None of these tests place a catalog element - typed as `never[]`
    // (assignable to `readonly ElementData[]`) rather than importing the
    // real, much larger ElementData type just for an always-empty fake.
    elementStore: { getAll: (): never[] => [] }
  };
}

const ASSET_DIMENSIONS = { width: 0.6, height: 0.9, depth: 0.6 };
const ENABLED = { isEnabled: () => true };
const DISABLED = { isEnabled: () => false };

async function run(): Promise<void> {
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

  console.log("createAssetPlacementSnapper verification\n");

  check("snaps a candidate near the grid onto it, but a plain grid snap alone is NOT reported as snapped", () => {
    // The grid is the always-on last resort (see snapMove()'s own docs) -
    // reporting that as "snapped" would make the HUD indicator true
    // almost all the time, which stops being a clear, meaningful signal.
    const snapper = createAssetPlacementSnapper(fakeStores([]), ENABLED);
    const result = snapper.snap({ x: 1.03, z: 2.02 }, ASSET_DIMENSIONS, 0);
    assertClose(result.position.x, 1.0, "x snapped to the 0.1m grid");
    assertClose(result.position.z, 2.0, "z snapped to the 0.1m grid");
    assertTrue(!result.snapped, "a plain grid snap is not reported as a meaningful snap");
  });

  check("snaps onto a nearby wall's corner (point-to-point beats the grid)", () => {
    const wall: FakeRecord = {
      id: "wall-1",
      type: "wall",
      position: { x: 0, y: 0, z: 0 },
      rotation: 0,
      dimensions: { length: 4, height: 2.7, thickness: 0.2 }
    };
    // The wall's own corner is at (length/2, thickness/2) = (2, 0.1) - place the candidate just next to it.
    const snapper = createAssetPlacementSnapper(fakeStores([wall]), ENABLED);
    const result = snapper.snap({ x: 2.05, z: 0.12 }, ASSET_DIMENSIONS, 0);
    assertClose(result.position.x, 2, "x snapped onto the wall's real corner, not the grid");
    assertClose(result.position.z, 0.1, "z snapped onto the wall's real corner, not the grid");
    assertTrue(result.snapped, "point snap counts as snapped");
  });

  check("a candidate far from anything and off-grid still lands on the grid, never left raw", () => {
    const snapper = createAssetPlacementSnapper(fakeStores([]), ENABLED);
    const result = snapper.snap({ x: 5.37, z: -3.14 }, ASSET_DIMENSIONS, 0);
    assertClose(result.position.x, 5.4, "x snapped to grid");
    assertClose(result.position.z, -3.1, "z snapped to grid");
  });

  check("disabled snapping returns the raw candidate unchanged, and snapped:false", () => {
    const snapper = createAssetPlacementSnapper(fakeStores([]), DISABLED);
    const result = snapper.snap({ x: 1.03, z: 2.02 }, ASSET_DIMENSIONS, 0);
    assertClose(result.position.x, 1.03, "x left exactly as given");
    assertClose(result.position.z, 2.02, "z left exactly as given");
    assertTrue(!result.snapped, "disabled snapping is never reported as snapped");
  });

  check("the asset being placed is never a snap target for itself (no self-snap at distance 0)", () => {
    // Regression guard: PREVIEW_ID must never collide with a real stored
    // id, and the preview itself must never appear in `others`.
    const snapper = createAssetPlacementSnapper(fakeStores([]), ENABLED);
    const first = snapper.snap({ x: 1.0, z: 1.0 }, ASSET_DIMENSIONS, 0);
    const second = snapper.snap({ x: 1.02, z: 1.02 }, ASSET_DIMENSIONS, 0);
    assertClose(first.position.x, 1.0, "first call unaffected by any prior call's state");
    assertClose(second.position.x, 1.0, "second call still just grid-snaps - no leftover self-target");
  });

  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) {
    throw new Error(`${failed} verification check(s) failed`);
  }
}

run().catch((error) => {
  console.error(error);
  throw error;
});
