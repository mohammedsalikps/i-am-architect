/**
 * Verification for Interior Explore (engine/interior/interiorExplore.ts):
 * rooms read from real projects, viewpoints, walking limits, and the
 * session's visibility/selection handling - driven through the REAL
 * ProjectContext (stores, CommandExecutor, history) and a house built by
 * the real Architect conversation, exactly as the app builds one. Needs
 * `--experimental-transform-types` (see the root package.json).
 */
import { createProjectContext, serializeProject } from "../project/ProjectContext.ts";
import type { ProjectContext } from "../project/ProjectContext.ts";
import { buildAIProjectSnapshot } from "../ai/types.ts";
import { ArchitectSession } from "../architect/ArchitectSession.ts";
import { VisibilityStore } from "../../scene/visibility/VisibilityStore.ts";
import { EYE_HEIGHT, InteriorExploreSession, PITCH_LIMIT, WALL_CLEARANCE, clampToRoom, facing, interiorRooms, lookDirection, roomViewpoint, turn, walk } from "./interiorExplore.ts";
import type { InteriorRoom } from "./interiorExplore.ts";

let passed = 0;
let failed = 0;

async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed += 1;
    console.log(`  ok - ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL - ${name}\n      ${error instanceof Error ? error.message : String(error)}`);
  }
}

function assertTrue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

/** A 3-bedroom house, furnished, built through the Architect conversation - the app's own path. */
async function builtHouse(): Promise<ProjectContext> {
  const context = createProjectContext();
  const session = new ArchitectSession({
    commandExecutor: context.commandExecutor,
    history: context.history,
    snapshot: () => buildAIProjectSnapshot(context),
    elementParams: (id) => context.elementStore.get(id)?.params,
    undo: () => context.history.undo(),
    fallback: async () => ({ commands: [], errors: [], notes: "" }) as never
  });
  for (const line of ["Set up a 30 x 20 m site", "Build a house", "3 bedrooms, 12 x 9 m", "Use the site centre", "yes", "Build the rest of the house", "Brick"]) await session.handle(line);
  return context;
}

function explorer(context: ProjectContext, visibility: VisibilityStore): InteriorExploreSession {
  return new InteriorExploreSession({
    elements: () => context.elementStore.getAll(),
    slabs: () => context.slabStore.getAll(),
    objects: () => buildAIProjectSnapshot(context).objects,
    visibility,
    selection: context.selectionStore
  });
}

function add(context: ProjectContext, command: Record<string, unknown>): string {
  const result = context.commandExecutor.execute(command);
  assertTrue(result.success && result.objectId, `setup: ${JSON.stringify(result)}`);
  return result.objectId!;
}

/** Is `point` inside the room's walkable area (WALL_CLEARANCE from its edges)? */
function walkable(room: InteriorRoom, point: { x: number; z: number }): boolean {
  const clamped = clampToRoom(point, room);
  return Math.abs(clamped.x - point.x) < 1e-6 && Math.abs(clamped.z - point.z) < 1e-6;
}

const hiddenList = (visibility: VisibilityStore) => [...visibility.getHidden()].sort().join(" ");

async function main(): Promise<void> {
  console.log("Interior Explore - rooms, viewpoints and walking");

  const house = await builtHouse();
  const houseRooms = interiorRooms(house.elementStore.getAll(), house.slabStore.getAll());

  await check("the rooms are the project's own: a generated house lists all six by name; another project lists its two", () => {
    assertEqual(houseRooms.map((room) => room.name).join(", "), "Living Room, Kitchen, Bedroom 1, Bedroom 2, Bedroom 3, Bathroom", "the generated house's rooms, in the model's order");
    const other = createProjectContext();
    add(other, { type: "element.add", element: { kind: "room", label: "Studio", position: { x: 10, z: 10 }, dimensions: { length: 6, width: 3, height: 3 } } });
    add(other, { type: "element.add", element: { kind: "room", label: "Store", position: { x: -8, z: 2 }, rotation: Math.PI / 2, dimensions: { length: 4, width: 2 } } });
    const rooms = interiorRooms(other.elementStore.getAll(), other.slabStore.getAll());
    assertEqual(rooms.map((room) => `${room.name} ${room.planX}x${room.planZ}`).join(", "), "Studio 6x3, Store 2x4", "names and plan sizes (a quarter-turned room lies north-south)");
    assertEqual(interiorRooms(createProjectContext().elementStore.getAll(), []).length, 0, "an empty project has none");
  });

  await check("each room's viewpoint is inside it, at eye height above its real floor, looking across it", () => {
    for (const room of houseRooms) {
      assertEqual(room.floorY, 0.2, `${room.name} stands on the house's 0.2 m slab, not the ground under it`);
      const view = roomViewpoint(room);
      assertEqual(view.position.y, 0.2 + EYE_HEIGHT, `${room.name}: the eye 1.6 m above that floor`);
      assertTrue(walkable(room, view.position), `${room.name}: standing inside the room, clear of its walls`);
      const look = lookDirection(view);
      const toCentre = { x: room.center.x - view.position.x, z: room.center.z - view.position.z };
      assertTrue(look.x * toCentre.x + look.z * toCentre.z > 0, `${room.name}: looking into the room, not at the wall behind`);
      assertTrue(look.y < 0 && look.y > -0.3, `${room.name}: tilted a little down - floor and furniture in view`);
    }
    // Rooms of other sizes, places and turns, standing on the ground.
    const other = createProjectContext();
    add(other, { type: "element.add", element: { kind: "room", label: "Hall", position: { x: 20, z: -5 }, dimensions: { length: 8, width: 2.5, height: 3 } } });
    add(other, { type: "element.add", element: { kind: "room", label: "Store", position: { x: -8, z: 2 }, rotation: Math.PI / 2, dimensions: { length: 4, width: 2 } } });
    add(other, { type: "element.add", element: { kind: "room", label: "Closet", position: { x: 3, z: 3 }, dimensions: { length: 0.6, width: 0.6 } } });
    for (const room of interiorRooms(other.elementStore.getAll(), [])) {
      const view = roomViewpoint(room);
      assertEqual(view.position.y, EYE_HEIGHT, `${room.name}: on the ground, the eye at 1.6 m`);
      assertTrue(walkable(room, view.position), `${room.name}: inside it`);
      assertTrue(Math.abs(view.position.x - room.center.x) <= room.planX / 2 && Math.abs(view.position.z - room.center.z) <= room.planZ / 2, `${room.name}: within its plan extent`);
    }
  });

  await check("walking and looking stay inside the room, at eye height, the tilt limited", () => {
    const kitchen = houseRooms.find((room) => room.name === "Kitchen")!;
    let view = roomViewpoint(kitchen);
    view = walk(view, 50, 0, kitchen);
    assertTrue(walkable(kitchen, view.position), "50 m forward stops at the far wall's clearance");
    view = walk(view, 0, -50, kitchen);
    assertTrue(walkable(kitchen, view.position), "and 50 m sideways at the side wall's");
    assertEqual(view.position.y, 0.2 + EYE_HEIGHT, "never rising off or sinking into the floor");
    const reach = kitchen.halfLength - WALL_CLEARANCE;
    assertTrue(Math.abs(view.position.x - kitchen.center.x) <= reach + 1e-6, "clear of the walls");
    assertEqual(turn(view, 0, 10).pitch, PITCH_LIMIT, "looking up is limited");
    assertEqual(turn(view, 0, -10).pitch, -PITCH_LIMIT, "and down");
    assertEqual(`${facing(Math.PI)} ${facing(0)} ${facing(Math.PI / 2)} ${facing((-3 * Math.PI) / 4)}`, "north south east north-west", "the compass names of a look");
  });

  console.log("Interior Explore - the session: visibility, selection, the model untouched");

  await check("entering hides only the roofs; a room's walls, openings and furniture are drawn; leaving restores every visibility and the selection exactly", async () => {
    const context = await builtHouse();
    const visibility = new VisibilityStore();
    const snapshot = buildAIProjectSnapshot(context).objects;
    const roof = snapshot.find((object) => object.kind === "roof")!;
    const kitchen = interiorRooms(context.elementStore.getAll(), context.slabStore.getAll()).find((room) => room.name === "Kitchen")!;
    const kitchenFurniture = snapshot.filter((object) => object.type === "asset" && walkable({ ...kitchen, halfLength: kitchen.halfLength + WALL_CLEARANCE, halfWidth: kitchen.halfWidth + WALL_CLEARANCE }, object.position));
    assertTrue(kitchenFurniture.length > 0, "the kitchen is furnished");
    const elsewhere = snapshot.find((object) => object.type === "wall" && !walkable({ ...kitchen, halfLength: kitchen.halfLength + 1, halfWidth: kitchen.halfWidth + 1 }, object.position))!;
    // The person had hidden a kitchen cabinet and a far wall, and selected a door.
    visibility.setHidden(kitchenFurniture[0].id, true);
    visibility.setHidden(elsewhere.id, true);
    const door = snapshot.find((object) => object.type === "door")!;
    context.selectionStore.select(door.id);
    const before = hiddenList(visibility);

    const session = explorer(context, visibility);
    const entered = session.enter();
    assertTrue(entered.ok && entered.rooms.length === 6, "entered, with six rooms");
    assertTrue(visibility.isHidden(roof.id), "the roof is hidden - from inside it is a lid");
    assertEqual(context.selectionStore.get(), null, "the selection is set aside - nothing picked or dragged by accident");
    assertTrue(snapshot.filter((object) => object.type === "wall").every((wall) => wall.id === elsewhere.id || !visibility.isHidden(wall.id)), "no wall is hidden by exploring");

    const inKitchen = session.goTo(kitchen.id)!;
    assertEqual(inKitchen.room.name, "Kitchen", "in the kitchen");
    assertTrue(kitchenFurniture.every((object) => !visibility.isHidden(object.id)), "all its furniture drawn - the one hidden earlier too");
    assertTrue(visibility.isHidden(elsewhere.id), "a wall hidden elsewhere stays as the person left it");
    assertTrue(visibility.isHidden(roof.id), "the roof still hidden");

    const bedroom = session.rooms().find((room) => room.name === "Bedroom 1")!;
    session.goTo(bedroom.id);
    assertTrue(visibility.isHidden(kitchenFurniture[0].id), "moving on, the kitchen cabinet is hidden again, as the person had it");

    session.exit();
    assertEqual(hiddenList(visibility), before, "every visibility exactly as before - the roof back");
    assertEqual(context.selectionStore.get(), door.id, "the door selected again");
    assertTrue(!session.isActive(), "and the session is over");
  });

  await check("exploring never changes the model, its saved document or its undo history", async () => {
    const context = await builtHouse();
    const visibility = new VisibilityStore();
    const document = JSON.stringify(serializeProject(context));
    const undo = context.history.canUndo();
    const redo = context.history.canRedo();
    const session = explorer(context, visibility);
    session.enter();
    for (const room of session.rooms()) {
      let view = session.goTo(room.id)!.viewpoint;
      view = turn(walk(view, 1.2, 0.4, room), 0.6, -0.3);
      assertTrue(walkable(room, view.position), `${room.name}: still inside`);
    }
    session.exit();
    assertEqual(JSON.stringify(serializeProject(context)), document, "the saved document is byte-for-byte the same");
    assertEqual(`${context.history.canUndo()} ${context.history.canRedo()}`, `${undo} ${redo}`, "no undo or redo entries added");
    const rooms = context.elementStore.getAll().filter((element) => element.kind === "room").length;
    context.history.undo();
    assertTrue(context.elementStore.getAll().filter((element) => element.kind === "room").length <= rooms, "undo still undoes the last build step");
  });

  await check("an empty project, or a room that isn't there: a clear message, and nothing changes", () => {
    const empty = createProjectContext();
    const visibility = new VisibilityStore();
    add(empty, { type: "wall.add", wall: {} });
    const wallId = empty.wallStore.getAll()[0].id;
    empty.selectionStore.select(wallId);
    const session = explorer(empty, visibility);
    assertEqual(session.goTo("room-1"), null, "no room before entering");
    const entered = session.enter();
    assertTrue(!entered.ok && /no rooms to explore/i.test(entered.message), `explains: ${entered.ok ? "" : entered.message}`);
    assertTrue(!session.isActive(), "not exploring");
    assertEqual(empty.selectionStore.get(), wallId, "the selection untouched");
    assertEqual(visibility.getHidden().size, 0, "nothing hidden");
    session.exit();
    assertEqual(empty.selectionStore.get(), wallId, "leaving when not exploring changes nothing either");

    const other = createProjectContext();
    add(other, { type: "element.add", element: { kind: "room", label: "Den", position: { x: 0, z: 0 }, dimensions: { length: 4, width: 4 } } });
    const roomSession = explorer(other, new VisibilityStore());
    roomSession.enter();
    assertEqual(roomSession.goTo("room-99"), null, "a room that isn't in the project: null");
    assertEqual(roomSession.currentRoomId(), null, "and no room is current");
  });

  await check("an eye button pressed while exploring stays as the person set it", async () => {
    const context = await builtHouse();
    const visibility = new VisibilityStore();
    const session = explorer(context, visibility);
    session.enter();
    const rooms = session.rooms();
    session.goTo(rooms[0].id);
    const far = buildAIProjectSnapshot(context).objects.find((object) => object.type === "asset" && !walkable({ ...rooms[0], halfLength: rooms[0].halfLength + 1, halfWidth: rooms[0].halfWidth + 1 }, object.position) && !walkable({ ...rooms[1], halfLength: rooms[1].halfLength + 1, halfWidth: rooms[1].halfWidth + 1 }, object.position))!;
    visibility.setHidden(far.id, true);
    session.goTo(rooms[1].id);
    assertTrue(visibility.isHidden(far.id), "still hidden after moving rooms");
    session.exit();
    assertTrue(visibility.isHidden(far.id), "and after leaving - the person's choice, not the explorer's");
  });

  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) {
    throw new Error(`${failed} interior check(s) failed`);
  }
}

await main();
