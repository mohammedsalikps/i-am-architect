/**
 * Node-runnable unit verification for tryDeterministicIntent() - same
 * "no test framework, plain assertion helpers" convention as every other
 * verify.ts in this project. End-to-end coverage (a real AICommandPipeline
 * run that never calls the provider, and produces one real, undoable
 * command) lives in ai/verify.ts; this file is the pure matcher/planner
 * in isolation, using a hand-built AIProjectContext rather than the real
 * engine.
 */
import { tryDeterministicIntent } from "./deterministicIntent.ts";
import { analyzeConstructionGeometry } from "./geometry/analyzeConstructionGeometry.ts";
import type { AIProjectContext, AIContextObject } from "./types";

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

function makeContext(objects: AIContextObject[], selectedObjectId: string | null): AIProjectContext {
  const snapshot = {
    wallCount: objects.filter((object) => object.type === "wall").length,
    pillarCount: 0,
    beamCount: 0,
    slabCount: 0,
    doorCount: 0,
    windowCount: 0,
    assemblyCount: 0,
    selectedObjectId,
    objects,
    assemblies: []
  };
  return { ...snapshot, geometry: analyzeConstructionGeometry(snapshot) };
}

function wall(id: string, overrides: Partial<AIContextObject> = {}): AIContextObject {
  return {
    id,
    type: "wall",
    position: { x: 0, y: 1.35, z: 0 },
    rotation: 0,
    dimensions: { length: 4, height: 2.7, thickness: 0.2 },
    material: "concrete",
    color: "#ffffff",
    assemblyIds: [],
    ...overrides
  };
}

function asset(id: string, overrides: Partial<AIContextObject> = {}): AIContextObject {
  return {
    id,
    type: "asset",
    assetId: "sofa",
    label: "Sofa",
    position: { x: 0, y: 0.4, z: 0 },
    rotation: 0,
    dimensions: { width: 2, height: 0.8, depth: 0.9 },
    material: "fabric",
    color: "#888888",
    assemblyIds: [],
    ...overrides
  };
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

  console.log("deterministicIntent verification\n");

  check('an unrelated instruction never matches - falls through to the provider ("none")', () => {
    const context = makeContext([wall("wall-1")], "wall-1");
    const result = tryDeterministicIntent("Add a window to the selected wall", context);
    assertEqual(result.kind, "none", "kind");
  });

  check('"make the selected wall N meters long" matches and produces the real update_object command', () => {
    const context = makeContext([wall("wall-1")], "wall-1");
    const result = tryDeterministicIntent("Make the selected wall 6 meters long", context);
    assertEqual(result.kind, "matched", "kind");
    assertTrue(result.kind === "matched", "narrowing");
    assertDeepEqual(result.command, { type: "update_object", objectId: "wall-1", changes: { dimensions: { length: 6 } } }, "command");
  });

  check("the wall-length phrasing tolerates \"metres\"/\"m\" and a trailing period", () => {
    const context = makeContext([wall("wall-1")], "wall-1");
    for (const phrase of ["Set the selected wall 5 metres long.", "make the selected wall 5m long"]) {
      const result = tryDeterministicIntent(phrase, context);
      assertEqual(result.kind, "matched", `kind for "${phrase}"`);
    }
  });

  check('"make the selected wall N meters long" is rejected locally (never reaches the provider) when nothing is selected', () => {
    const context = makeContext([wall("wall-1")], null);
    const result = tryDeterministicIntent("Make the selected wall 6 meters long", context);
    assertEqual(result.kind, "rejected", "kind");
    assertTrue(result.kind === "rejected" && result.reason.includes("Nothing is selected"), "reason");
  });

  check('"make the selected wall N meters long" is rejected when the selection is not a wall', () => {
    const context = makeContext([asset("sofa-1")], "sofa-1");
    const result = tryDeterministicIntent("Make the selected wall 6 meters long", context);
    assertEqual(result.kind, "rejected", "kind");
    assertTrue(result.kind === "rejected" && result.reason.includes("not a wall"), "reason");
  });

  check('"rotate the selected <noun> N degrees" adds the requested turn to the CURRENT rotation, in radians', () => {
    const context = makeContext([asset("sofa-1", { rotation: Math.PI / 2 })], "sofa-1");
    const result = tryDeterministicIntent("Rotate the selected sofa 90 degrees", context);
    assertEqual(result.kind, "matched", "kind");
    assertTrue(result.kind === "matched", "narrowing");
    const changes = (result.command.changes as { rotation: number });
    assertTrue(Math.abs(changes.rotation - Math.PI) < 1e-9, "90deg + 90deg (already turned) = 180deg = pi radians");
  });

  check('"move the selected <noun> N meters to the right/left/forward/back" adds a world-axis delta to the CURRENT position', () => {
    const context = makeContext([asset("sofa-1", { position: { x: 1, y: 0.4, z: 2 } })], "sofa-1");
    const cases: { phrase: string; expected: { x: number; z: number } }[] = [
      { phrase: "Move the selected sofa 2 meters to the right", expected: { x: 3, z: 2 } },
      { phrase: "Move the selected sofa 2 meters to the left", expected: { x: -1, z: 2 } },
      { phrase: "Move the selected sofa 2 meters to the forward", expected: { x: 1, z: 4 } },
      { phrase: "Move the selected sofa 2 meters to the back", expected: { x: 1, z: 0 } }
    ];
    for (const { phrase, expected } of cases) {
      const result = tryDeterministicIntent(phrase, context);
      assertEqual(result.kind, "matched", `kind for "${phrase}"`);
      assertTrue(result.kind === "matched", "narrowing");
      assertDeepEqual(
        result.command,
        { type: "update_object", objectId: "sofa-1", changes: { position: expected } },
        `command for "${phrase}"`
      );
    }
  });

  check("rotate/move intents are rejected locally when nothing is selected", () => {
    const context = makeContext([wall("wall-1")], null);
    const rotate = tryDeterministicIntent("Rotate the selected sofa 90 degrees", context);
    const move = tryDeterministicIntent("Move the selected sofa 2 meters to the right", context);
    assertEqual(rotate.kind, "rejected", "rotate.kind");
    assertEqual(move.kind, "rejected", "move.kind");
  });

  check("phrasing is matched case-insensitively and requires the exact structure - a vaguer instruction falls through", () => {
    const context = makeContext([wall("wall-1")], "wall-1");
    assertEqual(tryDeterministicIntent("MAKE THE SELECTED WALL 6 METERS LONG", context).kind, "matched", "uppercase still matches");
    assertEqual(tryDeterministicIntent("Make the wall a bit longer", context).kind, "none", "vague phrasing never matches");
    assertEqual(tryDeterministicIntent("Make the living room bigger", context).kind, "none", "an open-ended edit never matches");
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
