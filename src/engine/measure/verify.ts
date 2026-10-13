/**
 * Node-runnable verification for the Measure tool's pure logic
 * (measure.ts): where a click snaps, and how a distance reads. Same "no
 * test framework, plain assertion helpers" convention as every other
 * verify.ts in this project.
 */
import { describeMeasurement, describeSnap, formatMetres, measureBetween, snapMeasurePoint } from "./measure.ts";
import type { SnapObject } from "../snapping/snapping";

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

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

// A 4 m brick wall centred at (2, 0), running east-west, 230 mm thick.
const wall: SnapObject = { id: "wall-1", type: "wall", position: { x: 2, y: 1.5, z: 0 }, rotation: 0, dimensions: { length: 4, height: 3, thickness: 0.23 } };

console.log("Measure tool verification\n");

check("a click near a wall's end snaps onto that end (its centre line), named in the readout", () => {
  const point = snapMeasurePoint({ x: 0.12, z: 0.05 }, [wall], true);
  assertEqual(`${point.x},${point.z} ${point.snap} ${point.objectId}`, "0,0 endpoint wall-1", "the west end");
  assertEqual(describeSnap(point), "the end of wall-1", "readout");
});

check("a click near a wall's face corner snaps onto the corner", () => {
  const point = snapMeasurePoint({ x: 3.95, z: 0.2 }, [wall], true);
  assertEqual(`${point.x},${point.z} ${point.snap}`, "4,0.115 corner", "the south-east corner of the 230 mm wall");
});

check("away from every object a click goes to the 0.1 m grid; with Snap off it stays exactly where clicked", () => {
  const gridded = snapMeasurePoint({ x: 7.43, z: -2.06 }, [wall], true);
  assertEqual(`${gridded.x},${gridded.z} ${gridded.snap}`, "7.4,-2.1 grid", "grid");
  const free = snapMeasurePoint({ x: 0.12, z: 0.05 }, [wall], false);
  assertEqual(`${free.x},${free.z} ${free.snap}`, "0.12,0.05 free", "Snap off: not even the wall end");
});

check("the distance is the plan distance, with its run east/west and north/south", () => {
  const measurement = measureBetween({ x: 0, z: 0 }, { x: 4, z: -1.38 });
  assertEqual(describeMeasurement(measurement), "4.23 m (4 m east, 1.38 m north)", "diagonal");
  assertEqual(describeMeasurement(measureBetween({ x: 4, z: 0 }, { x: 0, z: 0 })), "4 m west", "along one axis: just the direction");
  assertEqual(describeMeasurement(measureBetween({ x: 1, z: 1 }, { x: 1, z: 1 })), "0 m", "the same point");
  assertEqual(formatMetres(3.769999), "3.77 m", "to the centimetre");
});

check("measuring between a room's inner wall faces gives the clear span, not the centre-line size", () => {
  // Two 230 mm walls whose centre lines are 4 m apart: the faces that face each other are 3.77 m apart.
  const west: SnapObject = { id: "wall-w", type: "wall", position: { x: 0, y: 1.5, z: 0 }, rotation: Math.PI / 2, dimensions: { length: 5, height: 3, thickness: 0.23 } };
  const east: SnapObject = { id: "wall-e", type: "wall", position: { x: 4, y: 1.5, z: 0 }, rotation: Math.PI / 2, dimensions: { length: 5, height: 3, thickness: 0.23 } };
  const a = snapMeasurePoint({ x: 0.1, z: 2.45 }, [west, east], true);
  const b = snapMeasurePoint({ x: 3.9, z: 2.45 }, [west, east], true);
  assertEqual(`${a.snap} ${b.snap}`, "corner corner", "both on face corners");
  assertEqual(describeMeasurement(measureBetween(a, b)), "3.77 m east", "the clear span");
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  throw new Error(`${failed} measure check(s) failed`);
}
