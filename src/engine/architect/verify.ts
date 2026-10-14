/**
 * Verification for the conversational architect (engine/architect/):
 * the utterance parser, the interiors planner, and a whole conversation -
 * site, location, clarification, staged build, undo, edits - driven
 * through the REAL ProjectContext (real stores, CommandExecutor and
 * HistoryManager), exactly as main.ts wires it. Like ai/e2e/verify.ts,
 * this needs `--experimental-transform-types` (the real *HistoryController
 * classes use parameter properties) - see the root package.json.
 */
import { createProjectContext, loadProject, serializeProject } from "../project/ProjectContext.ts";
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
import { buildRecordBook } from "../records/recordBook.ts";
import { roomPartsOf } from "./roomBuilder.ts";
import { resolveJoints } from "../plumbing/fittings.ts";
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
    elementParams: (id) => context.elementStore.get(id)?.params,
    undo: () => context.history.undo(),
    fallback: (instruction, options) => service.submit(instruction, options)
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
    ["Add a wall 5m long", "build-wall"],
    ["Build a 4 m long, 3 m high, 200 mm thick concrete block wall at 2, 3 running north-south", "build-wall"],
    ["I need a new wall", "build-wall"],
    ["make the back wall of the kitchen 4 metres long", "wall-length"],
    ["Add a window to the kitchen wall", "single-opening"],
    ["Raise the walls", "stage"],
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
    assertEqual(r.tone, "question", r.text);
    assertIncludes(r.text, "what should the house walls be built of", "asks for the wall material instead of assuming one");
    assertTrue(["Brick", "Concrete block", "Stone masonry"].every((label) => r.choices.some((choice) => choice.label === label)), "offers the library's masonry materials");
    assertEqual(app.count().walls, 0, "nothing raised until it's chosen");
    r = await app.say("brick");
    assertEqual(r.tone, "success", r.text);
    const counts = app.count();
    assertEqual(counts.pillars, 4, "pillars");
    assertTrue(counts.walls >= 7, `exterior + interior walls (${counts.walls})`);
    assertTrue(app.context.wallStore.getAll().every((wall) => wall.material === "brick" && wall.color === "#a0522d"), "every wall in brick, with the library colour");
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
    assertIncludes(r.text, "Undone — removed", "says what was removed");
    assertIncludes(r.text, "House:", "and, mid-house, the house's progress");
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
    assertIncludes(r.text, "built of", "asks for the material first");
    r = await bare.say("concrete block");
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
    // The material named up front is used - nothing to ask.
    await wired.say("Build a 12m x 9m brick house with 3 bedrooms at 0, 0");
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
      fallback: (instruction, options) => service.submit(instruction, options)
    });
    const wired = wire();
    return { ...wired, context, session, say: (text) => session.handle(text), backend, count: () => ({ walls: context.wallStore.getAll().length }) as Record<string, number> };
  }
  await check("a typed command the architect doesn't know goes to the backend, and its commands really change the scene", async () => {
    const app = wireBackend(() => ({ kind: "ok", commands: [{ type: "wall.add", wall: { length: 5, position: { x: 30, z: 30 } } }], notes: "A 5 m garden wall." }));
    r = await app.say("Add a garden pergola by the gate");
    assertEqual(app.backend.requests.length, 1, "one request reached the backend");
    assertTrue(app.backend.requests[0].url.endsWith("/api/ai/interpret"), "on the real endpoint");
    assertEqual(app.backend.requests[0].instruction, "Add a garden pergola by the gate", "the user's words, unchanged");
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
    r = await app.say("stone masonry");
    assertEqual(r.tone, "success", r.text);
    assertEqual(app.backend.requests.length, 0, "no backend request");
  });

  // --- Whole houses only the AI recognizes (the live 3-bedroom-house timeout) ---

  const AI_ONLY_HOME = "I need somewhere for a family of five to live";
  const AI_PLAN = { bedrooms: 3, footprint: { length: 10, width: 8 } };
  const roofs = (context: ProjectContext) => context.elementStore.getAll().filter((element) => element.kind === "roof").length;

  await check("a house only the AI recognizes comes back as a plan and goes through the staged build - questions first, one undo step per stage, one AI request in all", async () => {
    assertEqual(parseUtterance(AI_ONLY_HOME).kind, "unknown", "the panel doesn't recognize this wording itself");
    const app = wireBackend(() => ({ kind: "ok", commands: [], house: AI_PLAN }));
    r = await app.say(AI_ONLY_HOME);
    assertEqual(app.backend.requests.length, 1, "the AI was asked once");
    assertEqual(r.tone, "question", r.text);
    assertIncludes(r.text, "Where should the house go", "a clarification first");
    assertEqual(app.context.slabStore.getAll().length + app.context.wallStore.getAll().length, 0, "nothing built yet");

    r = await app.say("At the origin");
    assertEqual(r.tone, "question", r.text);
    assertIncludes(r.text, "Here's the plan", "the plan, for confirmation");
    assertIncludes(r.text, "Bedroom 3", "with the AI's three bedrooms");

    r = await app.say("yes");
    assertEqual(r.tone, "success", r.text);
    assertEqual(app.context.slabStore.getAll().length, 1, "the foundation only");
    assertEqual(app.context.wallStore.getAll().length, 0, "no walls yet");
    assertEqual(app.session.getState().stages?.find((stage) => stage.id === "foundation")?.status, "done", "progress: foundation done");

    r = await app.say("Build everything");
    assertIncludes(r.text, "built of", "asks for the wall material");
    r = await app.say("brick");
    assertEqual(r.tone, "success", r.text);
    const walls = app.context.wallStore.getAll().length;
    assertTrue(walls > 4 && roofs(app.context) === 1 && app.context.assetStore.getAll().length > 0, "every stage built");
    app.context.history.undo();
    assertEqual(app.context.assetStore.getAll().length, 0, "one undo removes only the last stage (the furniture)");
    assertEqual(roofs(app.context), 1, "the roof stays");
    app.context.history.undo();
    assertEqual(roofs(app.context), 0, "the next undo takes off the roof");
    assertEqual(app.context.wallStore.getAll().length, walls, "and the walls stay");
    assertEqual(app.backend.requests.length, 1, "building the stages never called the AI");
  });

  await check("an AI request that times out in the panel changes nothing and says so; “Try again” resends the same words and carries on", async () => {
    let attempt = 0;
    const app = wireBackend(() => {
      attempt += 1;
      // What the real backend relays when Claude's 25 s deadline passes.
      return attempt === 1 ? { kind: "status", status: 502, error: "Anthropic request timed out after 25000ms." } : { kind: "ok", commands: [], house: AI_PLAN };
    });
    addStartupWall(app.context);
    const before = JSON.stringify(buildAIProjectSnapshot(app.context).objects);

    r = await app.say(AI_ONLY_HOME);
    assertEqual(r.tone, "error", r.text);
    assertIncludes(r.text, "taking too long", "says it timed out");
    assertIncludes(r.text, "Your design was not changed", "and that nothing changed");
    assertEqual(JSON.stringify(buildAIProjectSnapshot(app.context).objects), before, "the scene is exactly as it was");
    const retry = r.choices.find((choice) => choice.label === "Try again");
    assertEqual(retry?.say, AI_ONLY_HOME, "Try again resends the same words");

    r = await app.say(retry!.say);
    assertEqual(r.tone, "question", r.text);
    assertIncludes(r.text, "Where should the house go", "the retry picks up the design conversation");
    assertEqual(app.backend.requests.length, 2, "two requests in all");
    assertEqual(JSON.stringify(buildAIProjectSnapshot(app.context).objects), before, "still nothing built or duplicated - the house waits for its questions");
  });

  await check("an unsupported or invalid AI house plan in the panel is reported with its reason - nothing is built and no design starts", async () => {
    const cases: [unknown, string][] = [
      [{ ...AI_PLAN, floors: 2 }, "multiple floors"],
      [{ bedrooms: 2.5 }, "house plan was invalid"]
    ];
    for (const [plan, reason] of cases) {
      const app = wireBackend(() => ({ kind: "ok", commands: [], house: plan }));
      r = await app.say(AI_ONLY_HOME);
      assertEqual(r.tone, "error", r.text);
      assertIncludes(r.text, reason, "the real reason");
      assertEqual(buildAIProjectSnapshot(app.context).objects.length, 0, "nothing built");
      assertEqual(app.session.getState().stages?.some((stage) => stage.status === "done") ?? false, false, "no design was started");
    }
  });

  await check("a stage that fails part-way keeps nothing from that stage, keeps the stages before it, and can be tried again", async () => {
    const context = createProjectContext();
    let failing = true;
    // The third wall of the walls stage fails, after two have been placed.
    const commandExecutor = {
      execute: (command: unknown) =>
        failing && (command as { type?: string }).type === "wall.add" && context.wallStore.getAll().length >= 2
          ? { success: false, message: "Simulated failure." }
          : context.commandExecutor.execute(command as Parameters<typeof context.commandExecutor.execute>[0])
    };
    const session = new ArchitectSession({ commandExecutor, history: context.history, snapshot: () => buildAIProjectSnapshot(context), undo: () => context.history.undo() });
    r = await session.handle("Build a 10m x 8m brick house with 3 bedrooms at 0, 0");
    r = await session.handle("yes");
    assertEqual(context.slabStore.getAll().length, 1, "foundation built");

    r = await session.handle("next");
    assertEqual(r.tone, "error", r.text);
    assertIncludes(r.text, "Nothing from this stage was kept", "says the stage was rolled back");
    assertEqual(context.wallStore.getAll().length + context.pillarStore.getAll().length, 0, "no wall or pillar from the failed stage remains");
    assertEqual(context.slabStore.getAll().length, 1, "the foundation stays");
    assertTrue(session.getState().stages?.find((stage) => stage.id === "structure")?.status !== "done", "the walls stage isn't marked done");
    const retry = r.choices.find((choice) => choice.label === "Try again");
    assertTrue(retry !== undefined, "offers to try again");

    failing = false;
    r = await session.handle(retry!.say);
    assertEqual(r.tone, "success", r.text);
    assertTrue(context.wallStore.getAll().length > 4, "the retry raises the walls");
  });

  await check("the reported request in the panel plans every requested room and builds it stage by stage", async () => {
    const app = wire();
    r = await app.say("I want a complete 3-bedroom house on this 10 m × 8 m plot, with a living room, kitchen, two bathrooms, doors, windows, and a roof.");
    assertEqual(r.tone, "question", r.text);
    assertIncludes(r.text, "Where should the house go", "asks where first");
    r = await app.say("At the origin");
    assertIncludes(r.text, "Here's the plan", "planned - and says so");
    assertIncludes(r.text, "Bedroom 3", "three bedrooms");
    assertIncludes(r.text, "Bathroom 2", "two bathrooms");
    r = await app.say("yes");
    assertEqual(app.stageStatus().foundation, "done", "being built: the foundation is done");
    assertEqual(app.stageStatus().structure, "next", "and the walls are next");
    r = await app.say("Build everything");
    assertIncludes(r.text, "built of", "asks for the wall material");
    r = await app.say("concrete block");
    assertEqual(r.tone, "success", r.text);
    assertEqual(app.count().rooms, 7, "fully built: all seven rooms");
    assertEqual(app.count().roofs, 1, "with its roof");
    assertTrue(Object.values(app.stageStatus()).every((status) => status === "done"), "every stage done");
  });

  // --- One wall, by conversation (wallBuilder.ts): asked, never assumed ---

  await check("a wall is specified by conversation - a library material, then length, height, thickness, direction and position - and nothing is built until it's confirmed", async () => {
    const app = wire();
    const turns: [string, string][] = [
      ["Add a wall", "built of"],
      ["brick", "How long"],
      ["5 metres", "How high"],
      ["standard", "How thick"],
      ["230", "Which way"],
      ["east-west", "Where should its centre be"],
      ["at 2, 3", "Ready to build a 5 m long, 2.7 m high, 230 mm thick brick wall, running east–west (along X), centred at (2, 3)"]
    ];
    for (const [said, asked] of turns) {
      r = await app.say(said);
      assertEqual(r.tone, "question", `${said}: ${r.text}`);
      assertIncludes(r.text, asked, `after “${said}”`);
      assertEqual(app.count().walls, 0, `nothing built after “${said}”`);
    }
    r = await app.say("yes");
    assertEqual(r.tone, "success", r.text);
    assertIncludes(r.text, "3.105 m³ of masonry", "says how much masonry");
    const wall = app.context.wallStore.getAll()[0];
    assertEqual(JSON.stringify(wall.dimensions), JSON.stringify({ length: 5, height: 2.7, thickness: 0.23 }), "the dimensions asked for");
    assertEqual(`${wall.material} ${wall.color}`, "brick #a0522d", "brick, in the library's brick colour");
    assertEqual(JSON.stringify(wall.position), JSON.stringify({ x: 2, y: 1.35, z: 3 }), "centred where asked, standing on the ground");
    assertEqual(wall.rotation, 0, "running east-west");
    assertTrue(r.focusIds?.includes(wall.id), "the new wall is framed");
    r = await app.say("undo");
    assertEqual(app.count().walls, 0, "one undo removes it");
  });

  await check("one sentence with every detail goes straight to confirmation; a detail left out is asked for, never defaulted", async () => {
    const app = wire();
    r = await app.say("Build a 4 m long, 3 m high, 200 mm thick concrete block wall at 2, 3 running north-south");
    assertEqual(r.tone, "question", r.text);
    assertIncludes(r.text, "Ready to build a 4 m long, 3 m high, 200 mm thick concrete block wall, running north–south (along Z), centred at (2, 3)", "everything was said");
    r = await app.say("yes");
    const wall = app.context.wallStore.getAll()[0];
    assertEqual(`${wall.material} ${wall.dimensions.length}x${wall.dimensions.height}x${wall.dimensions.thickness}`, "concrete-block 4x3x0.2", "as said");
    assertEqual(wall.rotation, Math.PI / 2, "turned to run north-south");

    const other = wire();
    r = await other.say("Add a 5 m brick wall");
    assertIncludes(r.text, "How high", "the height wasn't said, so it's asked - no 2.7 m default");
  });

  await check("a wall's position can be picked in the 3D view, with a preview of its real footprint", async () => {
    const app = wire();
    r = await app.say("add a 6 m stone wall 2.7 m high 300 mm thick east-west");
    assertIncludes(r.text, "Where should its centre be", "only the position is missing");
    r = await app.say("pick a location");
    assertEqual(JSON.stringify(r.pickLocation), JSON.stringify({ footprint: { length: 6, width: 0.3 } }), "the pick previews a 6 m x 0.3 m wall");
    r = app.session.pickedLocation({ x: 10.04, z: -4.97 });
    assertIncludes(r.text, "centred at (10, -5)", "the clicked spot, rounded to 10 cm");
    r = await app.say("yes");
    assertEqual(JSON.stringify(app.context.wallStore.getAll()[0].position), JSON.stringify({ x: 10, y: 1.35, z: -5 }), "built where it was clicked");
  });

  await check("an impossible size is refused and asked again; an overlap is flagged before building; cancel builds nothing", async () => {
    const app = wire();
    r = await app.say("Add a 100 m brick wall");
    assertIncludes(r.text, "A wall length must be 0.3 m–50 m", "out of range");
    assertIncludes(r.text, "How long", "asked again");

    const crowded = wire();
    const existing = addStartupWall(crowded.context);
    r = await crowded.say("Build a 4 m long, 3 m high, 200 mm thick brick wall at 0, -4 running east-west");
    assertIncludes(r.text, `overlap ${existing}`, "the existing wall in the way is named");
    assertTrue(r.focusIds?.includes(existing), "and framed");
    r = await crowded.say("cancel");
    assertIncludes(r.text, "no wall was built", "cancelled");
    assertEqual(crowded.count().walls, 1, "only the existing wall");
  });

  // --- Conversation: corrections, "it" edits, and honest flags ---

  const FULL_WALL = "Build a 4 m long, 2.7 m high, 200 mm thick concrete block wall at 0, 0 running east-west";

  await check("corrections change the pending wall instead of cancelling it; a size with no dimension word asks which one", async () => {
    const app = wire();
    r = await app.say(FULL_WALL);
    assertTrue(r.preview && !r.applied, "a preview, nothing applied");
    r = await app.say("No, make it 5 metres");
    assertEqual(r.tone, "question", r.text);
    assertIncludes(r.text, "Is 5 m the wall's length or its height?", "ambiguous: asked, not guessed");
    r = await app.say("5 m long");
    assertIncludes(r.text, "Ready to build a 5 m long", "the length was corrected");
    r = await app.say("no, use brick instead");
    assertIncludes(r.text, "5 m long, 2.7 m high, 200 mm thick brick wall", "the material was corrected; the rest kept");
    assertEqual(app.count().walls, 0, "still nothing built");
    r = await app.say("cancel that");
    assertIncludes(r.text, "no wall was built", "cancel still cancels");
    assertEqual(app.count().walls, 0, "nothing built");
  });

  await check("after building, “it” is that wall: move it, resize it, change its material - each one undo step, saying before and after", async () => {
    const app = wire();
    await app.say(FULL_WALL);
    r = await app.say("yes");
    assertTrue(r.applied === true, "the build is marked applied");
    const id = app.context.wallStore.getAll()[0].id;
    r = await app.say("move it two metres east");
    assertTrue(r.applied === true && r.text.includes("centre (0, 0) → (2, 0)"), r.text);
    r = await app.say("make it 3 m high");
    assertIncludes(r.text, "height 2.7 m → 3 m", "resized");
    r = await app.say("use brick instead");
    assertIncludes(r.text, "material → brick", "material changed");
    const wall = app.context.wallStore.get(id)!;
    assertEqual(`${wall.position.x} ${wall.dimensions.height} ${wall.material} ${wall.color}`, "2 3 brick #a0522d", "the scene really changed");
    await app.say("undo");
    assertEqual(app.context.wallStore.get(id)!.material, "concrete-block", "one undo reverses only the material change");
    r = await app.say("make it 100 m long");
    assertIncludes(r.text, "A wall length must be", "an impossible size is refused");
    assertEqual(app.context.wallStore.get(id)!.dimensions.length, 4, "and nothing changed");
  });

  await check("“it” is never guessed: the wall just built vs a different selection is asked; with no target the user is asked to select one", async () => {
    const app = wire();
    r = await app.say("move it 1 m north");
    assertIncludes(r.text, "Which element do you mean?", "nothing built or selected yet");
    await app.say(FULL_WALL);
    await app.say("yes");
    const built = app.context.wallStore.getAll()[0].id;
    const other = app.context.commandExecutor.execute({ type: "wall.add", wall: { position: { x: 10, z: 10 } } });
    app.context.selectionStore.select(other.objectId!);
    r = await app.say("move it 1 m north");
    assertIncludes(r.text, `Which one do you mean - ${built}, which I just built, or the selected ${other.objectId}?`, "asked");
    assertTrue(!r.applied, "nothing moved yet");
    r = await app.say(other.objectId!);
    assertTrue(r.applied === true && r.text.includes("(10, 10) → (10, 9)"), `the chosen one moved north (-Z): ${r.text}`);
    assertEqual(app.context.wallStore.get(built)!.position.z, 0, "the other one didn't");
  });

  await check("honest flags: questions are never “applied”; a local answer is never labelled as the AI; an AI answer is", async () => {
    const app = wire();
    r = await app.say("Add a wall");
    assertTrue(!r.applied && !r.preview, "a question: neither applied nor a preview");
    r = await app.say("Build a 10m x 8m brick house with 3 bedrooms at 0, 0");
    assertTrue(r.preview === true && !r.applied, "the house plan is a preview");

    const local = wireBackend(() => ({ kind: "ok", commands: [{ type: "wall.add", wall: { length: 3, position: { x: 30, z: 30 } } }] }));
    r = await local.say("Add a garden pergola by the gate");
    assertEqual(r.source, "ai", "the backend provider was really called");
    assertTrue(r.applied === true, "and its commands changed the scene");

    const offline = wire();
    offline.context.commandExecutor.execute({ type: "wall.add", wall: { position: { x: 0, z: 0 } } });
    const id = offline.context.wallStore.getAll()[0].id;
    offline.context.selectionStore.select(id);
    r = await offline.say("make the selected wall 5 metres long");
    assertTrue(r.source !== "ai", `a deterministic edit resolved locally is not labelled AI (${r.source})`);
  });

  // --- One room, by conversation (roomBuilder.ts) ---

  const roomsOf = (context: ProjectContext) => context.elementStore.getAll().filter((element) => element.kind === "room");

  await check("a room is specified by conversation - floor, walls and placement asked, never assumed - previewed in the scene, then built as one undo step", async () => {
    const app = wire();
    r = await app.say("Create a 4 m by 5 m kitchen, 3 m high");
    assertIncludes(r.text, "Which floor?", "the floor is asked");
    assertIncludes(r.text, "Only the ground floor", "and the limitation is stated");
    r = await app.say("ground floor");
    assertIncludes(r.text, "Should I build walls around it?", "walls are asked");
    r = await app.say("brick");
    assertIncludes(r.text, "Where should the kitchen go?", "placement is asked");
    assertEqual(app.session.getState().preview ?? null, null, "no preview until it's fully placed");
    r = await app.say("at 4, 2");
    assertTrue(r.preview === true && !r.applied, "a preview, nothing built");
    assertIncludes(r.text, "4 m × 5 m kitchen (20 m² to wall centrelines), 3 m ceiling, 230 mm brick walls, centred at (4, 2) on the ground floor", "everything stated");
    const preview = app.session.getState().preview;
    assertTrue(preview && preview.sizeX === 4 && preview.sizeZ === 5 && preview.height === 3 && preview.walls.length === 4, `the 3D preview: ${JSON.stringify(preview)}`);
    assertEqual(roomsOf(app.context).length + app.context.wallStore.getAll().length, 0, "nothing built yet");

    r = await app.say("yes");
    assertTrue(r.applied === true, "applied");
    const room = roomsOf(app.context)[0];
    assertEqual(`${room.label} ${room.dimensions.length}x${room.dimensions.width}x${room.dimensions.height} @ ${room.position.x},${room.position.z}`, "Kitchen 4x5x3 @ 4,2", "the room zone");
    const walls = app.context.wallStore.getAll();
    assertEqual(walls.length, 4, "four enclosing walls");
    assertTrue(walls.every((wall) => wall.material === "brick" && wall.dimensions.height === 3 && wall.dimensions.thickness === 0.23), "brick, 3 m high, 230 mm");
    assertEqual(app.session.getState().preview ?? null, null, "the preview is gone once built");
    r = await app.say("undo");
    assertEqual(roomsOf(app.context).length + app.context.wallStore.getAll().length, 0, "one undo removes the room and all its walls");
    assertIncludes(r.text, `Undone — removed the kitchen (${room.id}) and 4 walls`, "the undo says exactly what it reversed");
    assertTrue(r.applied === true && r.undone === true, "flagged as an undo, not as a new change");
    r = await app.say("undo");
    assertIncludes(r.text, "There was nothing to undo", "an undo with nothing left changes nothing and says so");
    assertTrue(!r.applied && !r.undone, "and is not flagged as applied");
  });

  await check("room corrections before building: a dimension, an ambiguous size (asked), a move, and cancel", async () => {
    const app = wire();
    r = await app.say("Create a 4 m by 5 m kitchen, 3 m high, on the ground floor, brick walls, at 0, 0");
    assertTrue(r.preview === true, "straight to the preview when everything is said");
    r = await app.say("Make it 4.5 metres wide");
    assertIncludes(r.text, "4 m × 4.5 m kitchen", "width corrected");
    r = await app.say("make it 5 metres");
    assertIncludes(r.text, "Is 5 m the room's length (east–west), width (north–south) or ceiling height?", "ambiguous: asked, not guessed");
    r = await app.say("5 m long");
    assertIncludes(r.text, "5 m × 4.5 m kitchen", "length corrected");
    r = await app.say("move it 2 metres east");
    assertIncludes(r.text, "centred at (2, 0)", "moved before building");
    r = await app.say("Cancel that");
    assertIncludes(r.text, "no room was built", "cancelled");
    assertEqual(roomsOf(app.context).length, 0, "nothing built");
    assertEqual(app.session.getState().preview ?? null, null, "and no preview left behind");
  });

  await check("beside another room: only free sides are offered, the shared wall isn't built twice, and a blocked or unknown neighbour is explained", async () => {
    const app = wire();
    await app.say("Create a 4 m by 5 m kitchen, 3 m high, on the ground floor, brick walls, at 0, 0");
    await app.say("yes");
    const kitchenWalls = app.context.wallStore.getAll().length;
    r = await app.say("Create a 3 m by 4 m bedroom, 2.7 m high, brick walls, beside the kitchen");
    assertIncludes(r.text, "Which side of the kitchen? These sides are free", "the side is asked");
    assertTrue(["East side (right)", "West side (left)", "South side (front)", "North side (back)"].every((label) => r.choices.some((choice) => choice.label === label)), "all four free");
    r = await app.say("east");
    assertIncludes(r.text, "centred at (3.5, 0)", "flush against the kitchen's east side");
    assertIncludes(r.text, "shares", "the shared wall is called out");
    r = await app.say("yes");
    assertEqual(app.context.wallStore.getAll().length - kitchenWalls, 3, "three new walls, not four");
    r = await app.say("Create a 3 by 3 m study, 2.7 m high, no walls, beside the kitchen");
    assertTrue(!r.choices.some((choice) => choice.label.startsWith("East")), "east is taken now - not offered");
    r = await app.say("cancel");
    r = await app.say("Create a 4 by 4 m study, 2.7 m high, no walls, beside the garage");
    assertIncludes(r.text, "I can't find a room called “garage”", "an unknown neighbour is explained");
    r = await app.say("Create a kitchen on the first floor");
    assertIncludes(r.text, "only a ground floor", "upper floors: the limitation, and a question");
  });

  await check("after building, the room moves and resizes with its own walls, from the scene's current state - undo and the record book follow", async () => {
    const app = wire();
    await app.say("Create a 4 m by 5 m kitchen, 3 m high, on the ground floor, brick walls, at 0, 0");
    await app.say("yes");
    const id = roomsOf(app.context)[0].id;
    r = await app.say("move it 1 m east");
    assertTrue(r.applied === true, "moved");
    await app.say("undo");
    assertEqual(roomsOf(app.context)[0].position.x, 0, "undone");
    r = await app.say("make it 6 m long");
    assertIncludes(r.text, "length 4 m → 6 m", "resized from the current state (not the pre-undo memory)");
    const room = roomsOf(app.context)[0];
    assertEqual(`${room.position.x} ${room.dimensions.length}`, "0 6", "still centred where it was");
    const east = app.context.wallStore.getAll().find((wall) => Math.abs(wall.position.x - 3) < 1e-6);
    assertTrue(east !== undefined, "the east wall moved out to x = 3 with it");
    const records = buildRecordBook(buildAIProjectSnapshot(app.context).objects);
    const roomRecord = records.rows.find((row) => row.id === id)!;
    assertEqual(`${roomRecord.length} ${roomRecord.area}`, "6 30", "the record book follows: 6 m long, 30 m²");
  });

  await check("a room request as speech recognition writes it - no commas, metres spelled out - is understood in full; a spoken correction without a dimension is asked about", async () => {
    const app = wire();
    // What voice input sends after spokenNumbers() ("four by five metre ... at zero zero").
    r = await app.say("create a 4 by 5 metre kitchen 3 metres high on the ground floor brick walls at 0 0");
    assertTrue(r.preview === true, `straight to the preview: ${r.text}`);
    assertIncludes(r.text, "4 m × 5 m kitchen (20 m² to wall centrelines), 3 m ceiling, 230 mm brick walls, centred at (0, 0)", "everything heard");
    r = await app.say("make it 4.5 metres wide");
    assertIncludes(r.text, "4 m × 4.5 m kitchen", "a spoken correction while the preview is up");
    r = await app.say("make it 5 metres");
    assertIncludes(r.text, "length (east–west), width (north–south) or ceiling height", "no dimension word: asked, never guessed");
    assertTrue(!r.applied, "nothing built");
    r = await app.say("make it 5 m long");
    r = await app.say("build it");
    assertTrue(r.applied === true, "built on “build it”");
    const room = roomsOf(app.context)[0];
    assertEqual(`${room.dimensions.length} x ${room.dimensions.width}`, "5 x 4.5", "the 3D result has the corrected size");
    assertEqual(app.context.wallStore.getAll().length, 4, "with its four walls - built once");
  });

  await check("“1 m wider” changes the current size by 1 m (never a new size of 1 m); a room named by name must be the whole noun - “the kitchen table” is not the kitchen", async () => {
    const app = wire();
    await app.say("Create a 4 m by 5 m kitchen, 3 m high, on the ground floor, brick walls, at 0, 0");
    await app.say("yes");
    const kitchen = () => roomsOf(app.context)[0];
    r = await app.say("make the kitchen 1 m wider");
    assertEqual(`${kitchen().dimensions.width} ${r.applied === true}`, "6 true", `5 m + 1 m: ${r.text}`);
    r = await app.say("make it 0.5 m lower");
    assertEqual(kitchen().dimensions.height, 2.5, "3 m - 0.5 m");
    r = await app.say("move the kitchen table 1 m east");
    assertEqual(kitchen().position.x, 0, "the kitchen itself did not move for “the kitchen table”");

    const walls = wire();
    await walls.say("Build a 4 m long, 3 m high, 200 mm thick concrete block wall at 10, 3 running north-south");
    await walls.say("yes");
    const wall = () => walls.context.wallStore.getAll()[0];
    r = await walls.say("make it 1 m longer");
    assertEqual(wall().dimensions.length, 5, `4 m + 1 m: ${r.text}`);
    r = await walls.say("make it 0.5 m shorter");
    assertEqual(wall().dimensions.length, 4.5, "5 m - 0.5 m");
    r = await walls.say("make it 3 m long");
    assertEqual(wall().dimensions.length, 3, "an absolute size still sets it");
  });

  await check("a pipe run by conversation: sheet-size pipes joined end to end in one undo step, the fittings named; a branch at a joint makes the reducing tee; a size not on the sheet is asked about", async () => {
    const app = wire();
    r = await app.say("Run a 25 mm water pipe from 0, 0 to 6, 0");
    assertTrue(r.applied === true, `built: ${r.text}`);
    r = await app.say("Run a 25 mm water pipe from 6, 0 to 6, 3");
    assertIncludes(r.text, "1 × 25 mm 90° elbow (sheet p.2)", "the corner takes the sheet's 90° elbow");
    assertIncludes(r.text, "Joined to water-pipe-", "joined to the first run's end");
    r = await app.say("Run a 25 mm water pipe from 0, 0 to -3, 0");
    assertIncludes(r.text, "1 × 25 mm coupler", "a straight continuation takes a coupler");
    r = await app.say("Run a 20 mm water pipe from 0, 0 to 0, 2");
    assertIncludes(r.text, "1 × 25 × 20 mm reducing tee (sheet p.1)", "a 20 mm branch at the coupler's joint makes it a reducing tee");
    const pipes = () => app.context.elementStore.getAll().filter((element) => element.kind === "water-pipe").length;
    assertEqual(pipes(), 4, "four pipes");
    r = await app.say("Run a 32 mm water pipe from 8, 0 to 9, 0");
    assertIncludes(r.text, "has no 32 mm clean-water pipe", "32 mm isn't on the sheet: asked, not guessed");
    assertTrue(r.choices.some((choice) => choice.label === "20 mm") && !r.applied, "the sheet sizes offered, nothing built");
    await app.say("undo");
    assertEqual(pipes(), 3, "one undo removes the last run");
    const joints = resolveJoints(buildAIProjectSnapshot(app.context).objects).map((joint) => joint.fitting?.label ?? "unresolved");
    assertEqual([...joints].sort().join(" | "), "25 mm 90° elbow | 25 mm coupler", "the tee is a coupler again");
  });

  await check("pipe runs by conversation, as built: a pending question lets a run through, two sizes are lined up, a loop closes, a said height or 'hot' isn't lost, and look/cancel phrases build nothing", async () => {
    for (const [text, kind] of [
      ["cancel the pipe from 0, 0 to 3, 0", "location"],
      ["focus on the pipe from 0, 0 to 3, 0", "show"],
      ["Add a 3 m wall next to the water pipe from 0, 0 to 3, 0", "build-wall"]
    ] as const) {
      assertEqual(parseUtterance(text).kind, kind, `"${text}" is still ${kind}, not a pipe run`);
    }

    let app = wire();
    const pipes = () => app.context.elementStore.getAll().filter((element) => element.kind === "water-pipe");
    await app.say("add a 5 m brick wall 3 m high 230 mm thick");
    await app.say("east-west");
    r = await app.say("at 9, 9");
    assertIncludes(r.text, "centred at (9, 9)", "a wall waiting for its Build it");
    r = await app.say("Run a 25 mm water pipe from 4, 4 to 7, 4");
    assertTrue(r.applied === true && pipes().length === 1, `the pipe run is let through, not read as the wall's position: ${r.text}`);
    assertEqual(app.context.wallStore.getAll().length, 0, "and the wall isn't built somewhere else");

    app = wire();
    await app.say("Run a 25 mm water pipe from 0, 0 to 3, 0");
    await app.say("Run a 20 mm water pipe from 5, 0 to 8, 0");
    const twenty = pipes()[1];
    const before = twenty.position.y;
    r = await app.say("Run a 25 mm water pipe from 3, 0 to 5, 0");
    assertTrue(r.applied === true, `a run between a 25 mm and a 20 mm pipe is built: ${r.text}`);
    assertIncludes(r.text, "raised 3.4 mm to line up", "the 20 mm pipe is lined up, and the reply says so");
    assertIncludes(r.text, "reducer", "a reducer where the sizes meet");
    assertTrue(Math.abs(app.context.elementStore.get(twenty.id)!.position.y - pipes()[0].position.y) < 1e-6, "at the run's height");
    await app.say("undo");
    assertTrue(Math.abs(app.context.elementStore.get(twenty.id)!.position.y - before) < 1e-6, "undo puts it back");
    assertEqual(pipes().length, 2, "and removes the run");

    r = await app.say("Run a 25 mm water pipe from 3.03, 0 to 4.5, 0");
    assertIncludes(r.text, "1.5 m, from (3, 0) to (4.5, 0)", "the reply gives the run as built, from the end it joined");
    await app.say("undo");
    r = await app.say("Run a 25 mm water pipe from 3, 0 to 3, 2 at a height of 2 m");
    assertTrue(!r.applied && /You asked for 2 m/.test(r.text) && pipes().length === 2, `a said height the join can't keep is refused: ${r.text}`);

    r = await app.say("Run a 25 mm water pipe from 10, 10 to 13, 10 to 13, 12 to 10, 12 to 10, 10");
    assertIncludes(r.text, "4 × 25 mm 90° elbow", "a rectangle has four corners");
    assertIncludes(r.text, "Closed back on its start", "and says it's closed");

    r = await app.say("Run a 25 mm hot water pipe from 20, 0 to 22, 0");
    assertIncludes(r.text, "25 mm hot-water pipe", "hot water is said back");
    assertEqual(pipes()[pipes().length - 1].params.system, "hot", "and stored as System: hot");
    r = await app.say("Run a 25 mm water pipe from 22, 0 to 22, 2");
    assertIncludes(r.text, "25 mm hot-water pipe", "a run from the hot pipe's end continues hot (read through elementParams)");
    assertEqual(pipes()[pipes().length - 1].params.system, "hot", "stored hot");
    const before2 = pipes().length;
    r = await app.say("Run a 25 mm cold water pipe from 20, 0 to 20, -2");
    assertTrue(!r.applied && /never joined/.test(r.text) && pipes().length === before2, `a cold run from a hot pipe's end is refused: ${r.text}`);
  });

  await check("corrections by conversation reach the object meant: 'that room', 'that kitchen', the door to the other (or a named) wall - with 'No, stop.' in front - and undo puts it back", async () => {
    const app = wire();
    const room = () => app.context.elementStore.getAll().find((element) => element.kind === "room")!;
    const door = () => app.context.doorStore.getAll()[0];
    await app.say("Create a 4 by 5 metre kitchen at 8, 6, 3 metres high, brick walls, on the ground floor");
    r = await app.say("build it");
    assertTrue(r.applied === true, `built: ${r.text}`);
    assertEqual(`${room().position.x},${room().position.z} ${room().dimensions.length}x${room().dimensions.width} h${room().dimensions.height}`, "8,6 4x5 h3", "at a nonzero point, exactly as said");
    r = await app.say("Make that room 4.5 metres wide");
    assertTrue(r.applied === true && /width 5 m → 4\.5 m/.test(r.text), `"that room" is the kitchen just built: ${r.text}`);
    assertEqual(app.context.elementStore.getAll().filter((element) => element.kind === "room").length, 1, "no second room was created");
    r = await app.say("add a door to the kitchen's front wall");
    const front = door().hostId;
    r = await app.say("Put the door on the other wall");
    assertTrue(r.applied === true && door().hostId !== front && /front wall .* to its back wall/.test(r.text), `the other wall is the opposite one: ${r.text}`);
    r = await app.say("move the door to the east wall");
    assertTrue(r.applied === true && /to its right wall/.test(r.text), `east is the right (+X) wall: ${r.text}`);
    const east = door().hostId;
    r = await app.say("No, stop. Put the door on the other wall.");
    assertTrue(r.applied === true && /right wall .* to its left wall/.test(r.text), `"No, stop." in front still moves it: ${r.text}`);
    await app.say("undo");
    assertEqual(door().hostId, east, "undo puts it back in the east wall");
    assertEqual(app.context.doorStore.getAll().length, 1, "one door throughout - moved, never duplicated");
    await app.say("Create a 3 by 3 metre store at 20, 6, 3 metres high, brick walls, on the ground floor");
    await app.say("build it");
    r = await app.say("make that kitchen 5 m long");
    assertTrue(r.applied === true && /\(the kitchen\): length 4 m → 5 m/.test(r.text), `"that kitchen" by name: ${r.text}`);
  });

  await check("'that room' is asked about when it could be two rooms - nothing changes until the user says which", async () => {
    const app = wire();
    await app.say("Create a 4 by 5 metre kitchen at 0, 0, 3 metres high, brick walls, on the ground floor");
    await app.say("build it");
    await app.say("Create a 3 by 3 metre store at 12, 0, 3 metres high, brick walls, on the ground floor");
    await app.say("build it");
    const kitchen = app.context.elementStore.getAll().find((element) => element.kind === "room" && element.position.x === 0)!;
    app.context.selectionStore.select(kitchen.id);
    const before = JSON.stringify(app.context.elementStore.getAll().map((element) => [element.id, element.dimensions]));
    r = await app.say("make that room 3.5 metres wide");
    assertTrue(r.tone === "question" && !r.applied && r.choices.filter((choice) => choice.say !== "cancel").length === 2, `asked, with both rooms (and Neither): ${r.text}`);
    assertEqual(JSON.stringify(app.context.elementStore.getAll().map((element) => [element.id, element.dimensions])), before, "nothing changed");
    r = await app.say(r.choices.find((choice) => /kitchen/i.test(choice.label))!.say);
    assertTrue(r.applied === true && /the kitchen\): width 5 m → 3\.5 m/.test(r.text), `the answer applies it to the kitchen: ${r.text}`);
  });

  await check("moving an opening to another wall never swallows adding one or sliding one: adds stay adds, slides stay slides, a window keeps its sill, the destination isn't read as the door's current wall", async () => {
    const app = wire();
    await app.say("Create a 4 by 5 metre kitchen at 0, 0, 3 metres high, brick walls, on the ground floor");
    await app.say("build it");
    await app.say("add a window to the kitchen's front wall");
    const windows = () => app.context.windowStore.getAll();
    const first = windows()[0];
    r = await app.say("Put a window in the back wall of the kitchen");
    assertEqual(windows().length, 2, `"put a window in the back wall" adds one: ${r.text}`);
    assertEqual(app.context.windowStore.get(first.id)!.hostId, first.hostId, "the existing window stays where it was");
    r = await app.say(`move ${first.id} to the left wall`);
    const moved = app.context.windowStore.get(first.id)!;
    assertTrue(r.applied === true && moved.hostId !== first.hostId, `relocated: ${r.text}`);
    assertTrue(Math.abs(moved.position.y - first.position.y) < 1e-6, `a window keeps its sill height (y ${first.position.y} -> ${moved.position.y})`);
    await app.say("add a door to the kitchen's front wall");
    const door = () => app.context.doorStore.getAll()[0];
    const frontWall = door().hostId;
    const offsetBefore = door().hostPlacement?.offset ?? 0;
    r = await app.say("move the door on the front wall 1 m left");
    assertEqual(door().hostId, frontWall, `a slide stays in its wall: ${r.text}`);
    assertTrue(Math.abs((door().hostPlacement?.offset ?? 0) - offsetBefore) > 0.5, "and slides along it");
    r = await app.say("put the kitchen door on the left wall");
    assertTrue(!r.applied && /overlaps/.test(r.text) && door().hostId === frontWall, `the left wall already holds the window: refused, nothing changed: ${r.text}`);
    r = await app.say("put the kitchen door on the right wall");
    assertTrue(r.applied === true && door().hostId !== frontWall && /to its right wall/.test(r.text), `"the kitchen door on the right wall": the destination, not a filter on its current wall: ${r.text}`);
    const room = app.context.elementStore.getAll().find((element) => element.kind === "room")!;
    const size = JSON.stringify(room.dimensions);
    r = await app.say("make the wall in that room 4.5 m long");
    assertEqual(JSON.stringify(app.context.elementStore.get(room.id)!.dimensions), size, `"the wall in that room" never resizes the room: ${r.text}`);
    r = await app.say("make that room's left wall 6 m long");
    assertEqual(JSON.stringify(app.context.elementStore.get(room.id)!.dimensions), size, `"that room's left wall" is about the wall, never the room: ${r.text}`);
    const host = door().hostId;
    const offset = door().hostPlacement?.offset ?? 0;
    r = await app.say("move the door to the front wall by half a metre");
    assertEqual(door().hostId, host, `"by half a metre" is a slide, not a move to another wall: ${r.text}`);
    assertTrue(Math.abs(Math.abs((door().hostPlacement?.offset ?? 0) - offset) - 0.5) < 1e-6 || /can't|past|no room|Which way/i.test(r.text), `slid 0.5 m (or refused as a slide): ${r.text}`);
  });

  await check("a door between two rooms with the SAME name: the whose-wall question is answered by its chips (room ids) - no loop; a destination room the opening isn't in is refused", async () => {
    const app = wire();
    await app.say("Create a 4 by 4 metre bedroom at 0, 0, 3 metres high, brick walls, on the ground floor");
    await app.say("build it");
    await app.say("Create a 4 by 4 metre bedroom at 4, 0, 3 metres high, brick walls, on the ground floor");
    r = await app.say("build it");
    const snapshot = buildAIProjectSnapshot(app.context);
    const rooms = listRooms(snapshot);
    assertEqual(rooms.filter((room) => room.name === "Bedroom").length, 2, `two rooms named Bedroom: ${r.text}`);
    const walls = rooms.map((room) => new Set(describeRoom(snapshot, room).walls.map((wall) => wall.wall.id)));
    const shared = [...walls[0]].find((id) => walls[1].has(id));
    assertTrue(shared, "they share a wall");
    const added = app.context.commandExecutor.execute({ type: "door.add", door: { hostId: shared } });
    assertTrue(added.success && added.objectId, `a door in the shared wall: ${added.message}`);
    const doorId = added.objectId!;
    r = await app.say(`move ${doorId} to the north wall`);
    assertTrue(r.tone === "question" && r.choices.length === 2 && r.choices[0].label !== r.choices[1].label, `asked, with distinguishable choices: ${r.choices.map((choice) => choice.label).join(" / ")}`);
    r = await app.say(r.choices[0].say);
    assertTrue(r.applied === true && app.context.doorStore.get(doorId)!.hostId !== shared, `the chip answers it - no loop: ${r.text}`);
    await app.say("undo");
    // A destination in a room the door isn't in: refused, nothing moves.
    await app.say("Create a 3 by 3 metre store at 20, 0, 3 metres high, brick walls, on the ground floor");
    await app.say("build it");
    r = await app.say(`move ${doorId} to the north wall of the store`);
    assertTrue(!r.applied && /can only move to another wall/.test(r.text) && app.context.doorStore.get(doorId)!.hostId === shared, `refused, not moved into its own room's wall: ${r.text}`);
  });

  await check("a door between two rooms: 'move it to the north wall' asks whose wall - and a typed answer is understood", async () => {
    const app = wire();
    await app.say("Build a 12m x 9m brick house with 3 bedrooms at 0, 0");
    r = await app.say("Build everything");
    const snapshot = buildAIProjectSnapshot(app.context);
    const rooms = listRooms(snapshot);
    const shared = app.context.doorStore.getAll().find((door) => rooms.filter((room) => describeRoom(snapshot, room).openings.some((opening) => opening.object.id === door.id)).length === 2);
    assertTrue(shared, `a door between two rooms exists (${app.context.doorStore.getAll().length} doors)`);
    const host = shared.hostId;
    r = await app.say(`move ${shared.id} to the north wall`);
    assertTrue(r.tone === "question" && r.choices.length === 2 && !r.applied, `asked whose north wall: ${r.text}`);
    assertEqual(app.context.doorStore.get(shared.id)!.hostId, host, "nothing moved yet");
    const owner = r.choices[0].label.replace(/^The (.*)'s north wall$/, "$1");
    r = await app.say(owner.toLowerCase());
    assertTrue(!/AI model/.test(r.text) && r.source !== "ai", `the typed answer is taken as the answer, not sent to the AI: ${r.text}`);
  });

  await check("'which room?' remembers its question: a typed room name answers it", async () => {
    const app = wire();
    await app.say("Create a 4 by 5 metre kitchen at 0, 0, 3 metres high, brick walls, on the ground floor");
    await app.say("build it");
    await app.say("Create a 3 by 3 metre store at 12, 0, 3 metres high, brick walls, on the ground floor");
    await app.say("build it");
    const kitchen = app.context.elementStore.getAll().find((element) => element.kind === "room" && element.position.x === 0)!;
    app.context.selectionStore.select(kitchen.id);
    r = await app.say("make that room 3.5 metres wide");
    assertTrue(r.tone === "question", `asked: ${r.text}`);
    r = await app.say("the kitchen");
    assertTrue(r.applied === true && /the kitchen\): width 5 m → 3\.5 m/.test(r.text), `answered by typing: ${r.text}`);
    // Any verb the question accepts - its chips answer by room id, not by rebuilding a sentence. (The kitchen was just changed; select the store so "that room" could be either.)
    const store = app.context.elementStore.getAll().find((element) => element.kind === "room" && element.id !== kitchen.id)!;
    app.context.selectionStore.select(store.id);
    r = await app.say("push that room 1 m north");
    assertTrue(r.tone === "question", `asked again: ${r.text}`);
    const before = app.context.elementStore.get(kitchen.id)!.position.z;
    r = await app.say(r.choices.find((choice) => /kitchen/i.test(choice.label))!.say);
    assertTrue(r.applied === true && Math.abs(app.context.elementStore.get(kitchen.id)!.position.z - (before - 1)) < 1e-6, `"push" answered by the chip: ${r.text}`);
  });

  await check("a turn still waiting on the AI is cancelled by its signal: Stop applies nothing, and an old reply arriving after a newer correction cannot change the model", async () => {
    // A provider that answers only when told to - like a slow network.
    const releases: Array<() => void> = [];
    const slow = {
      interpret: () =>
        new Promise<{ commands: unknown[] }>((resolve) => {
          releases.push(() => resolve({ commands: [{ type: "wall.add", wall: { position: { x: 30, z: 30 } } }] }));
        })
    };
    const context = createProjectContext();
    const service = new AIService({ provider: slow as never, commandExecutor: context.commandExecutor, history: context.history, snapshotSource: context });
    const session = new ArchitectSession({ commandExecutor: context.commandExecutor, history: context.history, snapshot: () => buildAIProjectSnapshot(context), undo: () => context.history.undo(), fallback: (instruction, options) => service.submit(instruction, options) });
    const walls = () => context.wallStore.getAll().length;

    // 1. Stop while thinking.
    const stopped = new AbortController();
    const pending = session.handle("add a garden pergola by the gate", { signal: stopped.signal });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assertEqual(releases.length, 1, "the AI was asked");
    stopped.abort();
    releases[0]();
    const cancelled = await pending;
    assertTrue(cancelled.cancelled === true && !cancelled.applied, `cancelled, not applied: ${cancelled.text}`);
    assertEqual(walls(), 0, "the late reply's wall was never built");
    assertEqual(context.history.canUndo(), false, "and nothing reached the undo history");

    // 2. A newer correction while the old turn is still thinking.
    const old = new AbortController();
    const oldTurn = session.handle("add a garden pergola by the gate", { signal: old.signal });
    await new Promise((resolve) => setTimeout(resolve, 10));
    old.abort(); // what the panel does when a new turn arrives
    const newer = await session.handle("Create a 3 by 3 metre store at 0, 0, 3 metres high, brick walls, on the ground floor");
    assertTrue(newer.tone === "question", `the correction runs at once: ${newer.text}`);
    const built = await session.handle("build it");
    assertTrue(built.applied === true, `and is built: ${built.text}`);
    const after = JSON.stringify(context.wallStore.getAll().map((wall) => [wall.id, wall.position]));
    releases[1](); // the old reply finally arrives
    const late = await oldTurn;
    assertTrue(late.cancelled === true && !late.applied, `the old reply is dropped: ${late.text}`);
    assertEqual(JSON.stringify(context.wallStore.getAll().map((wall) => [wall.id, wall.position])), after, "the newer correction stands untouched");
  });

  // --- a room after save and reopen: nothing remembered, everything read from the saved scene ---

  /** Saves `app`'s project as JSON and opens it in a brand-new context and session - no memory of how anything was built. */
  const reopen = (app: Wired): Wired => {
    const document = JSON.parse(JSON.stringify(serializeProject(app.context)));
    const fresh = wire();
    const loaded = loadProject(fresh.context, document);
    assertTrue(loaded.ok, `the saved project reopens: ${loaded.ok ? "" : loaded.error}`);
    return fresh;
  };
  /** The record book's view of the scene: one row per object, as "id length area @ x,z". */
  const book = (context: ProjectContext) =>
    buildRecordBook(buildAIProjectSnapshot(context).objects)
      .rows.map((row) => `${row.id} ${row.length ?? "-"} ${row.area ?? "-"} @ ${row.position.x},${row.position.z}`)
      .sort()
      .join(" | ");
  /** Every object as the stores have it, in the record book's terms - what the book must match. */
  const sceneRows = (context: ProjectContext) =>
    buildAIProjectSnapshot(context)
      .objects.map((object) => {
        const length = object.dimensions.length ?? null;
        // A room's floor area; a wall's one face (length x height) - the record book's own bases.
        const area = object.kind === "room" ? (object.dimensions.length ?? 0) * (object.dimensions.width ?? 0) : object.type === "wall" ? (object.dimensions.length ?? 0) * (object.dimensions.height ?? 0) : null;
        return { id: object.id, length, area: area === null ? null : Number(area.toFixed(3)), x: object.position.x, z: object.position.z };
      });
  const ownSides = (app: Wired, roomId: string) => Object.keys(roomPartsOf(buildAIProjectSnapshot(app.context), roomId)?.own ?? {}).sort().join(" ");

  await check("a saved and reopened room moves and resizes with its own walls, from the saved scene alone - undo, redo and the record book follow, and nothing is duplicated", async () => {
    const built = wire();
    await built.say("Create a 4 m by 5 m kitchen, 3 m high, on the ground floor, brick walls, at 0, 0");
    await built.say("yes");
    const app = reopen(built);
    const roomId = roomsOf(app.context)[0].id;
    const counts = () => `${roomsOf(app.context).length} room, ${app.context.wallStore.getAll().length} walls`;
    assertEqual(counts(), "1 room, 4 walls", "reopened: the same room and walls, nothing added");
    assertEqual(ownSides(app, roomId), "back front left right", "its four walls are recognised as its own from their saved geometry");

    r = await app.say("move the kitchen 2 m east");
    assertTrue(r.applied === true, `moved by name: ${r.text}`);
    const wallAt = (side: string) => {
      const wall = roomPartsOf(buildAIProjectSnapshot(app.context), roomId)?.own[side as "front"];
      return wall ? `${wall.position.x},${wall.position.z} ${wall.dimensions.length}` : "missing";
    };
    assertEqual(`${wallAt("front")} | ${wallAt("back")} | ${wallAt("left")} | ${wallAt("right")}`, "2,2.5 4.23 | 2,-2.5 4.23 | 0,0 4.77 | 4,0 4.77", "every wall moved with it");
    assertEqual(counts(), "1 room, 4 walls", "moved, not copied");

    app.context.selectionStore.select(roomId);
    r = await app.say("make it 4.5 m wide");
    assertTrue(r.applied === true, `resized as the selection: ${r.text}`);
    assertEqual(`${wallAt("front")} | ${wallAt("back")} | ${wallAt("left")} | ${wallAt("right")}`, "2,2.25 4.23 | 2,-2.25 4.23 | 0,0 4.27 | 4,0 4.27", "the walls follow the new width");
    const afterResize = book(app.context);
    assertIncludes(afterResize, `${roomId} 4 18 @ 2,0`, "the record book: 4 m × 4.5 m = 18 m², centred at (2, 0)");
    for (const row of sceneRows(app.context)) {
      assertIncludes(afterResize, `${row.id} ${row.length ?? "-"} ${row.area ?? "-"} @ ${row.x},${row.z}`, `the book matches the scene for ${row.id}`);
    }

    app.context.history.undo();
    assertEqual(`${wallAt("front")} | ${wallAt("left")}`, "2,2.5 4.23 | 0,0 4.77", "undo: back to 5 m wide, walls included");
    assertIncludes(book(app.context), `${roomId} 4 20 @ 2,0`, "the book follows the undo");
    app.context.history.redo();
    assertEqual(`${wallAt("front")} | ${wallAt("left")}`, "2,2.25 4.23 | 0,0 4.27", "redo: 4.5 m wide again, walls included");
    assertEqual(book(app.context), afterResize, "the book follows the redo exactly");
    app.context.history.undo();
    app.context.history.undo();
    assertEqual(`${wallAt("front")} | ${wallAt("right")}`, "0,2.5 4.23 | 2,0 4.77", "two undos: where it was when reopened");
    assertEqual(counts(), "1 room, 4 walls", "still nothing duplicated");
    assertEqual(app.context.history.canUndo(), false, "and nothing older to undo - the reopened project starts a fresh history");

    // Saved again after the edits and reopened: the edits are the saved model.
    app.context.history.redo();
    const again = reopen(app);
    assertEqual(book(again.context), book(app.context), "saved again and reopened: the same record book");
    assertEqual(ownSides(again, roomId), "back front left right", "and the same room with its own walls");
  });

  await check("after reopening, a wall shared with a neighbour stays put: a change that would break it is explained and asked about, a change along it is allowed", async () => {
    const built = wire();
    await built.say("Create a 4 m by 5 m kitchen, 3 m high, on the ground floor, brick walls, at 0, 0");
    await built.say("yes");
    await built.say("Create a 3 m by 4 m bedroom, 2.7 m high, brick walls, beside the kitchen");
    await built.say("east");
    await built.say("yes");
    const app = reopen(built);
    const kitchen = roomsOf(app.context).find((room) => room.label === "Kitchen")!;
    const bedroom = roomsOf(app.context).find((room) => room.label === "Bedroom")!;
    const shared = roomPartsOf(buildAIProjectSnapshot(app.context), bedroom.id)!.fixed.map((entry) => entry.wall.id).join(" ");
    assertTrue(shared.length > 0, "the bedroom's west wall is recognised as shared");
    assertEqual(ownSides(app, bedroom.id), "back front right", "and its other three walls as its own");
    assertEqual(ownSides(app, kitchen.id), "back front left", "the kitchen's east wall is shared too - not its own any more");
    const before = book(app.context);

    r = await app.say("move the kitchen 1 m east");
    assertIncludes(r.text, `which it shares with the bedroom`, "the shared wall is named");
    assertIncludes(r.text, "Nothing was changed", "nothing changed");
    assertTrue(r.tone === "question" && !r.applied, "and the user is asked what to do instead");
    r = await app.say("move the bedroom 1 m east");
    assertIncludes(r.text, "pull the bedroom off it", "moving away from the shared wall is refused");
    r = await app.say("make the bedroom 3.2 m high");
    assertIncludes(r.text, "can't change with this room alone", "a ceiling the shared 3 m wall doesn't match is refused");
    assertEqual(book(app.context), before, "none of those changed anything");

    r = await app.say("move the bedroom 0.3 m north");
    assertTrue(r.applied === true, `sliding along the shared wall is fine: ${r.text}`);
    assertIncludes(r.text, `${shared} stays as it is`, "and says the shared wall stayed");
    const moved = roomPartsOf(buildAIProjectSnapshot(app.context), bedroom.id)!;
    assertEqual(`${moved.center.x},${moved.center.z} own ${Object.keys(moved.own).sort().join(" ")}`, "3.5,-0.3 own back front right", "the bedroom and its own walls moved together");
    assertEqual(moved.fixed.map((entry) => `${entry.wall.id} ${entry.wall.position.x},${entry.wall.position.z}`).join(" "), `${shared} 2,0`, "the shared wall didn't move");
    assertEqual(`${roomsOf(app.context).length} rooms, ${app.context.wallStore.getAll().length} walls`, "2 rooms, 7 walls", "nothing duplicated");
    app.context.history.undo();
    assertEqual(book(app.context), before, "one undo puts everything back");

    r = await app.say("make the bedroom 3.5 m long");
    assertTrue(r.applied === true, `a resize against a shared wall grows away from it: ${r.text}`);
    const grown = roomPartsOf(buildAIProjectSnapshot(app.context), bedroom.id)!;
    assertEqual(`${grown.center.x} ${grown.room.length} west edge ${grown.center.x - grown.room.length / 2}`, "3.75 3.5 west edge 2", "it grew east; its west side stays on the shared wall at x = 2");
    assertEqual(Object.keys(grown.own).sort().join(" "), "back front right", "its own walls followed it");
    assertIncludes(book(app.context), `${bedroom.id} 3.5 14 @ 3.75,0`, "the record book: 3.5 m × 4 m = 14 m²");
    r = await app.say("make the kitchen 6 m long");
    assertTrue(r.applied === true, `the kitchen grows west, away from the shared wall: ${r.text}`);
    const kitchenNow = roomPartsOf(buildAIProjectSnapshot(app.context), kitchen.id)!;
    assertEqual(`${kitchenNow.center.x} east edge ${kitchenNow.center.x + kitchenNow.room.length / 2}`, "-1 east edge 2", "its east side stays on the shared wall");
  });

  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) {
    throw new Error(`${failed} architect check(s) failed`);
  }
}

await main();
