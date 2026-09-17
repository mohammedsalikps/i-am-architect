/**
 * Node-runnable unit verification for resolveCommandReferences() - same
 * "no test framework, plain assertion helpers" convention as every other
 * verify.ts in this project. End-to-end coverage (a real AI response
 * whose second command references the first's real id, via
 * AICommandPipeline) lives in ai/verify.ts; this file is the pure
 * function in isolation.
 */
import { isReferenceToken, resolveCommandReferences } from "./referenceResolution.ts";
import type { CommandResult } from "../commands/types";

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

  console.log("referenceResolution verification\n");

  check("isReferenceToken recognizes every supported token and rejects a real id", () => {
    assertTrue(isReferenceToken("$previous"), "$previous");
    assertTrue(isReferenceToken("$step:0"), "$step:0");
    assertTrue(isReferenceToken("$step:12"), "$step:12");
    assertTrue(isReferenceToken("$selection"), "$selection");
    assertTrue(!isReferenceToken("wall-1"), "a real id is not a token");
    assertTrue(!isReferenceToken("$unknown"), "an unrecognized $-prefixed word is not a valid token");
    assertTrue(!isReferenceToken(42), "a non-string is never a token");
  });

  const succeeded = (objectId: string): CommandResult => ({ success: true, objectId, message: "ok" });
  const failedResult: CommandResult = { success: false, message: "nope" };

  check("a command with no reference token at all passes through completely unchanged (same reference)", () => {
    const raw = { type: "wall.add", wall: { length: 4 } };
    const resolved = resolveCommandReferences(raw, 2, [succeeded("wall-1"), succeeded("wall-2")], null);
    assertTrue(resolved.ok, "resolved.ok");
    assertTrue(resolved.command === raw, "the exact same object, not a copy");
  });

  check('"$previous" in update_object.objectId resolves to the immediately preceding command\'s real id', () => {
    const raw = { type: "update_object", objectId: "$previous", changes: { material: "concrete" } };
    const resolved = resolveCommandReferences(raw, 2, [succeeded("wall-1"), succeeded("room-1")], null);
    assertTrue(resolved.ok, "resolved.ok");
    assertDeepEqual(resolved.command, { type: "update_object", objectId: "room-1", changes: { material: "concrete" } }, "objectId resolved");
  });

  check('"$step:N" resolves to that specific earlier command\'s real id, not necessarily the immediately preceding one', () => {
    const raw = { type: "asset.add", asset: { assetId: "bed", roomId: "$step:0" } };
    const resolved = resolveCommandReferences(raw, 2, [succeeded("room-1"), succeeded("wall-3")], null);
    assertTrue(resolved.ok, "resolved.ok");
    assertDeepEqual(resolved.command, { type: "asset.add", asset: { assetId: "bed", roomId: "room-1" } }, "roomId resolved to command 0's id, skipping command 1");
  });

  check('"$selection" resolves to the selection given at the start of the request, independent of priorResults', () => {
    const raw = { type: "update_object", objectId: "$selection", changes: { material: "concrete" } };
    const resolved = resolveCommandReferences(raw, 0, [], "wall-7");
    assertTrue(resolved.ok, "resolved.ok");
    assertDeepEqual(resolved.command, { type: "update_object", objectId: "wall-7", changes: { material: "concrete" } }, "objectId resolved to the selection");
  });

  check('"$selection" fails cleanly when nothing is selected', () => {
    const raw = { type: "update_object", objectId: "$selection", changes: {} };
    const resolved = resolveCommandReferences(raw, 0, [], null);
    assertEqual(resolved.ok, false, "resolved.ok");
    assertTrue(!resolved.ok && resolved.message.includes("nothing is selected"), "explains why");
  });

  check("a forward reference (to a command at or after this one) is rejected, never executed as if it resolved", () => {
    const raw = { type: "update_object", objectId: "$step:1", changes: {} };
    const resolved = resolveCommandReferences(raw, 1, [succeeded("wall-1")], null);
    assertEqual(resolved.ok, false, "resolved.ok");
    assertTrue(!resolved.ok && resolved.message.includes("earlier command"), "explains why");
  });

  check("a reference to a command that failed (so has no real object to point at) is rejected", () => {
    const raw = { type: "update_object", objectId: "$previous", changes: {} };
    const resolved = resolveCommandReferences(raw, 1, [failedResult], null);
    assertEqual(resolved.ok, false, "resolved.ok");
    assertTrue(!resolved.ok && resolved.message.includes("did not create an object"), "explains why");
  });

  check("a reference to a command that succeeded but created nothing (e.g. an update) is rejected the same way", () => {
    const raw = { type: "update_object", objectId: "$previous", changes: {} };
    const resolved = resolveCommandReferences(raw, 1, [{ success: true, message: "ok" }], null);
    assertEqual(resolved.ok, false, "resolved.ok");
  });

  check("hostId, roomId, and connect endpoint ids all resolve the same way, independently", () => {
    const doorRaw = { type: "door.add", door: { hostId: "$previous" } };
    const doorResolved = resolveCommandReferences(doorRaw, 1, [succeeded("wall-1")], null);
    assertTrue(doorResolved.ok, "door hostId resolved");
    assertDeepEqual(doorResolved.command, { type: "door.add", door: { hostId: "wall-1" } }, "door hostId");

    const connectRaw = { type: "element.connect", from: { id: "$step:0" }, to: { id: "$step:1" } };
    const connectResolved = resolveCommandReferences(connectRaw, 2, [succeeded("water-pipe-1"), succeeded("water-pipe-2")], null);
    assertTrue(connectResolved.ok, "connect ids resolved");
    assertDeepEqual(
      connectResolved.command,
      { type: "element.connect", from: { id: "water-pipe-1" }, to: { id: "water-pipe-2" } },
      "both endpoints resolved independently"
    );
  });

  check("resolving one field never mutates the original raw command object", () => {
    const raw = { type: "update_object", objectId: "$previous", changes: { material: "concrete" } };
    const before = JSON.stringify(raw);
    resolveCommandReferences(raw, 1, [succeeded("wall-1")], null);
    assertEqual(JSON.stringify(raw), before, "raw command left untouched");
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
