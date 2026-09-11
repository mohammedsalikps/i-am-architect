/**
 * Node-runnable unit verification for computeFitCamera() - pure math
 * over THREE.Box3/Vector3, no THREE.Camera/DOM/WebGL needed (three.js's
 * math classes run fine under plain Node - see fitCamera.ts's own docs).
 * Same "no test framework, plain assertion helpers" convention as every
 * other verify.ts in this project.
 */
import * as THREE from "three";
import { computeFitCamera } from "./fitCamera.ts";

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

  console.log("computeFitCamera verification\n");

  check("frames a box centered on the origin: the target is the box's center", () => {
    const box = new THREE.Box3(new THREE.Vector3(-1, 0, -1), new THREE.Vector3(1, 2, 1));
    const { target } = computeFitCamera(box, new THREE.Vector3(1, 1, 1), { fovDegrees: 60 });
    assertClose(target.x, 0, "target x");
    assertClose(target.y, 1, "target y");
    assertClose(target.z, 0, "target z");
  });

  check("the camera sits along the given direction from the target, at the returned distance", () => {
    const box = new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));
    const direction = new THREE.Vector3(0, 0, 1); // straight along +Z
    const { position, target, distance } = computeFitCamera(box, direction, { fovDegrees: 60 });
    assertClose(position.x, target.x, "position.x == target.x (direction has no X component)");
    assertClose(position.y, target.y, "position.y == target.y (direction has no Y component)");
    assertClose(position.z, target.z + distance, "position.z == target.z + distance along +Z");
  });

  check("a bigger box needs a bigger distance, at the same FOV", () => {
    const small = new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));
    const big = new THREE.Box3(new THREE.Vector3(-5, -5, -5), new THREE.Vector3(5, 5, 5));
    const direction = new THREE.Vector3(1, 1, 1);
    const smallFit = computeFitCamera(small, direction, { fovDegrees: 60 });
    const bigFit = computeFitCamera(big, direction, { fovDegrees: 60 });
    assertTrue(bigFit.distance > smallFit.distance, "bigger box -> bigger distance");
  });

  check("a narrower FOV needs a bigger distance to frame the same box", () => {
    const box = new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));
    const direction = new THREE.Vector3(0, 1, 0);
    const wide = computeFitCamera(box, direction, { fovDegrees: 90 });
    const narrow = computeFitCamera(box, direction, { fovDegrees: 30 });
    assertTrue(narrow.distance > wide.distance, "narrower FOV -> further back to still frame the box");
  });

  check("minDistance is a floor for a very small (or point-like) box", () => {
    const point = new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, 0));
    const { distance } = computeFitCamera(point, new THREE.Vector3(1, 0, 0), { fovDegrees: 60, minDistance: 3 });
    assertTrue(distance >= 3, `distance ${distance} should be at least minDistance 3`);
  });

  check("a zero-length direction falls back to a sane default rather than producing NaN", () => {
    const box = new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));
    const { position } = computeFitCamera(box, new THREE.Vector3(0, 0, 0), { fovDegrees: 60 });
    assertTrue(Number.isFinite(position.x) && Number.isFinite(position.y) && Number.isFinite(position.z), "position is finite, not NaN");
  });

  check("padding increases distance - more breathing room around the content", () => {
    const box = new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));
    const direction = new THREE.Vector3(1, 1, 1);
    const tight = computeFitCamera(box, direction, { fovDegrees: 60, padding: 1.0 });
    const padded = computeFitCamera(box, direction, { fovDegrees: 60, padding: 2.0 });
    assertTrue(padded.distance > tight.distance, "more padding -> further back");
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
