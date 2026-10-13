/**
 * Verification for the conversational architect (engine/architect/):
 * the utterance parser, the interiors planner, and a whole conversation -
 * site, location, clarification, staged build, undo, edits - driven
 * through the REAL ProjectContext (real stores, CommandExecutor and
 * HistoryManager), exactly as main.ts wires it. Like ai/e2e/verify.ts,
 * this needs `--experimental-transform-types` (the real *HistoryController
 * classes use parameter properties) - see the root package.json.
 */
import { createProjectContext } from "../project/ProjectContext.ts";
import type { ProjectContext } from "../project/ProjectContext.ts";
import { buildAIProjectSnapshot } from "../ai/types.ts";
import { AIService } from "../ai/AIService.ts";
import { MockAIProvider } from "../ai/MockAIProvider.ts";
import { planHouseDesign } from "../ai/houseDesign.ts";
import type { HouseLayout } from "../ai/houseDesign.ts";
import type { HouseDesignRequest } from "../ai/houseIntent.ts";
import { SLAB_THICKNESS } from "../ai/housePlan.ts";
import { getAssetDefinition } from "../assets/catalog.ts";
import { ArchitectSession } from "./ArchitectSession.ts";
import type { ArchitectReply } from "./ArchitectSession.ts";
import { planFurnishings } from "./interiors.ts";
import { parseUtterance } from "./parseUtterance.ts";
import { describeRoom, listRooms, resolveRooms } from "./roomModel.ts";
import { BackendAIProvider } from "../ai/providers/BackendAIProvider.ts";
import { createMockBackend } from "../ai/e2e/mockBackend.ts";
import type { MockBackendHandler } from "../ai/e2e/mockBackend.ts";

let passed = 0;
let failed = 0;

function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(
      () => {
        passed += 1;
        console.log(`  ok - ${name}`);
      },
      (error: unknown) => {
        failed += 1;
        console.log(`  FAIL - ${name}\n      ${error instanceof Error ? error.message : String(error)}`);
      }
    );
}

function assertTrue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function assertIncludes(text: string, needle: string, message: string): void {
  if (!text.toLowerCase().includes(needle.toLowerCase())) throw new Error(`${message}: expected ${JSON.stringify(text)} to include ${JSON.stringify(needle)}`);
}

interface Wired {
  context: ProjectContext;
  session: ArchitectSession;
  say: (text: string) => Promise<ArchitectReply>;
  stageStatus: () => Record<string, string>;
  count: () => Record<string, number>;
}

/** Wires a session the way main.ts does - the shared executor and history, a fresh snapshot per turn, the real AIService (with the offline MockAIProvider) as the fallback. */
function wire(): Wired {
  const context = createProjectContext();
  const service = new AIService({ provider: new MockAIProvider(), commandExecutor: context.commandExecutor, history: context.history, snapshotSource: context });
  const session = new ArchitectSession({
    commandExecutor: context.commandExecutor,
    history: context.history,
    snapshot: () => buildAIProjectSnapshot(context),
    undo: () => context.history.undo(),
    fallback: (instruction) => service.submit(instruction)
  });
  return {
    context,
    session,
    say: (text) => session.handle(text),
    stageStatus: () => Object.fromEntries((session.getState().stages ?? []).map((stage) => [stage.id, stage.status])),
    count: () => ({
      walls: context.wallStore.getAll().length,
      pillars: context.pillarStore.getAll().length,
      slabs: context.slabStore.getAll().length,
      doors: context.doorStore.getAll().length,
      windows: context.windowStore.getAll().length,
      rooms: context.elementStore.getAll().filter((element) => element.kind === "room").length,
      roofs: context.elementStore.getAll().filter((element) => element.kind === "roof").length,
      sites: context.elementStore.getAll().filter((element) => element.kind === "landscape").length,
      assets: context.assetStore.getAll().length
    })
  };
}

/** The startup wall main.ts adds to every fresh project - at z = -4, inside any house centred on the origin. */
function addStartupWall(context: ProjectContext): string {
  const result = context.commandExecutor.execute({ type: "wall.add", wall: { position: { z: -4 } } });
  context.history.clearHistory();
  assertTrue(result.success && result.objectId, "startup wall");
  return result.objectId!;
}

async function main(): Promise<void> {
  console.log("parseUtterance");
  const expectations: [string, string, string?][] = [
    ["Set up a 30 × 20 m site", "site"],
    ["a 600 sqm plot", "site"],
    ["Pick on site", "pick-location"],
    ["Use the site centre", "location"],
    ["at 4, -2", "location"],
    ["Build a house", "house"],
    ["I want a 3 bedroom home here", "house"],
    ["3 bedrooms, 12 x 9 m", "details"],
    ["three", "details"],
    ["yes, lay the foundation", "stage", "foundation"],
    ["Raise the walls", "stage", "structure"],
    ["Add the doors and windows", "stage", "openings"],
    ["Mark out the rooms", "stage", "rooms"],
    ["Put the roof on", "stage", "roof"],
    ["Furnish the living room", "stage", "interiors"],
    ["Build the rest of the house", "all"],
    ["next", "next"],
    ["Add a window to the selected wall", "single-opening"],
    ["Clear them and build here", "clear-conflicts"],
    // Left to the existing AI pipeline, exactly as before:
    ["Add a wall 5m long", "unknown"],
    ["Make the selected wall 5 meters long", "unknown"]
  ];
  for (const [text, kind, stage] of expectations) {
    await check(`"${text}" → ${kind}${stage ? `:${stage}` : ""}`, () => {
      const parsed = parseUtterance(text);
      assertEqual(parsed.kind, kind, text);
      if (stage) assertEqual((parsed as { stage?: string }).stage, stage, `${text} stage`);
    });
  }
  await check("coordinates are read as plan points", () => {
    const parsed = parseUtterance("x=5 z=-3");
    assertTrue(parsed.kind === "location" && parsed.location.kind === "point", "point");
    assertEqual(parsed.location.point.x, 5, "x");
    assertEqual(parsed.location.point.z, -3, "z");
  });

  console.log("planFurnishings");
  const layouts: [string, HouseLayout][] = [];
  const requests: [string, HouseDesignRequest][] = [
    ["1 bed 7x6", { bedrooms: 1, footprint: { length: 7, width: 6 } }],
    ["2 bed 10x8", { bedrooms: 2, footprint: { length: 10, width: 8 } }],
    ["3 bed 12x9", { bedrooms: 3, footprint: { length: 12, width: 9 } }],
    ["4 bed 13x10", { bedrooms: 4, footprint: { length: 13, width: 10 } }],
    ["studio 6x6", { rooms: ["Studio"], footprint: { length: 6, width: 6 } }],
    ["named 14x10", { rooms: ["Living Room", "Kitchen", "Dining Room", "Study", "Bedroom", "Bathroom"], footprint: { length: 14, width: 10 } }]
  ];
  for (const [label, request] of requests) {
    const planned = planHouseDesign(request, [], { x: 3, z: -2 });
    assertTrue(planned.ok, `plan ${label}`);
    layouts.push([label, planned.layout]);
  }
  for (const [label, layout] of layouts) {
    await check(`${label}: every piece stands inside its own room, on the slab, without overlapping another`, () => {
      const plan = planFurnishings(layout);
      assertTrue(plan.commands.length > 0, "something is placed");
      for (const room of layout.rooms) {
        const indices = plan.byRoom.get(room.name) ?? [];
        const rects = indices.map((index) => {
          const { assetId, position } = plan.commands[index].asset;
          const definition = getAssetDefinition(assetId)!;
          const { depth, height } = definition.defaultDimensions;
          const width = plan.commands[index].asset.dimensions?.width ?? definition.defaultDimensions.width;
          assertEqual(position!.y, Math.round((SLAB_THICKNESS + height / 2) * 1e6) / 1e6, `${assetId} y`);
          // Turned a quarter, a piece's width runs along Z instead of X.
          const sideways = Math.abs(Math.abs(plan.commands[index].asset.rotation ?? 0) - Math.PI / 2) < 1e-6;
          const halfX = (sideways ? depth : width) / 2;
          const halfZ = (sideways ? width : depth) / 2;
          const rect = { x0: position!.x! - halfX, x1: position!.x! + halfX, z0: position!.z! - halfZ, z1: position!.z! + halfZ, flat: assetId === "rug", assetId };
          const eps = 1e-6;
          assertTrue(
            rect.x0 >= room.center.x - room.length / 2 - eps &&
              rect.x1 <= room.center.x + room.length / 2 + eps &&
              rect.z0 >= room.center.z - room.width / 2 - eps &&
              rect.z1 <= room.center.z + room.width / 2 + eps,
            `${assetId} inside ${room.name}`
          );
          return rect;
        });
        for (let i = 0; i < rects.length; i += 1) {
          for (let j = i + 1; j < rects.length; j += 1) {
            const a = rects[i];
            const b = rects[j];
            if (a.flat || b.flat) continue;
            const overlap = a.x0 < b.x1 - 1e-6 && a.x1 > b.x0 + 1e-6 && a.z0 < b.z1 - 1e-6 && a.z1 > b.z0 + 1e-6;
            assertTrue(!overlap, `${a.assetId} and ${b.assetId} overlap in ${room.name}`);
          }
        }
      }
    });
  }
  await check("bedrooms get a bed, the kitchen a counter, the bathroom a toilet", () => {
    const layout = layouts[2][1];
    const plan = planFurnishings(layout);
    const piecesIn = (room: string) => (plan.byRoom.get(room) ?? []).map((index) => plan.commands[index].asset.assetId);
    assertTrue(piecesIn("Bedroom 1").includes("bed"), "bed");
    assertTrue(piecesIn("Kitchen").includes("kitchen-counter"), "counter");
    assertTrue(piecesIn("Bathroom").includes("toilet"), "toilet");
    assertTrue(piecesIn("Living Room").includes("sofa"), "sofa");
  });
  await check("planning is deterministic", () => {
    assertEqual(JSON.stringify(planFurnishings(layouts[3][1])), JSON.stringify(planFurnishings(layouts[3][1])), "same layout, same plan");
  });

  console.log("ArchitectSession - the whole workflow, through the real ProjectContext");
  const app = wire();
  const startupWall = addStartupWall(app.context);
  let r: ArchitectReply;

  await check("greets with a site/house starting point", () => {
    r = app.session.greeting();
    assertTrue(r.choices.length >= 2, "choices");
  });
  await check("defines the site as a real, editable landscape element", async () => {
    r = await app.say("Set up a 30 x 20 m site");
    assertEqual(r.tone, "success", r.text);
    assertEqual(app.count().sites, 1, "one site");
    const site = app.context.elementStore.getAll().find((element) => element.kind === "landscape")!;
    assertEqual(site.label, "Site", "label");
    assertEqual(site.dimensions.length, 30, "length");
    assertEqual(site.dimensions.width, 20, "width");
    assertTrue(app.session.getState().site, "state shows the site");
  });
  await check("an ambiguous “build a house” asks for its size instead of guessing", async () => {
    r = await app.say("Build a house");
    assertEqual(r.tone, "question", r.text);
    assertTrue(r.choices.some((choice) => /3 bedrooms/.test(choice.say)), "size presets");
    assertEqual(app.count().slabs, 0, "nothing built yet");
  });
  await check("the answer leads to a location question", async () => {
    r = await app.say("3 bedrooms, 12 x 9 m");
    assertEqual(r.tone, "question", r.text);
    assertIncludes(r.text, "where", "asks where");
    assertTrue(r.choices.some((choice) => /pick/i.test(choice.say)), "offers a pick");
  });
  await check("a spot past the site boundary is offered a shifted spot, not built over the edge", async () => {
    r = app.session.pickedLocation({ x: 12, z: 0 });
    assertEqual(r.tone, "question", r.text);
    assertIncludes(r.text, "site boundary", "boundary");
    assertIncludes(r.text, "(9, 0)", "shifted to fit a 12 m house on a 30 m site");
  });
  await check("the site centre conflicts with the startup wall - the architect asks what to do", async () => {
    r = await app.say("Use the site centre");
    assertEqual(r.tone, "question", r.text);
    assertIncludes(r.text, "overlap", "conflict");
    assertTrue(r.focusIds?.includes(startupWall), "focuses the wall in the way");
    assertTrue(r.choices.some((choice) => /nearest/i.test(choice.label)), "offers the nearest free spot");
  });
  await check("“clear them” removes the wall (one undo step) and presents the plan", async () => {
    r = await app.say("Clear them and build here");
    assertEqual(app.count().walls, 0, "wall cleared");
    assertEqual(r.tone, "question", r.text);
    assertIncludes(r.text, "Here's the plan", "plan");
    assertIncludes(r.text, "Bedroom 3", "three bedrooms");
    assertEqual(app.session.getState().stages?.[0].status, "next", "foundation next");
  });
  await check("“yes” lays only the foundation", async () => {
    r = await app.say("yes");
    assertEqual(r.tone, "success", r.text);
    const counts = app.count();
    assertEqual(counts.slabs, 1, "slab");
    assertEqual(counts.walls, 0, "no walls yet");
    const slab = app.context.slabStore.getAll()[0];
    assertEqual(slab.dimensions.length, 12, "slab length");
    assertEqual(slab.dimensions.width, 9, "slab width");
    assertEqual(app.stageStatus().foundation, "done", "foundation done");
    assertEqual(app.stageStatus().structure, "next", "walls next");
  });
  await check("asking for the roof early is a clarification, not a floating roof", async () => {
    r = await app.say("Put the roof on");
    assertEqual(r.tone, "question", r.text);
    assertEqual(app.count().roofs, 0, "no roof");
    r = await app.say("no");
    assertEqual(app.count().roofs, 0, "still no roof");
  });
  await check("“next” raises the walls and columns", async () => {
    r = await app.say("next");
    assertEqual(r.tone, "success", r.text);
    const counts = app.count();
    assertEqual(counts.pillars, 4, "pillars");
    assertTrue(counts.walls >= 7, `exterior + interior walls (${counts.walls})`);
  });
  await check("“add a window” with no wall selected asks which is meant", async () => {
    app.context.selectionStore.clear();
    r = await app.say("Add a window");
    assertEqual(r.tone, "question", r.text);
    assertEqual(app.count().windows, 0, "nothing added");
  });
  await check("“build everything” finishes every remaining stage - each its own undo step", async () => {
    r = await app.say("Build everything");
    assertEqual(r.tone, "success", r.text);
    const counts = app.count();
    assertEqual(counts.rooms, 6, "six rooms");
    assertEqual(counts.roofs, 1, "roof");
    assertTrue(counts.doors >= 5, `doors (${counts.doors})`);
    assertTrue(counts.windows >= 3, `windows (${counts.windows})`);
    assertTrue(counts.assets >= 12, `furniture (${counts.assets})`);
    for (const door of app.context.doorStore.getAll()) assertTrue(door.hostId, "every door is hosted in a wall");
    for (const window of app.context.windowStore.getAll()) assertTrue(window.hostId, "every window is hosted in a wall");
    assertTrue(Object.values(app.stageStatus()).every((status) => status === "done"), "every stage done");
  });
  await check("the house stands where it was planned, inside the site", () => {
    const slab = app.context.slabStore.getAll()[0];
    assertEqual(slab.position.x, 0, "x");
    assertEqual(slab.position.z, 0, "z");
    for (const asset of app.context.assetStore.getAll()) {
      assertTrue(Math.abs(asset.position.x) < 6 && Math.abs(asset.position.z) < 4.5, `${asset.id} inside the house`);
    }
  });
  await check("one undo removes exactly the last stage, and the session notices", async () => {
    r = await app.say("undo");
    assertEqual(app.count().assets, 0, "interiors undone");
    assertEqual(app.count().roofs, 1, "roof kept");
    assertEqual(app.stageStatus().interiors, "next", "interiors next again");
  });
  await check("“furnish the bedroom” with three bedrooms asks which", async () => {
    r = await app.say("Furnish the bedroom");
    assertEqual(r.tone, "question", r.text);
    assertEqual(r.choices.length, 4, "three bedrooms + all");
    assertEqual(app.count().assets, 0, "nothing placed yet");
  });
  await check("answering “Bedroom 2” furnishes only that room", async () => {
    r = await app.say("Furnish Bedroom 2");
    assertEqual(r.tone, "success", r.text);
    const placed = app.count().assets;
    assertTrue(placed >= 3, `bedroom pieces (${placed})`);
    assertTrue(app.context.assetStore.getAll().some((asset) => asset.assetId === "bed"), "a bed");
    assertEqual(app.stageStatus().interiors, "next", "other rooms still to furnish");
  });
  await check("“furnish the house” then finishes the rest", async () => {
    r = await app.say("Furnish the house");
    assertEqual(app.stageStatus().interiors, "done", "interiors done");
  });
  await check("a selected wall takes a single new window, hosted at its first free spot", async () => {
    const windowsBefore = app.count().windows;
    const exterior = app.context.wallStore.getAll().find((wall) => wall.dimensions.length > 10)!;
    app.context.selectionStore.select(exterior.id);
    r = await app.say("Add a window to the selected wall");
    assertEqual(r.tone, "success", r.text);
    assertEqual(app.count().windows, windowsBefore + 1, "one more window");
    assertTrue(app.context.windowStore.getAll().some((window) => window.hostId === exterior.id), "hosted in the selected wall");
  });
  await check("a selection edit falls through to the existing pipeline and runs offline", async () => {
    const wall = app.context.wallStore.getAll().find((candidate) => candidate.dimensions.length > 10)!;
    app.context.selectionStore.select(wall.id);
    r = await app.say("make the selected wall 11 meters long");
    assertEqual(r.tone, "success", r.text);
    assertEqual(app.context.wallStore.get(wall.id)!.dimensions.length, 11, "resized");
  });
  await check("a second house is refused while the first is under construction, until “new design”", async () => {
    r = await app.say("Build a 2 bedroom house");
    assertEqual(r.tone, "info", r.text);
    r = await app.say("new design");
    assertEqual(app.session.getState().stages, null, "fresh design");
    assertEqual(app.count().roofs, 1, "the built house stays");
  });

  console.log("ArchitectSession - without a site");
  const bare = wire();
  await check("a fully specified request with coordinates goes straight to the plan", async () => {
    r = await bare.say("Build a 10m x 8m house with 2 bedrooms at 20, 5");
    assertEqual(r.tone, "question", r.text);
    assertIncludes(r.text, "(20, 5)", "planned where asked");
  });
  await check("“build everything” builds the full house in one go", async () => {
    r = await bare.say("Build everything");
    const counts = bare.count();
    assertEqual(counts.slabs, 1, "slab");
    assertEqual(counts.roofs, 1, "roof");
    assertTrue(counts.assets > 0, "furnished");
    assertEqual(bare.context.slabStore.getAll()[0].position.x, 20, "at x=20");
  });
  await check("undo walks the build back stage by stage", async () => {
    for (let i = 0; i < 6; i += 1) bare.context.history.undo();
    const counts = bare.count();
    assertEqual(counts.slabs + counts.walls + counts.roofs + counts.assets + counts.rooms, 0, "everything undone");
    assertEqual(bare.stageStatus().foundation, "next", "back to the start");
    bare.context.history.redo();
    assertEqual(bare.count().slabs, 1, "redo restores the foundation");
    assertEqual(bare.stageStatus().foundation, "done", "and the session sees it");
  });
  await check("a two-storey request is declined clearly", async () => {
    r = await wire().say("Build a two storey house");
    assertEqual(r.tone, "error", r.text);
    assertIncludes(r.text, "floors", "explains why");
  });
  await check("a house larger than the site is caught before anything is built", async () => {
    const small = wire();
    await small.say("Set up a 10 x 8 m site");
    r = await small.say("Build a 12m x 9m house at 0, 0");
    assertEqual(r.tone, "question", r.text);
    assertIncludes(r.text, "won't fit", "too big");
    assertEqual(small.count().slabs, 0, "nothing built");
  });

  // --- Room-aware conversational editing (roomModel.ts / roomEdits.ts) ---

  /** A finished 12 × 9 m, 3-bedroom house at the origin - every stage built, through the real conversation. */
  async function builtHouse(): Promise<Wired> {
    const wired = wire();
    await wired.say("Build a 12m x 9m house with 3 bedrooms at 0, 0");
    const done = await wired.say("Build everything");
    assertEqual(done.tone, "success", done.text);
    wired.context.history.clearHistory();
    return wired;
  }
  const snap = (wired: Wired) => buildAIProjectSnapshot(wired.context);
  const roomNamed = (wired: Wired, name: string) => listRooms(snap(wired)).find((room) => room.name === name)!;
  /** Every object id a reply names must really exist (or have existed, for a removal) - none invented. */
  const assertRealIds = (reply: ArchitectReply, known: ReadonlySet<string>) => {
    for (const match of reply.text.matchAll(/\b((?:wall|door|window|roof|slab|pillar)-\d+)\b/g)) {
      assertTrue(known.has(match[1]), `reply names ${match[1]}, which isn't in the model`);
    }
  };
  const idsOf = (wired: Wired) => new Set(snap(wired).objects.map((object) => object.id));

  console.log("roomModel - resolving rooms, walls and openings from the real scene");
  const house = await builtHouse();
  await check("every room element is found, with its real size", () => {
    const rooms = listRooms(snap(house));
    assertEqual(rooms.map((room) => room.name).join(","), "Bathroom,Bedroom 1,Bedroom 2,Bedroom 3,Kitchen,Living Room", "rooms");
    const kitchen = roomNamed(house, "Kitchen");
    assertTrue(Math.abs(kitchen.sizeX - 3.866667) < 0.01 && Math.abs(kitchen.sizeZ - 4.2) < 0.01, `kitchen size ${kitchen.sizeX} × ${kitchen.sizeZ}`);
  });
  await check("a room's walls are the real walls bordering it - exterior, or shared with the named neighbour", () => {
    const model = describeRoom(snap(house), roomNamed(house, "Kitchen"));
    assertEqual(model.walls.length, 4, "four walls");
    const bySide = Object.fromEntries(model.walls.map((entry) => [entry.side, entry]));
    assertTrue(bySide.front.exterior, "front wall is exterior");
    assertEqual(bySide.left.neighbours.join(), "Living Room", "left wall shared with the Living Room");
    assertEqual(bySide.right.neighbours.join(), "Bedroom 1", "right wall shared with Bedroom 1");
    assertEqual(bySide.back.neighbours.join(), "Bedroom 3", "back wall (the spine) shared with Bedroom 3 along the kitchen's stretch");
    for (const entry of model.walls) assertTrue(house.context.wallStore.get(entry.wall.id), `${entry.wall.id} is a real wall`);
  });
  await check("a room's doors and windows are those hosted in its walls, inside its stretch", () => {
    const snapshot = snap(house);
    const kitchen = describeRoom(snapshot, roomNamed(house, "Kitchen"));
    const living = describeRoom(snapshot, roomNamed(house, "Living Room"));
    for (const opening of [...kitchen.openings, ...living.openings]) {
      assertEqual(opening.object.hostId, opening.wall.wall.id, `${opening.object.id} is hosted in the wall it's listed under`);
    }
    const shared = kitchen.openings.filter((opening) => living.openings.some((other) => other.object.id === opening.object.id));
    assertEqual(shared.length, 1, "exactly one door connects the kitchen and the living room");
    assertEqual(shared[0].object.type, "door", "and it's a door");
  });
  await check("room names resolve exactly, by number word, by type, and ambiguously", () => {
    const rooms = listRooms(snap(house));
    const names = (match: ReturnType<typeof resolveRooms>) => (match.kind === "found" ? match.rooms.map((room) => room.name).join(",") : match.kind);
    assertEqual(names(resolveRooms(rooms, "refurnish bedroom 2")), "Bedroom 2", "exact");
    assertEqual(names(resolveRooms(rooms, "show me bedroom two")), "Bedroom 2", "number word");
    assertEqual(names(resolveRooms(rooms, "the second bedroom")), "Bedroom 2", "ordinal");
    assertEqual(names(resolveRooms(rooms, "the lounge")), "Living Room", "type synonym");
    assertEqual(names(resolveRooms(rooms, "the kitchen")), "Kitchen", "single room of a type");
    assertEqual(resolveRooms(rooms, "the bedroom").kind, "ambiguous", "three bedrooms");
    assertEqual(names(resolveRooms(rooms, "all the bedrooms")), "Bedroom 1,Bedroom 2,Bedroom 3", "plural means all of them");
    assertEqual(resolveRooms(rooms, "the garage").kind, "unknown", "a room the house doesn't have");
    assertEqual(resolveRooms(rooms, "make it taller").kind, "none", "no room named");
  });

  console.log("roomEdits - the required examples");
  await check("“Add a window to the kitchen.” hosts a window in the kitchen's one exterior wall, within the kitchen", async () => {
    const before = house.context.windowStore.getAll().length;
    const known = idsOf(house);
    r = await house.say("Add a window to the kitchen.");
    assertEqual(r.tone, "success", r.text);
    assertEqual(house.context.windowStore.getAll().length, before + 1, "one more window");
    const added = house.context.windowStore.get(r.focusIds![0])!;
    const kitchen = describeRoom(snap(house), roomNamed(house, "Kitchen"));
    const front = kitchen.walls.find((entry) => entry.side === "front")!;
    assertEqual(added.hostId, front.wall.id, "hosted in the kitchen's exterior (front) wall");
    assertTrue(kitchen.openings.some((opening) => opening.object.id === added.id), "inside the kitchen's stretch of that wall");
    assertRealIds(r, new Set([...known, added.id]));
    house.context.history.undo();
    assertEqual(house.context.windowStore.getAll().length, before, "one undo removes it");
    house.context.history.redo();
    assertEqual(house.context.windowStore.getAll().length, before + 1, "redo restores it");
  });
  await check("“Move the front door one metre left.” slides the entrance door 1 m along its wall", async () => {
    const entrance = house.context.doorStore.getAll().find((door) => Math.abs(door.position.z - 4.4) < 0.01)!;
    const { x, z } = entrance.position;
    r = await house.say("Move the front door one metre left.");
    assertEqual(r.tone, "success", r.text);
    const moved = house.context.doorStore.get(entrance.id)!;
    assertTrue(Math.abs(moved.position.x - (x - 1)) < 1e-6 && Math.abs(moved.position.z - z) < 1e-6, `moved to ${moved.position.x}, ${moved.position.z}`);
    assertEqual(moved.hostId, entrance.hostId, "still in the same wall");
    assertIncludes(r.text, entrance.id, "names the real door");
    house.context.history.undo();
    assertEqual(house.context.doorStore.get(entrance.id)!.position.x, x, "undo puts it back");
    house.context.history.redo();
  });
  await check("“Refurnish bedroom 2.” replaces that room's furniture in one undo step, other rooms untouched", async () => {
    const roomBefore = describeRoom(snap(house), roomNamed(house, "Bedroom 2")).furniture.map((object) => object.id).sort();
    const othersBefore = house.context.assetStore.getAll().filter((asset) => !roomBefore.includes(asset.id)).map((asset) => asset.id).sort();
    r = await house.say("Refurnish bedroom 2.");
    assertEqual(r.tone, "success", r.text);
    const roomAfter = describeRoom(snap(house), roomNamed(house, "Bedroom 2")).furniture;
    assertTrue(roomAfter.length > 0, "the room is furnished");
    assertTrue(roomAfter.every((object) => !roomBefore.includes(object.id)), "every piece is new");
    assertTrue(roomAfter.some((object) => object.assetId === "bed"), "it still has a bed");
    const othersAfter = house.context.assetStore.getAll().filter((asset) => !roomAfter.some((object) => object.id === asset.id)).map((asset) => asset.id).sort();
    assertEqual(othersAfter.join(), othersBefore.join(), "no other room's furniture changed");
    house.context.history.undo();
    assertEqual(describeRoom(snap(house), roomNamed(house, "Bedroom 2")).furniture.map((object) => object.id).sort().join(), roomBefore.join(), "one undo restores the original pieces");
    house.context.history.redo();
  });
  await check("“Make the bedroom wall 4 metres long.” asks which bedroom, then which wall, then changes only that wall", async () => {
    const lengths = () => house.context.wallStore.getAll().map((wall) => `${wall.id}:${wall.dimensions.length}`).join();
    const before = lengths();
    r = await house.say("Make the bedroom wall 4 metres long.");
    assertEqual(r.tone, "question", r.text);
    assertEqual(r.choices.length, 3, "one choice per bedroom");
    r = await house.say("Bedroom 2");
    assertEqual(r.tone, "question", `typed answer picks Bedroom 2, then asks which wall: ${r.text}`);
    assertEqual(lengths(), before, "nothing changed while asking");
    const right = describeRoom(snap(house), roomNamed(house, "Bedroom 2")).walls.find((entry) => entry.side === "right")!;
    r = await house.say("the right one");
    assertEqual(r.tone, "success", r.text);
    assertEqual(house.context.wallStore.get(right.wall.id)!.dimensions.length, 4, "that wall is 4 m");
    const beforeLengths = new Map(before.split(",").map((entry) => [entry.split(":")[0], entry.split(":")[1]]));
    const changed = house.context.wallStore.getAll().filter((wall) => beforeLengths.get(wall.id) !== String(wall.dimensions.length));
    assertEqual(changed.map((wall) => wall.id).join(), right.wall.id, "only that wall changed");
    house.context.history.undo();
    assertEqual(lengths(), before, "one undo restores it");
  });
  await check("“Show me the living room.” frames the real room and lifts the roof, changing nothing in the model", async () => {
    const roof = house.context.elementStore.getAll().find((element) => element.kind === "roof")!;
    house.context.history.clearHistory();
    r = await house.say("Show me the living room.");
    assertEqual(r.tone, "info", r.text);
    assertTrue(r.focusIds?.includes(roomNamed(house, "Living Room").id), "frames the living room element");
    assertEqual(r.hideIds?.join(), roof.id, "hides the roof over it");
    assertTrue(!house.context.history.canUndo(), "no model change, so nothing to undo");
    r = await house.say("Show the roof");
    assertEqual(r.showIds?.join(), roof.id, "and shows it again");
  });

  console.log("roomEdits - ambiguous targets");
  await check("a window for a corner room with two outside walls: asks which, then hosts it in the chosen one", async () => {
    const before = house.context.windowStore.getAll().length;
    r = await house.say("Add a window to the bathroom");
    assertEqual(r.tone, "question", r.text);
    assertEqual(r.choices.length, 2, "back and right walls");
    assertEqual(house.context.windowStore.getAll().length, before, "nothing added yet");
    const right = describeRoom(snap(house), roomNamed(house, "Bathroom")).walls.find((entry) => entry.side === "right")!;
    r = await house.say(r.choices.find((choice) => choice.label.startsWith("right"))!.say);
    assertEqual(r.tone, "success", r.text);
    assertEqual(house.context.windowStore.get(r.focusIds![0])!.hostId, right.wall.id, "in the right wall");
    house.context.history.undo();
  });
  await check("a room with several doors: “move the door in bedroom 3” asks which, offering only that room's real doors", async () => {
    const doors = describeRoom(snap(house), roomNamed(house, "Bedroom 3")).openings.filter((opening) => opening.object.type === "door").map((opening) => opening.object.id);
    assertTrue(doors.length > 1, "bedroom 3 has several doors");
    const positions = house.context.doorStore.getAll().map((door) => `${door.position.x},${door.position.z}`).join();
    r = await house.say("Move the door in bedroom 3 half a metre left");
    assertEqual(r.tone, "question", r.text);
    assertEqual(r.choices.length, doors.length, "one choice per door");
    for (const id of doors) assertTrue(r.choices.some((choice) => choice.say.includes(id)), `${id} offered`);
    assertEqual(house.context.doorStore.getAll().map((door) => `${door.position.x},${door.position.z}`).join(), positions, "no door moved yet");
  });
  await check("a door in a front-to-back wall asked to move left: a clarification, not a move off the wall", async () => {
    const side = describeRoom(snap(house), roomNamed(house, "Kitchen")).openings.find((opening) => opening.object.type === "door" && (opening.wall.side === "left" || opening.wall.side === "right"))!;
    const { x, z } = side.object.position;
    r = await house.say(`Move ${side.object.id} 1 m left`);
    assertEqual(r.tone, "question", r.text);
    assertIncludes(r.text, "front–back", "explains why");
    const after = house.context.doorStore.get(side.object.id)!.position;
    assertTrue(after.x === x && after.z === z, "not moved");
  });
  await check("an unknown room is named back with the rooms that do exist, and nothing changes", async () => {
    const count = house.context.windowStore.getAll().length;
    r = await house.say("Add a window to the garage");
    assertIncludes(r.text, "no garage", "says so");
    assertIncludes(r.text, "Kitchen", "lists the real rooms");
    assertEqual(house.context.windowStore.getAll().length, count, "nothing added");
  });

  console.log("roomEdits - invalid edits change nothing");
  await check("moving the front door further than its wall allows is refused, door untouched", async () => {
    const entrance = describeRoom(snap(house), roomNamed(house, "Kitchen")).openings.find((opening) => opening.wall.exterior && opening.object.type === "door")!;
    const before = { ...house.context.doorStore.get(entrance.object.id)!.position };
    house.context.history.clearHistory();
    r = await house.say("Move the front door 20 metres left");
    assertEqual(r.tone, "error", r.text);
    assertIncludes(r.text, "Nothing was changed", "says nothing changed");
    const after = house.context.doorStore.get(entrance.object.id)!.position;
    assertTrue(after.x === before.x && after.z === before.z, "door not moved");
    assertTrue(!house.context.history.canUndo(), "no undo entry");
  });
  await check("a zero wall length is refused before anything runs", async () => {
    r = await house.say("Make the back wall of the kitchen 0 metres long");
    assertEqual(r.tone, "error", r.text);
    assertTrue(!house.context.history.canUndo(), "no undo entry");
  });
  await check("windows until a wall is full: the last request reports no free space and adds nothing", async () => {
    let last: ArchitectReply | null = null;
    for (let i = 0; i < 6; i += 1) {
      last = await house.say("Add a window to the back wall of the living room");
      if (last.tone !== "success") break;
    }
    assertTrue(last && last.tone === "error", `eventually refused: ${last?.text}`);
    assertIncludes(last!.text, "no free space", "says why");
    const count = house.context.windowStore.getAll().length;
    await house.say("Add a window to the back wall of the living room");
    assertEqual(house.context.windowStore.getAll().length, count, "still nothing added");
  });

  console.log("roomEdits - no-op cases");
  await check("a wall already that long: says so, changes nothing, leaves no undo entry", async () => {
    const back = describeRoom(snap(house), roomNamed(house, "Bedroom 2")).walls.find((entry) => entry.side === "back")!;
    house.context.history.clearHistory();
    r = await house.say(`Make ${back.wall.id} ${back.wall.dimensions.length} metres long`);
    assertEqual(r.tone, "info", r.text);
    assertIncludes(r.text, "already", "already that long");
    assertTrue(!house.context.history.canUndo(), "no undo entry");
  });
  await check("moving a door 0 m: nothing to do", async () => {
    house.context.history.clearHistory();
    r = await house.say("Move the front door 0 m left");
    assertIncludes(r.text, "Nothing was changed", r.text);
    assertTrue(!house.context.history.canUndo(), "no undo entry");
  });
  await check("furnishing an already furnished room: says so, adds nothing", async () => {
    const count = house.context.assetStore.getAll().length;
    house.context.history.clearHistory();
    r = await house.say("Furnish the kitchen");
    assertIncludes(r.text, "already furnished", r.text);
    assertEqual(house.context.assetStore.getAll().length, count, "nothing added");
    assertTrue(!house.context.history.canUndo(), "no undo entry");
  });

  console.log("roomEdits - houses the architect didn't build, and existing behaviour");
  await check("room edits work on a house built by the AI Prompt's one-shot planner", async () => {
    const other = wire();
    const service = new AIService({ provider: new MockAIProvider(), commandExecutor: other.context.commandExecutor, history: other.context.history, snapshotSource: other.context });
    const built = await service.submit("Build a 10m x 8m house with 2 bedrooms");
    assertTrue(built.success, "one-shot house built");
    const before = other.context.windowStore.getAll().length;
    // That plan's kitchen is 3.2 m wide with the entrance door centred in
    // its front wall: a standard 1.2 m window can't fit beside it, so a
    // narrower one goes in - and the reply says so.
    r = await other.say("Add a window to the kitchen");
    assertEqual(r.tone, "success", r.text);
    assertEqual(other.context.windowStore.getAll().length, before + 1, "window added");
    const added = other.context.windowStore.get(r.focusIds![0])!;
    assertTrue(added.dimensions.width < 1.2, `a narrower window (${added.dimensions.width} m)`);
    assertIncludes(r.text, "narrower", "says it's narrower");
    r = await other.say("Furnish the living room");
    assertEqual(r.tone, "success", r.text);
    assertTrue(other.context.assetStore.getAll().some((asset) => asset.assetId === "sofa"), "a sofa in the living room");
  });
  await check("“make the selected wall … long” still goes to the existing deterministic edit", () => {
    assertEqual(parseUtterance("Make the selected wall 5 meters long").kind, "unknown", "left to the AI pipeline");
    assertEqual(parseUtterance("Add a window to the selected wall").kind, "single-opening", "selection path unchanged");
  });
  await check("room-edit phrasings parse with their numbers and directions", () => {
    const move = parseUtterance("Move the front door one metre left");
    assertTrue(move.kind === "move-opening" && move.distance === 1 && move.direction === "left" && move.opening === "door", JSON.stringify(move));
    const half = parseUtterance("shift the kitchen window 50 cm to the right");
    assertTrue(half.kind === "move-opening" && half.distance === 0.5 && half.direction === "right" && half.opening === "window", JSON.stringify(half));
    const wall = parseUtterance("Make the bedroom wall 4 metres long");
    assertTrue(wall.kind === "wall-length" && wall.length === 4, JSON.stringify(wall));
    assertEqual(parseUtterance("Refurnish bedroom 2").kind, "refurnish", "refurnish");
    assertEqual(parseUtterance("Show me the living room").kind, "show", "show");
    assertEqual(parseUtterance("show the roof").kind, "show-roof", "show roof");
    assertEqual(parseUtterance("Put the roof on").kind, "stage", "the roof stage is unaffected");
  });

  // --- Architect → AI backend: the real AIService/pipeline/BackendAIProvider,
  // with only the HTTP transport replaced by ai/e2e/mockBackend.ts, which
  // enforces the real backend's path and body rules. A contract test - not
  // a test of the hosted backend or of any real AI provider.
  console.log("Architect → AI backend (mocked transport, real request contract)");
  function wireBackend(handler: MockBackendHandler): Wired & { backend: ReturnType<typeof createMockBackend> } {
    const context = createProjectContext();
    const backend = createMockBackend(handler);
    const service = new AIService({ provider: new BackendAIProvider({ baseUrl: "http://localhost:8787", fetch: backend.fetch }), commandExecutor: context.commandExecutor, history: context.history, snapshotSource: context });
    const session = new ArchitectSession({
      commandExecutor: context.commandExecutor,
      history: context.history,
      snapshot: () => buildAIProjectSnapshot(context),
      undo: () => context.history.undo(),
      fallback: (instruction) => service.submit(instruction)
    });
    const wired = wire();
    return { ...wired, context, session, say: (text) => session.handle(text), backend, count: () => ({ walls: context.wallStore.getAll().length }) as Record<string, number> };
  }
  await check("a typed command the architect doesn't know goes to the backend, and its commands really change the scene", async () => {
    const app = wireBackend(() => ({ kind: "ok", commands: [{ type: "wall.add", wall: { length: 5, position: { x: 30, z: 30 } } }], notes: "A 5 m garden wall." }));
    r = await app.say("Add a garden wall 5m long by the gate");
    assertEqual(app.backend.requests.length, 1, "one request reached the backend");
    assertTrue(app.backend.requests[0].url.endsWith("/api/ai/interpret"), "on the real endpoint");
    assertEqual(app.backend.requests[0].instruction, "Add a garden wall 5m long by the gate", "the user's words, unchanged");
    assertEqual(r.tone, "success", r.text);
    assertIncludes(r.text, "1 wall", "reports what was created");
    const wall = app.context.wallStore.getAll().find((candidate) => candidate.position.x === 30);
    assertTrue(wall && wall.dimensions.length === 5, "the wall really exists");
    assertTrue(r.focusIds?.includes(wall!.id), "and is framed");
    app.context.history.undo();
    assertEqual(app.context.wallStore.getAll().length, 0, "one undo removes the AI's change");
  });
  await check("the backend refusing a signed-out request: a sign-in message, and the scene is unchanged", async () => {
    const app = wireBackend(() => ({ kind: "status", status: 401, error: "Sign in to use the AI assistant." }));
    r = await app.say("Add a pergola over the patio");
    assertEqual(r.tone, "error", r.text);
    assertIncludes(r.text, "Sign in to use EAVARA AI", "says to sign in");
    assertEqual(buildAIProjectSnapshot(app.context).objects.length, 0, "nothing changed");
  });
  await check("the backend unreachable: an 'unable to connect' message that says what still works offline", async () => {
    const app = wireBackend(() => ({ kind: "networkError", message: "Failed to fetch" }));
    r = await app.say("Add a pergola over the patio");
    assertEqual(r.tone, "error", r.text);
    assertIncludes(r.text, "couldn't reach the AI server", "says it couldn't connect");
    assertIncludes(r.text, "work without the AI server", "and what still works");
    assertTrue(!/demo mode/i.test(r.text), "never offers the AI Prompt tab's Demo Mode button, which this panel doesn't have");
    const retry = r.choices.find((choice) => choice.label === "Try again");
    assertEqual(retry?.say, "Add a pergola over the patio", "Try again resends the same words");
    await app.say(retry!.say);
    assertEqual(app.backend.requests.length, 2, "Try again really sends the request again");
    assertEqual(app.backend.requests[1].instruction, "Add a pergola over the patio", "with the same words");
  });
  await check("the backend's sign-in service failing (the staging backend's real 502): named as such", async () => {
    const app = wireBackend(() => ({ kind: "status", status: 502, error: "The sign-in service sent a malformed user." }));
    r = await app.say("Add a pergola over the patio");
    assertIncludes(r.text, "sign-in service", r.text);
  });
  await check("the backend answering with no usable commands: its explanation is shown, nothing changes", async () => {
    const app = wireBackend(() => ({ kind: "ok", commands: [], notes: "I can't build pergolas yet - there's no pergola element." }));
    r = await app.say("Add a pergola over the patio");
    assertEqual(r.tone, "error", r.text);
    assertIncludes(r.text, "pergola element", "the backend's own reason");
    assertEqual(buildAIProjectSnapshot(app.context).objects.length, 0, "nothing changed");
  });
  await check("deterministic commands never reach the backend", async () => {
    const app = wireBackend(() => ({ kind: "networkError", message: "Failed to fetch" }));
    r = await app.say("Build a 10m x 8m house with 2 bedrooms at 0, 0");
    r = await app.say("Build everything");
    assertEqual(r.tone, "success", r.text);
    assertEqual(app.backend.requests.length, 0, "no backend request");
  });

  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) {
    throw new Error(`${failed} architect check(s) failed`);
  }
}

await main();
