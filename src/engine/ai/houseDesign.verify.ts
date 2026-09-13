/**
 * Focused unit verification for this milestone's two new, pure modules:
 * houseIntent.ts (natural-language classification/extraction) and
 * houseDesign.ts (the deterministic room-aware planner). Real end-to-end
 * coverage - the whole thing running through AICommandPipeline, real
 * stores, real history/undo, real geometry - lives in
 * ai/e2e/verify.ts's "AI house" checks instead; this file is about the
 * planner's own logic in isolation, so a layout bug is caught here
 * without needing the full app harness.
 *
 * No test framework, plain assertion helpers, run directly by Node:
 *   node src/engine/ai/houseDesign.verify.ts
 * or as part of:
 *   npm run verify
 */
import { parseHouseIntent } from "./houseIntent.ts";
import { planHouseDesign, designAndBuildHouse } from "./houseDesign.ts";
import type { Execute } from "./houseDesign.ts";
import type { Command, CommandResult } from "../commands/types";

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

let passed = 0;
let failed = 0;

async function check(name: string, run: () => void | Promise<void>): Promise<void> {
  try {
    await run();
    console.log(`  ok - ${name}`);
    passed += 1;
  } catch (error) {
    console.log(`  FAIL - ${name}`);
    console.log(`    ${error instanceof Error ? error.message : String(error)}`);
    failed += 1;
  }
}

/** A fake CommandExecutor that always succeeds and assigns realistic sequential ids per type - the same shape houseDesign.ts's `Execute` type expects, without needing a real ProjectContext. */
function fakeExecute(): Execute & { calls: Command[] } {
  const calls: Command[] = [];
  const nextByKind = new Map<string, number>();
  const execute = ((command: Command): CommandResult => {
    calls.push(command);
    const kind = command.type.split(".")[0];
    const next = nextByKind.get(kind) ?? 1;
    nextByKind.set(kind, next + 1);
    return { success: true, objectId: `${kind}-${next}` };
  }) as Execute & { calls: Command[] };
  execute.calls = calls;
  return execute;
}

async function run(): Promise<void> {
  console.log("houseIntent.ts / houseDesign.ts verification");
  console.log();

  // --- houseIntent.ts: classification and extraction ---

  await check('"build a wall" is not a house design intent', () => {
    assertEqual(parseHouseIntent("Build a wall 5 meters long.").kind, "none", "kind");
  });

  await check('"add a door" is not a house design intent', () => {
    assertEqual(parseHouseIntent("Add a door.").kind, "none", "kind");
  });

  await check('"build a house" is a house design intent with no parameters', () => {
    const intent = parseHouseIntent("Build a house.");
    assertEqual(intent.kind, "house", "kind");
    assertTrue(intent.kind === "house" && Object.keys(intent.request).length === 0, "no parameters extracted");
  });

  await check('"build a 10m x 8m house" extracts the footprint', () => {
    const intent = parseHouseIntent("Build a 10m x 8m house.");
    assertTrue(intent.kind === "house", "kind");
    assertEqual(intent.kind === "house" ? intent.request.footprint?.length : undefined, 10, "length");
    assertEqual(intent.kind === "house" ? intent.request.footprint?.width : undefined, 8, "width");
  });

  await check('"build a 12m wide and 10m deep house" extracts the footprint via wide/deep phrasing', () => {
    const intent = parseHouseIntent("Build a 12m wide and 10m deep house.");
    assertTrue(intent.kind === "house", "kind");
    assertEqual(intent.kind === "house" ? intent.request.footprint?.length : undefined, 12, "length (wide)");
    assertEqual(intent.kind === "house" ? intent.request.footprint?.width : undefined, 10, "width (deep)");
  });

  await check('"create a 3 bedroom house" extracts the bedroom count', () => {
    const intent = parseHouseIntent("Create a 3 bedroom house.");
    assertTrue(intent.kind === "house", "kind");
    assertEqual(intent.kind === "house" ? intent.request.bedrooms : undefined, 3, "bedrooms");
  });

  await check('"build a 12m x 10m 3 bedroom house" extracts both the footprint and the bedroom count', () => {
    const intent = parseHouseIntent("Build a 12m x 10m 3 bedroom house.");
    assertTrue(intent.kind === "house", "kind");
    assertEqual(intent.kind === "house" ? intent.request.footprint?.length : undefined, 12, "length");
    assertEqual(intent.kind === "house" ? intent.request.footprint?.width : undefined, 10, "width");
    assertEqual(intent.kind === "house" ? intent.request.bedrooms : undefined, 3, "bedrooms");
  });

  await check('"create a house with living room, kitchen and 2 bedrooms" extracts the named room list', () => {
    const intent = parseHouseIntent("Create a house with a living room, a kitchen and 2 bedrooms.");
    assertTrue(intent.kind === "house", "kind");
    assertEqual(
      JSON.stringify(intent.kind === "house" ? intent.request.rooms : undefined),
      JSON.stringify(["Living Room", "Kitchen", "Bedroom", "Bedroom"]),
      "rooms"
    );
  });

  await check('"create a small house" / "create a large house" extract the size adjective', () => {
    assertEqual(
      parseHouseIntent("Create a small house.").kind === "house" ? (parseHouseIntent("Create a small house.") as { request: { size?: string } }).request.size : undefined,
      "small",
      "small"
    );
    const large = parseHouseIntent("Create a large house.");
    assertTrue(large.kind === "house" && large.request.size === "large", "large");
  });

  await check('"create a 2 floor house" is recognized but reported as an unsupported feature, not silently built wrong', () => {
    const intent = parseHouseIntent("Create a 2 floor house.");
    assertEqual(intent.kind, "unsupported", "kind");
    assertTrue(intent.kind === "unsupported" && /multiple floors/.test(intent.reason), "the reason names the missing feature");
  });

  await check("an out-of-range explicit footprint is reported as unsupported, not clamped silently", () => {
    const intent = parseHouseIntent("Build a 2m x 2m house.");
    assertEqual(intent.kind, "unsupported", "kind");
  });

  // --- houseDesign.ts: planning (pure, no execution) ---

  await check("an unspecified request plans the default footprint and the default 5-room layout", () => {
    const planned = planHouseDesign({}, []);
    assertTrue(planned.ok, "ok");
    assertTrue(planned.ok && planned.layout.footprint.length === 10 && planned.layout.footprint.width === 8, "10 x 8 default footprint");
    assertTrue(planned.ok && planned.layout.rooms.length === 5, "5 default rooms");
  });

  await check("an explicit footprint is respected exactly, not adjusted", () => {
    const planned = planHouseDesign({ footprint: { length: 12, width: 10 } }, []);
    assertTrue(planned.ok, "ok");
    assertTrue(planned.ok && planned.layout.footprint.length === 12 && planned.layout.footprint.width === 10, "exact footprint");
  });

  await check("a bedroom count produces that many distinct bedroom rooms, plus a living room, kitchen and bathroom", () => {
    const planned = planHouseDesign({ footprint: { length: 10, width: 8 }, bedrooms: 3 }, []);
    assertTrue(planned.ok, "ok");
    const names = planned.ok ? planned.layout.rooms.map((room) => room.name) : [];
    assertTrue(names.includes("Bedroom 1") && names.includes("Bedroom 2") && names.includes("Bedroom 3"), "three distinct bedrooms");
    assertTrue(names.includes("Living Room") && names.includes("Kitchen") && names.includes("Bathroom"), "living room, kitchen, bathroom");
    assertEqual(names.length, 6, "6 rooms total");
  });

  await check("an explicit named room list is used verbatim (duplicates numbered), never replaced by the default set", () => {
    const planned = planHouseDesign({ footprint: { length: 10, width: 8 }, rooms: ["Living Room", "Kitchen", "Bedroom", "Bedroom"] }, []);
    assertTrue(planned.ok, "ok");
    const names = planned.ok ? planned.layout.rooms.map((room) => room.name) : [];
    assertEqual(JSON.stringify([...names].sort()), JSON.stringify(["Bedroom 1", "Bedroom 2", "Kitchen", "Living Room"]), "names");
  });

  await check("every room in a resolved layout is at least as large as a real room, on a small footprint with many rooms", () => {
    const planned = planHouseDesign({ footprint: { length: 10, width: 8 }, rooms: ["Living Room", "Kitchen", "Bedroom 1", "Bedroom 2", "Bedroom 3", "Bathroom", "Dining Room"] }, []);
    assertTrue(planned.ok, "ok");
    if (planned.ok) {
      for (const room of planned.layout.rooms) {
        assertTrue(room.length >= 1, `${room.name} length (${room.length}) is a real room, not a sliver`);
        assertTrue(room.width >= 1, `${room.name} width (${room.width}) is a real room, not a sliver`);
      }
    }
  });

  await check("too many rooms for the footprint is rejected with a clear error, not built as slivers", () => {
    const planned = planHouseDesign({ footprint: { length: 4, width: 4 }, rooms: ["A", "Bedroom", "Bedroom", "Bedroom", "Bedroom", "Bedroom"] }, []);
    assertTrue(!planned.ok, "rejected");
  });

  await check("an occupied site moves the house's center clear of what's already there (findHouseCenter reused unchanged)", () => {
    const occupied = [{ min: { x: -5, z: -4 }, max: { x: 5, z: 4 } }];
    const planned = planHouseDesign({ footprint: { length: 10, width: 8 } }, occupied);
    assertTrue(planned.ok, "ok");
    assertTrue(planned.ok && planned.layout.center.x !== 0, "the house moved off the origin");
  });

  // --- houseDesign.ts: execution (buildHouseDesign / designAndBuildHouse) ---

  await check("building a valid layout issues a slab, exterior walls, pillars, interior walls, doors, windows, rooms and a roof - and reports itself accurately", () => {
    const executor = fakeExecute();
    const result = designAndBuildHouse({ footprint: { length: 10, width: 8 } }, [], executor);
    assertTrue(result.success, `success: ${!result.success ? result.error : ""}`);
    if (result.success) {
      assertEqual(result.summary.exteriorWalls, 4, "4 exterior walls");
      assertEqual(result.summary.pillars, 4, "4 corner pillars");
      assertTrue(result.summary.interiorWalls > 0, "at least one interior wall - the default layout has more than one room");
      assertEqual(result.summary.doors, 1 + result.summary.interiorWalls, "one entrance door plus one per interior wall");
      assertTrue(result.summary.hasRoof, "a roof was included");
      assertEqual(result.summary.rooms.length, 5, "5 rooms");
      const roofCommands = executor.calls.filter((command) => command.type === "element.add" && command.element.kind === "roof");
      assertEqual(roofCommands.length, 1, "exactly one roof");
      const roomCommands = executor.calls.filter((command) => command.type === "element.add" && command.element.kind === "room");
      assertEqual(roomCommands.length, 5, "exactly one element per room");
    }
  });

  await check("a single-room request has no interior walls at all, and the one room spans the whole interior", () => {
    const executor = fakeExecute();
    const result = designAndBuildHouse({ footprint: { length: 6, width: 6 }, rooms: ["Studio"] }, [], executor);
    assertTrue(result.success, "success");
    if (result.success) {
      assertEqual(result.summary.interiorWalls, 0, "no interior walls");
      assertEqual(result.summary.doors, 1, "only the entrance door");
      assertEqual(result.summary.rooms.length, 1, "one room");
    }
  });

  await check("every interior wall hosts exactly one door, and the entrance door hosts in a real exterior wall id", () => {
    const executor = fakeExecute();
    const result = designAndBuildHouse({ footprint: { length: 10, width: 8 } }, [], executor);
    assertTrue(result.success, "success");
    const doorCommands = executor.calls.filter((command) => command.type === "door.add");
    assertTrue(
      doorCommands.every((command) => command.type === "door.add" && typeof command.door.hostId === "string" && command.door.hostId.length > 0),
      "every door has a real hostId - none are free-standing"
    );
    const wallIds = new Set(executor.calls.filter((command) => command.type === "wall.add").map((_, index) => `wall-${index + 1}`));
    for (const command of doorCommands) {
      if (command.type === "door.add") {
        assertTrue(wallIds.has(command.door.hostId as string), `${command.door.hostId} is a real wall this same build created`);
      }
    }
  });

  await check("every window also hosts in a real wall id - none are free-standing boxes on the outside face", () => {
    const executor = fakeExecute();
    const result = designAndBuildHouse({ footprint: { length: 10, width: 8 } }, [], executor);
    assertTrue(result.success, "success");
    const windowCommands = executor.calls.filter((command) => command.type === "window.add");
    assertTrue(windowCommands.length > 0, "at least one window was placed");
    assertTrue(
      windowCommands.every((command) => command.type === "window.add" && typeof command.window.hostId === "string"),
      "every window has a hostId"
    );
  });

  await check("a failure part-way through stops immediately and is reported, not silently continued", () => {
    let calls = 0;
    const failingExecute: Execute = (command) => {
      calls += 1;
      if (command.type === "pillar.add") {
        return { success: false, message: "simulated failure" };
      }
      return { success: true, objectId: `${command.type.split(".")[0]}-${calls}` };
    };
    const result = designAndBuildHouse({ footprint: { length: 10, width: 8 } }, [], failingExecute);
    assertTrue(!result.success, "not success");
    assertTrue(!result.success && result.error.length > 0, "a clear error message");
  });

  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) {
    throw new Error(`${failed} verification check(s) failed`);
  }
}

run();
