/**
 * Verification for construction relationships: doors and windows hosted
 * in walls, snapping, pipe/conduit/cable endpoints and connections, the
 * alignment helpers, relationship-aware manipulation, undo/redo, the
 * geometry analysis of relationships, persistence, and the AI command
 * path. Same approach as every other verify.ts in this project: no test
 * framework, plain assertion helpers, run directly by Node against the
 * real engine (the real ProjectContext, CommandExecutor, stores, shared
 * HistoryManager, ObjectManipulator, and mock AI). Run with:
 *   npm run verify
 * or directly:
 *   node --experimental-transform-types src/engine/relationships/verify.ts
 */
import { createProjectContext } from "../project/ProjectContext.ts";
import { loadProject, serializeProject } from "../project/projectPersistence.ts";
import { parseProjectDocument } from "../project/projectDocument.ts";
import { WINDOW_SILL_HEIGHT, hostedTransform } from "../openings/hostOpening.ts";
import { CONNECTION_TOLERANCE, endpointsOf } from "../connections/connections.ts";
import { snapMove } from "../snapping/snapping.ts";
import { SnapSettings } from "../snapping/SnapSettings.ts";
import { createStoreSnapper } from "../snapping/storeSnapper.ts";
import { ObjectManipulator, createStoreObjectReader } from "../manipulation/ObjectManipulator.ts";
import { layoutHandles } from "../manipulation/manipulationMath.ts";
import { createDoorData } from "../door/createDoor.ts";
import { validateDoor } from "../door/validateDoor.ts";
import { analyzeConstructionGeometry } from "../ai/geometry/analyzeConstructionGeometry.ts";
import { AI_SUPPORTED_OBJECT_TYPES, buildAIProjectSnapshot } from "../ai/types.ts";
import { buildAIProjectContext, parseAIProjectContext } from "../ai/aiProjectContext.ts";
import { MockAIProvider } from "../ai/MockAIProvider.ts";
import { AICommandPipeline } from "../ai/AICommandPipeline.ts";
import type { SnapObject } from "../snapping/snapping.ts";

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

function assertClose(actual: number, expected: number, message: string, tolerance = 1e-6): void {
  if (!(Math.abs(actual - expected) <= tolerance)) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

function assertSameJson(actual: unknown, expected: unknown, message: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`${message}:\n  expected ${e}\n  got      ${a}`);
  }
}

type Project = ReturnType<typeof createProjectContext>;

function storesOf(project: Project) {
  return {
    wallStore: project.wallStore,
    pillarStore: project.pillarStore,
    beamStore: project.beamStore,
    slabStore: project.slabStore,
    doorStore: project.doorStore,
    windowStore: project.windowStore,
    elementStore: project.elementStore
  };
}

function create(project: Project, command: unknown): string {
  const result = project.commandExecutor.execute(command);
  assertTrue(result.success && result.objectId, `${JSON.stringify(command)} -> ${JSON.stringify(result)}`);
  return result.objectId;
}

function succeed(project: Project, command: unknown): void {
  const result = project.commandExecutor.execute(command);
  assertTrue(result.success, `${JSON.stringify(command)} -> ${JSON.stringify(result)}`);
}

/** Runs a command that must be refused - with `fragment` in its message, when given - and change nothing. */
function refuse(project: Project, command: unknown, fragment?: string): void {
  const before = JSON.stringify(serializeProject(project));
  const result = project.commandExecutor.execute(command);
  assertTrue(!result.success, `expected refusal: ${JSON.stringify(command)} -> ${JSON.stringify(result)}`);
  if (fragment) {
    assertTrue(JSON.stringify(result).includes(fragment), `refusal of ${JSON.stringify(command)} should mention "${fragment}": ${JSON.stringify(result)}`);
  }
  assertEqual(JSON.stringify(serializeProject(project)), before, `a refused ${JSON.stringify((command as { type: string }).type)} changes nothing`);
}

/** A 4 m long, 3 m high, 0.2 m thick wall on the ground at (x, z). */
function wall(project: Project, x = 0, z = 0, rotation = 0): string {
  return create(project, { type: "wall.add", wall: { length: 4, height: 3, thickness: 0.2, rotation, position: { x, z } } });
}

function pipe(project: Project, kind: string, x: number, z = 0, extra: Record<string, unknown> = {}): string {
  return create(project, { type: "element.add", element: { kind, position: { x, z }, ...extra } });
}

function manipulatorFor(project: Project, snapper?: ReturnType<typeof createStoreSnapper>): ObjectManipulator {
  return new ObjectManipulator({
    commandExecutor: project.commandExecutor,
    history: project.history,
    readObject: createStoreObjectReader(storesOf(project)),
    ...(snapper ? { snapper } : {})
  });
}

function doorAt(project: Project, id: string) {
  const door = project.doorStore.get(id);
  assertTrue(door, `${id} exists`);
  return door;
}

async function run(): Promise<void> {
  let passed = 0;
  let failed = 0;

  async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
    try {
      await fn();
      passed += 1;
      console.log(`  ok - ${name}`);
    } catch (error) {
      failed += 1;
      console.error(`  FAIL - ${name}`);
      console.error(error);
    }
  }

  console.log("Construction relationships verification\n");

  // --- 1-2. Hosted doors and windows ---

  await check("1. a door added with a hostId goes into the wall: its placement is stored, and its position and rotation come from the wall", () => {
    const project = createProjectContext();
    const wallId = wall(project, 1, 2);
    const doorId = create(project, { type: "door.add", door: { hostId: wallId } });
    const door = doorAt(project, doorId);
    const host = project.wallStore.get(wallId);
    assertTrue(host, "wall");
    assertEqual(door.hostId, wallId, "hostId");
    assertSameJson(door.hostPlacement, { offset: 0, sill: 0 }, "the wall's center, on its base");
    assertSameJson(door.position, { x: 1, y: 1.05, z: 2 }, "centered in the wall, standing on its base");
    assertEqual(door.rotation, host.rotation, "turned with the wall");

    const second = doorAt(project, create(project, { type: "door.add", door: { hostId: wallId } }));
    assertClose(second.hostPlacement?.offset ?? NaN, 0.9, "the next door takes the first free spot - never overlapping the first");
    const third = doorAt(project, create(project, { type: "door.add", door: { hostId: wallId, offset: -1.2 } }));
    assertClose(third.hostPlacement?.offset ?? NaN, -1.2, "an explicit offset is used as given");
  });

  await check("2. a window added with a hostId goes into the wall at sill height (0.9 m by default, or as given)", () => {
    const project = createProjectContext();
    const wallId = wall(project);
    const windowData = project.windowStore.get(create(project, { type: "window.add", window: { hostId: wallId } }));
    assertTrue(windowData, "window");
    assertSameJson(windowData.hostPlacement, { offset: 0, sill: WINDOW_SILL_HEIGHT }, "default sill");
    assertClose(windowData.position.y, WINDOW_SILL_HEIGHT + 0.6, "its center 0.9 + 1.2 / 2 above the wall's base");
    const high = project.windowStore.get(create(project, { type: "window.add", window: { hostId: wallId, offset: 1.4, sill: 1.5 } }));
    assertSameJson(high?.hostPlacement, { offset: 1.4, sill: 1.5 }, "an explicit offset and sill");
  });

  // --- 3. Host validation ---

  await check("3. host validation: the host must be an existing wall, the opening must fit it, and openings in one wall can't overlap", () => {
    const project = createProjectContext();
    const wallId = wall(project);
    const pillarId = create(project, { type: "pillar.add", pillar: { position: { x: 6 } } });
    refuse(project, { type: "door.add", door: { hostId: "wall-999999" } }, "no wall has the id");
    refuse(project, { type: "door.add", door: { hostId: pillarId } }, "is a pillar, not a wall");
    const shortWall = create(project, { type: "wall.add", wall: { length: 0.5, height: 3, thickness: 0.2, position: { x: 10, z: 0 } } });
    refuse(project, { type: "door.add", door: { hostId: shortWall } }, "wider than");
    const doorId = create(project, { type: "door.add", door: { hostId: wallId } });
    refuse(project, { type: "window.add", window: { hostId: wallId, offset: 0.3, sill: 0.5 } }, "overlaps");
    refuse(project, { type: "window.add", window: { hostId: wallId, offset: 1.4, sill: 2.5 } }, "taller than");
    refuse(project, { type: "door.update", id: doorId, changes: { hostPlacement: { offset: 5, sill: 0 } } }, "runs past the end");
    refuse(project, { type: "update_object", objectId: doorId, changes: { hostId: pillarId } }, "not a wall");
    refuse(project, { type: "update_object", objectId: pillarId, changes: { hostId: wallId } }, "only editable on doors and windows");
    assertTrue(!validateDoor({ ...createDoorData(), hostPlacement: { offset: 0, sill: 0 } }).valid, "a placement without a host is invalid");
    assertTrue(!validateDoor({ ...createDoorData(), hostId: "wall-1", hostPlacement: null }).valid, "a host without a placement is invalid");

    // A saved project can't bring back a broken host either.
    const saved = JSON.parse(JSON.stringify(serializeProject(project)));
    const tamper = (change: (doc: { objects: Record<string, unknown>[] }) => void) => {
      const copy = JSON.parse(JSON.stringify(saved));
      change(copy);
      return parseProjectDocument(copy);
    };
    const doorRecord = (doc: { objects: Record<string, unknown>[] }) => doc.objects.find((object) => object.id === doorId) as Record<string, unknown>;
    const toPillar = tamper((doc) => (doorRecord(doc).hostId = pillarId));
    assertTrue(!toPillar.ok && toPillar.error.includes("is not a wall"), `document: host is a pillar (${JSON.stringify(toPillar)})`);
    const offWall = tamper((doc) => (doorRecord(doc).hostPlacement = { offset: 99, sill: 0 }));
    assertTrue(!offWall.ok && offWall.error.includes("runs past the end"), `document: off the wall (${JSON.stringify(offWall)})`);
    const noHost = tamper((doc) => (doorRecord(doc).hostId = null));
    assertTrue(!noHost.ok && noHost.error.includes("no hostPlacement"), `document: placement without a host (${JSON.stringify(noHost)})`);
    const twin = tamper((doc) => doc.objects.push({ ...doorRecord(doc), id: "door-999" }));
    assertTrue(!twin.ok && twin.error.includes("overlaps"), `document: two doors in the same spot (${JSON.stringify(twin)})`);
  });

  // --- 4-7. The opening follows, and is constrained by, its wall ---

  await check("4. moving a wall moves the openings in it - their placement in the wall unchanged", () => {
    const project = createProjectContext();
    const wallId = wall(project);
    const doorId = create(project, { type: "door.add", door: { hostId: wallId, offset: 1 } });
    const windowId = create(project, { type: "window.add", window: { hostId: wallId, offset: -1 } });
    succeed(project, { type: "update_object", objectId: wallId, changes: { position: { x: 2, z: -3 } } });
    const door = doorAt(project, doorId);
    assertSameJson(door.position, { x: 3, y: 1.05, z: -3 }, "the door moved with the wall");
    assertSameJson(door.hostPlacement, { offset: 1, sill: 0 }, "same place in the wall");
    assertSameJson(project.windowStore.get(windowId)?.position, { x: 1, y: 1.5, z: -3 }, "and so did the window");
  });

  await check("5. turning a wall turns the openings in it, around the wall's center", () => {
    const project = createProjectContext();
    const wallId = wall(project);
    const doorId = create(project, { type: "door.add", door: { hostId: wallId, offset: 1 } });
    succeed(project, { type: "update_object", objectId: wallId, changes: { rotation: Math.PI / 2 } });
    const door = doorAt(project, doorId);
    const host = project.wallStore.get(wallId);
    assertTrue(host, "wall");
    assertClose(door.rotation, Math.PI / 2, "turned with the wall");
    assertClose(door.position.x, 0, "1 m along a wall turned 90 degrees...");
    assertClose(door.position.z, -1, "...is 1 m toward -Z");
    assertSameJson(door.position, hostedTransform(host, door.dimensions, { offset: 1, sill: 0 }).position, "exactly the hosted transform");
  });

  await check("6. an opening stays constrained to its wall: a move slides it along, a turn is refused, a shorter wall pulls it back, and a wall too small for it is refused", () => {
    const project = createProjectContext();
    const wallId = wall(project);
    const doorId = create(project, { type: "door.add", door: { hostId: wallId } });

    succeed(project, { type: "update_object", objectId: doorId, changes: { position: { x: 100, z: 7 } } });
    let door = doorAt(project, doorId);
    assertEqual(door.hostId, wallId, "still in the wall");
    assertClose(door.hostPlacement?.offset ?? NaN, 1.55, "slid to the wall's end - never off it");
    assertClose(door.position.z, 0, "and never off its plane");
    refuse(project, { type: "update_object", objectId: doorId, changes: { rotation: 1 } }, "turns with it");

    // A body drag in the viewport is the same command.
    const manipulator = manipulatorFor(project);
    const start = doorAt(project, doorId).position;
    assertTrue(manipulator.begin(doorId, { kind: "move" }, { ...start }), "a move gesture starts");
    manipulator.update({ x: start.x - 1, y: start.y, z: start.z + 3 });
    manipulator.end();
    door = doorAt(project, doorId);
    assertClose(door.hostPlacement?.offset ?? NaN, 0.55, "dragged 1 m along the wall (the sideways part ignored)");
    assertClose(door.position.z, 0, "still in the wall's plane");
    assertEqual(layoutHandles({ type: "door", hostId: wallId, dimensions: { ...door.dimensions } })?.rotate, null, "no rotation ring for a hosted door");

    succeed(project, { type: "update_object", objectId: wallId, changes: { dimensions: { length: 2 } } });
    assertClose(doorAt(project, doorId).hostPlacement?.offset ?? NaN, 0.55, "0.55 still fits a 2 m wall");
    succeed(project, { type: "update_object", objectId: wallId, changes: { dimensions: { length: 1.2 } } });
    assertClose(doorAt(project, doorId).hostPlacement?.offset ?? NaN, 0.15, "a shorter wall pulls the door back onto it");
    refuse(project, { type: "update_object", objectId: wallId, changes: { dimensions: { length: 0.5 } } }, "wider than");
    refuse(project, { type: "update_object", objectId: wallId, changes: { dimensions: { height: 2 } } }, "taller than");
  });

  await check("7. deleting a wall deletes the openings in it (one undo restores all of it); deleting an opening leaves the wall", () => {
    const project = createProjectContext();
    const wallId = wall(project);
    const doorId = create(project, { type: "door.add", door: { hostId: wallId } });
    const windowId = create(project, { type: "window.add", window: { hostId: wallId, offset: 1.4 } });
    succeed(project, { type: "wall.delete", id: wallId });
    assertEqual(project.doorStore.get(doorId), undefined, "the door went with the wall");
    assertEqual(project.windowStore.get(windowId), undefined, "and the window");
    project.history.undo();
    assertTrue(project.wallStore.get(wallId), "undo restores the wall");
    assertSameJson(doorAt(project, doorId).hostPlacement, { offset: 0, sill: 0 }, "the door, in its place");
    assertEqual(project.windowStore.get(windowId)?.hostId, wallId, "the window, still hosted");
    project.history.redo();
    assertEqual(project.doorStore.get(doorId), undefined, "redo deletes them again");
    project.history.undo();
    succeed(project, { type: "door.delete", id: doorId });
    assertTrue(project.wallStore.get(wallId), "deleting the door leaves the wall");
  });

  // --- 8-9. Endpoints and snapping ---

  await check("8. an endpoint drag moves that end of a pipe and keeps the other - length and angle follow - as one undo step", () => {
    const project = createProjectContext();
    const pipeId = pipe(project, "water-pipe", 0);
    const before = project.elementStore.get(pipeId);
    assertTrue(before, "pipe");
    const ends = endpointsOf(before);
    const layout = layoutHandles({ type: "element", kind: "water-pipe", dimensions: before.dimensions });
    assertSameJson(layout?.endpoints.map((handle) => handle.endpoint), ["start", "end"], "two endpoint handles");
    assertTrue(layout?.resize.every((handle) => handle.axis !== "x"), "which replace the lengthwise resize handles");

    const manipulator = manipulatorFor(project);
    assertTrue(manipulator.begin(pipeId, { kind: "endpoint", endpoint: "end" }, { ...ends.end }), "an endpoint gesture starts");
    manipulator.update({ x: ends.end.x, y: ends.end.y, z: ends.end.z + 2 });
    manipulator.end();
    const after = project.elementStore.get(pipeId);
    assertTrue(after, "pipe after");
    const moved = endpointsOf(after);
    assertClose(moved.start.x, ends.start.x, "the start stays put (x)");
    assertClose(moved.start.z, ends.start.z, "the start stays put (z)");
    assertClose(moved.end.z, ends.end.z + 2, "the end followed the pointer");
    assertClose(after.dimensions.length, Math.hypot(3, 2), "the length is the new run");
    project.history.undo();
    assertClose(project.elementStore.get(pipeId)?.dimensions.length ?? NaN, 3, "one undo restores the pipe");
    assertTrue(!manipulatorFor(project).begin("wall-nope", { kind: "endpoint", endpoint: "end" }, { x: 0, y: 0, z: 0 }), "no endpoint gesture on a missing object");
  });

  await check("9. snapping: a dragged pipe end snaps onto a compatible end within 0.3 m and connects on release; with snapping off it doesn't", () => {
    const project = createProjectContext();
    const a = pipe(project, "water-pipe", 0); // ends at x -1.5 and 1.5
    const b = pipe(project, "water-pipe", 4.7); // start at x 3.2
    const settings = new SnapSettings();
    const manipulator = manipulatorFor(project, createStoreSnapper(storesOf(project), settings));
    const aEnd = endpointsOf(project.elementStore.get(a) as NonNullable<ReturnType<typeof project.elementStore.get>>).end;

    manipulator.begin(a, { kind: "endpoint", endpoint: "end" }, { ...aEnd });
    manipulator.update({ x: aEnd.x + 1.5, y: aEnd.y, z: aEnd.z + 0.1 }); // 0.22 m from b's start
    manipulator.end();
    const snapped = endpointsOf(project.elementStore.get(a) as NonNullable<ReturnType<typeof project.elementStore.get>>).end;
    assertClose(snapped.x, 3.2, "snapped exactly onto b's start (x)");
    assertClose(snapped.z, 0, "snapped exactly onto b's start (z)");
    assertSameJson(project.elementStore.get(a)?.connections, [{ endpoint: "end", objectId: b, objectEndpoint: "start" }], "and connected");
    assertSameJson(project.elementStore.get(b)?.connections, [{ endpoint: "start", objectId: a, objectEndpoint: "end" }], "on both sides");
    project.history.undo();
    assertSameJson(project.elementStore.get(a)?.connections, [], "one undo takes back the drag and the connection");
    assertClose(project.elementStore.get(a)?.dimensions.length ?? NaN, 3, "and the length");

    settings.setEnabled(false);
    manipulator.begin(a, { kind: "endpoint", endpoint: "end" }, { ...aEnd });
    manipulator.update({ x: aEnd.x + 1.5, y: aEnd.y, z: aEnd.z + 0.1 });
    manipulator.end();
    const free = endpointsOf(project.elementStore.get(a) as NonNullable<ReturnType<typeof project.elementStore.get>>).end;
    assertClose(free.x, 3, "snapping off: the end goes where the pointer is");
    assertSameJson(project.elementStore.get(a)?.connections, [], "and nothing connects");
  });

  await check("snapping rules: a wall's end onto another wall's end, a pillar's center onto a wall's corner, alignment, then the grid - deterministic", () => {
    const wallA: SnapObject = { id: "wall-1", type: "wall", position: { x: 0, y: 1.5, z: 0 }, rotation: 0, dimensions: { length: 4, height: 3, thickness: 0.2 } };
    const wallB: SnapObject = { id: "wall-2", type: "wall", position: { x: 9, y: 1.5, z: 9 }, rotation: 0, dimensions: { length: 3, height: 3, thickness: 0.2 } };
    const joined = snapMove(wallB, { x: 3.6, y: 1.5, z: 0.05 }, [wallA]);
    assertEqual(joined.mode, "point", "point snap");
    assertEqual(joined.target?.kind, "endpoint", "onto an endpoint (it beats the equally near corners)");
    assertSameJson(joined.position, { x: 3.5, y: 1.5, z: 0 }, "the walls now meet end to end, in line");

    const pillar: SnapObject = { id: "pillar-1", type: "pillar", position: { x: 9, y: 1.35, z: 9 }, rotation: 0, dimensions: { width: 0.4, depth: 0.4, height: 2.7 } };
    const cornered = snapMove(pillar, { x: 2.05, y: 1.35, z: 0.15 }, [wallA]);
    assertSameJson(cornered.position, { x: 2, y: 1.35, z: 0.1 }, "the pillar's center onto the wall's corner");

    const aligned = snapMove(pillar, { x: 0.05, y: 1.35, z: 5.04 }, [wallA]);
    assertEqual(aligned.mode, "align", "no point nearby - alignment");
    assertClose(aligned.position.x, 0, "its center lined up with the wall's center");
    const edgeAligned = snapMove(pillar, { x: 0.12, y: 1.35, z: 5.04 }, [wallA]);
    assertClose(edgeAligned.position.x, 0.2, "or its edge, when that's nearer (edges align too)");
    assertClose(aligned.position.z, 5, "the other axis goes to the grid");

    const gridded = snapMove(pillar, { x: 7.04, y: 1.35, z: 7.06 }, [wallA]);
    assertEqual(gridded.mode, "grid", "nothing near - the grid");
    assertSameJson(gridded.position, { x: 7, y: 1.35, z: 7.1 }, "onto the 0.1 m grid");
    assertSameJson(snapMove(pillar, { x: 2.05, y: 1.35, z: 0.15 }, [wallA]), cornered, "the same drag always snaps the same way");
  });

  // --- 10-15. Connections ---

  await check("10. compatible pipes connect: the nearest ends, snapped together and recorded on both", () => {
    const project = createProjectContext();
    const a = pipe(project, "water-pipe", 0);
    const b = pipe(project, "water-pipe", 3.2); // start 0.2 m from a's end
    succeed(project, { type: "element.connect", from: { id: a }, to: { id: b } });
    const aNow = project.elementStore.get(a);
    const bNow = project.elementStore.get(b);
    assertTrue(aNow && bNow, "both");
    assertSameJson(aNow.connections, [{ endpoint: "end", objectId: b, objectEndpoint: "start" }], "a's end to b's start");
    assertSameJson(bNow.connections, [{ endpoint: "start", objectId: a, objectEndpoint: "end" }], "mirrored on b");
    assertClose(endpointsOf(aNow).end.x, endpointsOf(bNow).start.x, "the ends now coincide");
    assertClose(aNow.dimensions.length, 3.2, "a grew to meet b");
    const drainA = pipe(project, "drain-pipe", 0, 5);
    const drainB = pipe(project, "drain-pipe", -3.1, 5);
    succeed(project, { type: "element.connect", from: { id: drainB, endpoint: "end" }, to: { id: drainA, endpoint: "start" } });
    assertEqual(project.elementStore.get(drainA)?.connections[0]?.objectId, drainB, "drain to drain");
  });

  await check("11. incompatible or impossible connections are refused: water to drain, pipe to cable, a sofa, too far apart, a bad endpoint name", () => {
    const project = createProjectContext();
    const water = pipe(project, "water-pipe", 0);
    const drain = pipe(project, "drain-pipe", 3.1);
    const cable = pipe(project, "cable", 3.1, 0.1);
    const sofa = create(project, { type: "element.add", element: { kind: "sofa", position: { x: 1.6, z: 0 } } });
    const far = pipe(project, "water-pipe", 10);
    refuse(project, { type: "element.connect", from: { id: water }, to: { id: drain } }, "can't connect to a drain pipe");
    refuse(project, { type: "element.connect", from: { id: water }, to: { id: cable } }, "can't connect");
    refuse(project, { type: "element.connect", from: { id: water }, to: { id: sofa } }, "has no endpoints");
    refuse(project, { type: "element.connect", from: { id: water }, to: { id: far } }, `within ${CONNECTION_TOLERANCE} m`);
    refuse(project, { type: "element.connect", from: { id: water, endpoint: "middle" }, to: { id: far } }, "is not an endpoint");
    refuse(project, { type: "element.connect", from: { id: water }, to: { id: "water-pipe-999999" } }, "No element found");
  });

  await check("12. conduits connect to conduits", () => {
    const project = createProjectContext();
    const a = pipe(project, "conduit", 0);
    const b = pipe(project, "conduit", 3.05);
    succeed(project, { type: "element.connect", from: { id: a }, to: { id: b } });
    assertEqual(project.elementStore.get(b)?.connections[0]?.objectId, a, "connected");
  });

  await check("13. cables connect to cables", () => {
    const project = createProjectContext();
    const a = pipe(project, "cable", 0);
    const b = pipe(project, "cable", -3.1);
    succeed(project, { type: "element.connect", from: { id: a, endpoint: "start" }, to: { id: b, endpoint: "end" } });
    assertSameJson(project.elementStore.get(a)?.connections, [{ endpoint: "start", objectId: b, objectEndpoint: "end" }], "connected");
  });

  await check("14. a duplicate connection, and a connection to itself, are refused; element.update can't touch connections", () => {
    const project = createProjectContext();
    const a = pipe(project, "water-pipe", 0);
    const b = pipe(project, "water-pipe", 3);
    succeed(project, { type: "element.connect", from: { id: a }, to: { id: b } });
    refuse(project, { type: "element.connect", from: { id: a }, to: { id: b } }, "already connected");
    refuse(project, { type: "element.connect", from: { id: a }, to: { id: a } }, "can't connect to itself");
    refuse(project, { type: "element.update", id: a, changes: { connections: [] } }, "element.connect");
    refuse(project, { type: "update_object", objectId: a, changes: { connections: [] } }, "not an editable property");
  });

  await check("15. deleting a connected element removes its connections from the others; undo restores both sides", () => {
    const project = createProjectContext();
    const a = pipe(project, "water-pipe", 0);
    const b = pipe(project, "water-pipe", 3);
    const c = pipe(project, "water-pipe", -3);
    succeed(project, { type: "element.connect", from: { id: a, endpoint: "end" }, to: { id: b, endpoint: "start" } });
    succeed(project, { type: "element.connect", from: { id: a, endpoint: "start" }, to: { id: c, endpoint: "end" } });
    succeed(project, { type: "element.delete", id: a });
    assertSameJson(project.elementStore.get(b)?.connections, [], "b no longer points at a");
    assertSameJson(project.elementStore.get(c)?.connections, [], "nor does c");
    assertTrue(parseProjectDocument(JSON.parse(JSON.stringify(serializeProject(project)))).ok, "the model stays valid");
    project.history.undo();
    assertEqual(project.elementStore.get(a)?.connections.length, 2, "undo brings a back, connected at both ends");
    assertEqual(project.elementStore.get(b)?.connections[0]?.objectId, a, "and b's side");
  });

  // --- 16-17. Undo/redo ---

  await check("16. undo/redo of hosting: wall + door, move the wall, undo (the door returns with it), redo (it follows again)", () => {
    const project = createProjectContext();
    const wallId = wall(project);
    const doorId = create(project, { type: "door.add", door: { hostId: wallId, offset: 0.5 } });
    const before = doorAt(project, doorId).position;
    succeed(project, { type: "update_object", objectId: wallId, changes: { position: { x: 3 } } });
    assertClose(doorAt(project, doorId).position.x, 3.5, "the door moved with the wall");
    project.history.undo();
    assertSameJson(doorAt(project, doorId).position, before, "one undo: the door is back with the wall");
    assertClose(project.wallStore.get(wallId)?.position.x ?? NaN, 0, "and so is the wall");
    project.history.redo();
    assertClose(doorAt(project, doorId).position.x, 3.5, "redo: it follows the wall again");
    project.history.undo();
    project.history.undo();
    assertEqual(project.doorStore.get(doorId), undefined, "undoing the add removes the door");
    project.history.redo();
    assertEqual(doorAt(project, doorId).hostId, wallId, "and redo puts it back in the wall");
  });

  await check("17. undo/redo of connections: connect, undo (gone from both), redo (back on both)", () => {
    const project = createProjectContext();
    const a = pipe(project, "water-pipe", 0);
    const b = pipe(project, "water-pipe", 3.2);
    succeed(project, { type: "element.connect", from: { id: a }, to: { id: b } });
    project.history.undo();
    assertSameJson([project.elementStore.get(a)?.connections, project.elementStore.get(b)?.connections], [[], []], "undo: disconnected");
    assertClose(project.elementStore.get(a)?.dimensions.length ?? NaN, 3, "and the snap undone");
    project.history.redo();
    assertEqual(project.elementStore.get(a)?.connections.length, 1, "redo: connected again");
    assertEqual(project.elementStore.get(b)?.connections.length, 1, "on both");
    succeed(project, { type: "element.disconnect", from: { id: a }, to: { id: b } });
    assertSameJson(project.elementStore.get(b)?.connections, [], "disconnect removes both sides");
    project.history.undo();
    assertEqual(project.elementStore.get(b)?.connections.length, 1, "and undoes as one step");
  });

  await check("a joint moves as one: moving a connected segment drags the joined ends, a new height moves the whole run, and a change that would break a neighbor is refused", () => {
    const project = createProjectContext();
    const a = pipe(project, "water-pipe", 0);
    const b = pipe(project, "water-pipe", 3);
    const c = pipe(project, "water-pipe", 6);
    succeed(project, { type: "element.connect", from: { id: a }, to: { id: b } });
    succeed(project, { type: "element.connect", from: { id: b, endpoint: "end" }, to: { id: c, endpoint: "start" } });

    succeed(project, { type: "update_object", objectId: b, changes: { position: { z: 1 } } });
    const ends = (id: string) => endpointsOf(project.elementStore.get(id) as NonNullable<ReturnType<typeof project.elementStore.get>>);
    assertClose(ends(a).end.z, 1, "a's end followed b's start");
    assertClose(ends(a).start.z, 0, "a's far end stayed");
    assertClose(ends(c).start.z, 1, "c's start followed b's end");
    assertTrue(parseProjectDocument(JSON.parse(JSON.stringify(serializeProject(project)))).ok, "every joint still meets");

    succeed(project, { type: "update_object", objectId: b, changes: { position: { y: 2 } } });
    assertSameJson([a, b, c].map((id) => project.elementStore.get(id)?.position.y), [2, 2, 2], "a new height moves the whole connected run");
    const axis = project.elementStore.get(a)?.position.y;
    succeed(project, { type: "update_object", objectId: a, changes: { dimensions: { diameter: 0.05 } } });
    assertEqual(project.elementStore.get(a)?.position.y, axis, "a thicker pipe keeps its axis - and its joints");

    const aStart = ends(a).start;
    refuse(project, { type: "update_object", objectId: b, changes: { position: { x: aStart.x + 1.5, z: aStart.z } } }, "is joined to it");
    project.history.undo();
    project.history.undo();
    project.history.undo();
    assertClose(ends(a).end.z, 0, "three undos: back where it started");
  });

  // --- Alignment helpers ---

  await check("alignment helpers: align X, align Z, align centers, snap to an endpoint (connecting two pipes), snap a door to a wall", () => {
    const project = createProjectContext();
    const wallId = wall(project, 2, 3);
    const pillarId = create(project, { type: "pillar.add", pillar: { position: { x: 7, z: 9 } } });
    succeed(project, { type: "object.align", id: pillarId, targetId: wallId, axis: "x" });
    assertSameJson([project.pillarStore.get(pillarId)?.position.x, project.pillarStore.get(pillarId)?.position.z], [2, 9], "align X");
    succeed(project, { type: "object.align", id: pillarId, targetId: wallId, axis: "z" });
    assertEqual(project.pillarStore.get(pillarId)?.position.z, 3, "align Z");
    succeed(project, { type: "update_object", objectId: pillarId, changes: { position: { x: 9, z: 9 } } });
    succeed(project, { type: "object.align", id: pillarId, targetId: wallId, axis: "both" });
    assertSameJson([project.pillarStore.get(pillarId)?.position.x, project.pillarStore.get(pillarId)?.position.z], [2, 3], "align centers");
    refuse(project, { type: "object.align", id: pillarId, targetId: wallId, axis: "y" }, "axis");

    const a = pipe(project, "water-pipe", 0, -6);
    const b = pipe(project, "water-pipe", 8, -9);
    succeed(project, { type: "object.snap", id: b, targetId: a, mode: "endpoint" });
    const aEnds = endpointsOf(project.elementStore.get(a) as NonNullable<ReturnType<typeof project.elementStore.get>>);
    const bEnds = endpointsOf(project.elementStore.get(b) as NonNullable<ReturnType<typeof project.elementStore.get>>);
    assertClose(bEnds.start.x, aEnds.end.x, "b's nearest end moved onto a's (x)");
    assertClose(bEnds.start.z, aEnds.end.z, "b's nearest end moved onto a's (z)");
    assertEqual(project.elementStore.get(b)?.connections.length, 1, "and they're connected");
    project.history.undo();
    assertSameJson(project.elementStore.get(b)?.connections, [], "one undo: the snap and the connection");

    const doorId = create(project, { type: "door.add", door: { position: { x: 2.5, z: 4 } } });
    succeed(project, { type: "object.snap", id: doorId, targetId: wallId, mode: "wall" });
    assertEqual(doorAt(project, doorId).hostId, wallId, "snap to wall puts the door in it");
    assertClose(doorAt(project, doorId).hostPlacement?.offset ?? NaN, 0.5, "where it stood along the wall");
    refuse(project, { type: "object.snap", id: pillarId, targetId: wallId, mode: "wall" }, "Only doors and windows");
  });

  // --- 18. Geometry analysis ---

  await check("18. the geometry analysis reports every host and connection, and flags broken ones", () => {
    const project = createProjectContext();
    const wallId = wall(project);
    const pillarId = create(project, { type: "pillar.add", pillar: { position: { x: 6 } } });
    const doorId = create(project, { type: "door.add", door: { hostId: wallId, offset: -1 } });
    const windowId = create(project, { type: "window.add", window: { hostId: wallId, offset: 1 } });
    const a = pipe(project, "water-pipe", 0, 5);
    const b = pipe(project, "water-pipe", 3, 5);
    succeed(project, { type: "element.connect", from: { id: a }, to: { id: b } });

    const snapshot = buildAIProjectSnapshot(project);
    const analysis = analyzeConstructionGeometry(snapshot);
    assertSameJson(
      analysis.hosts,
      [
        { opening: doorId, wall: wallId, offset: -1, sill: 0, valid: true, problems: [] },
        { opening: windowId, wall: wallId, offset: 1, sill: 0.9, valid: true, problems: [] }
      ],
      "both openings, valid"
    );
    assertSameJson(
      analysis.connections,
      [{ a, aEndpoint: "end", b, bEndpoint: "start", gap: 0, valid: true, problems: [] }],
      "one connection, reported once"
    );

    const tampered = JSON.parse(JSON.stringify(snapshot));
    const find = (id: string) => tampered.objects.find((object: { id: string }) => object.id === id);
    find(doorId).position.z += 0.5;
    find(windowId).hostId = pillarId;
    find(b).position.x += 1;
    find(a).connections = [];
    const broken = analyzeConstructionGeometry(tampered);
    assertTrue(broken.hosts[0].problems.some((problem) => problem.includes("isn't centered")), "a door off its wall is flagged");
    assertTrue(!broken.hosts[1].valid && broken.hosts[1].problems[0].includes("is a pillar"), "a host that isn't a wall is flagged");
    assertEqual(broken.connections.length, 1, "the one-sided connection is still reported");
    assertTrue(
      broken.connections[0].problems.some((problem) => problem.includes("doesn't record")) &&
        broken.connections[0].problems.some((problem) => problem.includes("apart")),
      `and flagged: ${JSON.stringify(broken.connections)}`
    );
  });

  // --- 19. AI ---

  await check("19. the AI path: hosted-opening and connect commands, from the mock provider through the pipeline, as structured data; the backend keeps relationships", async () => {
    const project = createProjectContext();
    const wallId = wall(project);
    const pillarId = create(project, { type: "pillar.add", pillar: { position: { x: 6 } } });
    const a = pipe(project, "water-pipe", 0, 5);
    const b = pipe(project, "water-pipe", 3.1, 5);
    const mock = new MockAIProvider();
    const context = () => buildAIProjectContext(buildAIProjectSnapshot(project));

    assertSameJson(
      mock.interpret({ instruction: `Add a door to ${wallId}`, projectContext: context(), availableObjectTypes: AI_SUPPORTED_OBJECT_TYPES }).commands,
      [{ type: "door.add", door: { hostId: wallId } }],
      "a door for an existing wall"
    );
    const refused = mock.interpret({ instruction: `Add a window to ${pillarId}`, projectContext: context(), availableObjectTypes: AI_SUPPORTED_OBJECT_TYPES });
    assertEqual(refused.commands.length, 0, "not for a pillar");
    assertTrue(refused.notes?.includes("not a wall"), "and the notes say why");

    const pipeline = new AICommandPipeline(mock, project.commandExecutor, project.history);
    const hosted = await pipeline.run(`Add a window to ${wallId} and add a door to ${wallId}`, buildAIProjectSnapshot(project));
    assertTrue(hosted.success, `the pipeline runs it: ${JSON.stringify(hosted)}`);
    assertEqual(project.windowStore.getAll()[0]?.hostId, wallId, "a real window, in the wall");
    assertEqual(project.doorStore.getAll()[0]?.hostId, wallId, "and a real door, beside it");

    const connected = await pipeline.run(`Connect ${a} to ${b}`, buildAIProjectSnapshot(project));
    assertTrue(connected.success, `connect runs: ${JSON.stringify(connected)}`);
    assertEqual(project.elementStore.get(a)?.connections[0]?.objectId, b, "connected");
    project.history.undo();
    assertSameJson(project.elementStore.get(a)?.connections, [], "one AI response, one undo step");
    project.history.redo();

    // What the browser sends, as the backend parses it, keeps the relationships.
    const sent = JSON.parse(JSON.stringify(context()));
    const received = parseAIProjectContext(sent);
    assertTrue(received.ok, `the backend accepts it (${received.ok ? "" : received.error})`);
    const receivedDoor = received.context.objects.find((object) => object.type === "door");
    assertEqual(receivedDoor?.hostId, wallId, "the provider sees the door's host");
    assertEqual(received.context.objects.find((object) => object.id === a)?.connections?.[0]?.objectId, b, "and the pipe's connection");
    assertTrue(received.context.geometry.hosts.every((host) => host.valid), "and the server-side geometry validates the hosts");
  });

  // --- Persistence ---

  await check("persistence: hosts, placements, and connections survive save/reopen exactly; an older document's placement is derived; a broken connection is rejected", () => {
    const project = createProjectContext();
    const wallId = wall(project, 1, 1, 0.3);
    const doorId = create(project, { type: "door.add", door: { hostId: wallId, offset: 0.7 } });
    const a = pipe(project, "cable", 0, 6);
    const b = pipe(project, "cable", 3, 6);
    succeed(project, { type: "element.connect", from: { id: a }, to: { id: b } });
    const saved = JSON.parse(JSON.stringify(serializeProject(project)));
    const reopened = createProjectContext();
    assertTrue(loadProject(reopened, saved).ok, "reopens");
    assertSameJson(serializeProject(reopened), serializeProject(project), "identical");
    succeed(reopened, { type: "update_object", objectId: wallId, changes: { position: { x: 5 } } });
    assertEqual(reopened.doorStore.get(doorId)?.hostId, wallId, "a reopened door still follows its wall");

    const legacy = JSON.parse(JSON.stringify(saved));
    delete legacy.objects.find((object: { id: string }) => object.id === doorId).hostPlacement;
    const derived = parseProjectDocument(legacy);
    assertTrue(derived.ok, `an older document without placements loads (${derived.ok ? "" : derived.error})`);
    const derivedDoor = derived.document.objects.find((object) => object.id === doorId) as { hostPlacement: { offset: number; sill: number } };
    assertClose(derivedDoor.hostPlacement.offset, 0.7, "its placement is worked out from where it stood");

    const oneSided = JSON.parse(JSON.stringify(saved));
    oneSided.objects.find((object: { id: string }) => object.id === b).connections = [];
    const rejected = parseProjectDocument(oneSided);
    assertTrue(!rejected.ok && rejected.error.includes("doesn't record the connection back"), `a one-sided connection is rejected (${JSON.stringify(rejected)})`);
    const dangling = JSON.parse(JSON.stringify(saved));
    dangling.objects = dangling.objects.filter((object: { id: string }) => object.id !== b);
    const danglingResult = parseProjectDocument(dangling);
    assertTrue(!danglingResult.ok && danglingResult.error.includes("isn't an element"), "a connection to a missing element is rejected");
  });

  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) {
    throw new Error(`${failed} verification check(s) failed`);
  }
}

await run();
