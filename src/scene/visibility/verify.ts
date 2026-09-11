/**
 * Node-runnable unit verification for VisibilityStore - same "no test
 * framework, plain assertion helpers" convention as every other
 * verify.ts in this project. No DOM/Three.js needed: this store is pure
 * state (a Set + listeners) - see its own docs for why hiding an object
 * never touches a store, a command, or AICommandPipeline.
 */
import { VisibilityStore } from "./VisibilityStore.ts";

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

function assertSameJson(actual: unknown, expected: unknown, message: string): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`${message}: expected ${expectedJson}, got ${actualJson}`);
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

  console.log("VisibilityStore verification\n");

  check("everything starts visible", () => {
    const store = new VisibilityStore();
    assertEqual(store.isHidden("wall-1"), false, "not hidden initially");
    assertSameJson([...store.getHidden()], [], "nothing hidden initially");
  });

  check("setHidden/toggle change exactly one id, isHidden reflects it", () => {
    const store = new VisibilityStore();
    store.setHidden("wall-1", true);
    assertTrue(store.isHidden("wall-1"), "wall-1 hidden");
    assertTrue(!store.isHidden("wall-2"), "wall-2 untouched");
    store.toggle("wall-1");
    assertTrue(!store.isHidden("wall-1"), "toggle un-hides");
    store.toggle("wall-1");
    assertTrue(store.isHidden("wall-1"), "toggle hides again");
  });

  check("setHidden is idempotent - no listener call when the state doesn't change", () => {
    const store = new VisibilityStore();
    let calls = 0;
    store.subscribe(() => {
      calls += 1;
    });
    assertEqual(calls, 1, "subscribe fires immediately once");
    store.setHidden("wall-1", false); // already visible - no-op
    assertEqual(calls, 1, "no extra call for a no-op");
    store.setHidden("wall-1", true);
    assertEqual(calls, 2, "one call for the real change");
    store.setHidden("wall-1", true); // already hidden - no-op
    assertEqual(calls, 2, "still no extra call");
  });

  check("subscribe fires immediately with the current state, and unsubscribe stops further calls", () => {
    const store = new VisibilityStore();
    store.setHidden("wall-1", true);
    const seen: string[][] = [];
    const unsubscribe = store.subscribe((hidden) => seen.push([...hidden].sort()));
    assertSameJson(seen, [["wall-1"]], "fired immediately with the current state");
    store.setHidden("wall-2", true);
    assertSameJson(seen, [["wall-1"], ["wall-1", "wall-2"]], "fired again on a real change");
    unsubscribe();
    store.setHidden("wall-3", true);
    assertEqual(seen.length, 2, "no more calls after unsubscribe");
  });

  check("isolate() hides everything except the kept ids", () => {
    const store = new VisibilityStore();
    store.isolate(["room-1", "bed-1"], ["room-1", "bed-1", "wall-1", "wall-2"]);
    assertTrue(store.isIsolating(), "isolating");
    assertTrue(!store.isHidden("room-1") && !store.isHidden("bed-1"), "kept ids stay visible");
    assertTrue(store.isHidden("wall-1") && store.isHidden("wall-2"), "everything else hidden");
  });

  check("exitIsolation() restores exactly what was hidden before isolating - not everything visible", () => {
    const store = new VisibilityStore();
    store.setHidden("roof-1", true); // hidden BEFORE isolating
    store.isolate(["room-1"], ["room-1", "wall-1", "roof-1"]);
    assertTrue(store.isHidden("wall-1"), "wall-1 hidden by isolation");
    assertTrue(store.isHidden("roof-1"), "roof-1 still hidden (it was, before isolating too)");
    store.exitIsolation();
    assertTrue(!store.isIsolating(), "no longer isolating");
    assertTrue(!store.isHidden("wall-1"), "wall-1 restored - it was never hidden before isolating");
    assertTrue(store.isHidden("roof-1"), "roof-1 still hidden - it was hidden before isolating too");
  });

  check("a second, narrower isolate() call while already isolating does not overwrite the pre-isolation memory", () => {
    const store = new VisibilityStore();
    store.setHidden("roof-1", true);
    store.isolate(["room-1", "room-2"], ["room-1", "room-2", "wall-1"]);
    store.isolate(["room-1"], ["room-1", "room-2", "wall-1"]); // narrow further, still isolating
    assertTrue(store.isHidden("room-2"), "room-2 now hidden too (narrower isolation)");
    store.exitIsolation();
    assertTrue(!store.isHidden("room-1") && !store.isHidden("wall-1"), "back to pre-isolation state");
    assertTrue(store.isHidden("roof-1"), "the ORIGINAL pre-isolation hidden state (roof-1), not a state from the narrower isolate() call");
  });

  check("exitIsolation() when not isolating is a harmless no-op", () => {
    const store = new VisibilityStore();
    store.setHidden("wall-1", true);
    let calls = 0;
    store.subscribe(() => {
      calls += 1;
    });
    const before = calls;
    store.exitIsolation();
    assertEqual(calls, before, "no listener call - nothing changed");
    assertTrue(store.isHidden("wall-1"), "unaffected");
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
