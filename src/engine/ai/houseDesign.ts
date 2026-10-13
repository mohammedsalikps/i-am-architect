import {
  DEFAULT_HOUSE_FOOTPRINT,
  DOOR,
  HOUSE_FOOTPRINT_LIMITS,
  PILLAR_SIZE,
  QUARTER_TURN,
  SLAB_THICKNESS,
  WALL_HEIGHT,
  WALL_THICKNESS,
  WINDOW,
  findHouseCenter
} from "./housePlan.ts";
import type { HouseFootprint, PlanBox } from "./housePlan.ts";
import type { HouseDesignRequest } from "./houseIntent.ts";
import type {
  AddDoorCommand,
  AddElementCommand,
  AddPillarCommand,
  AddSlabCommand,
  AddWallCommand,
  AddWindowCommand,
  Command,
  CommandResult
} from "../commands/types";

/**
 * The room-aware deterministic house planner: turns a HouseDesignRequest
 * (already extracted from natural language by houseIntent.ts - never raw
 * text here) into a real, coherent, room-partitioned house, executed as
 * one atomic operation.
 *
 * This is deliberately NOT built on top of buildSimpleHousePlan()
 * (housePlan.ts) even though it reuses that file's constants and
 * findHouseCenter(): buildSimpleHousePlan() returns a flat, pre-built
 * `Command[]` with no rooms, and its door/window are free-standing boxes
 * pinned to fixed offsets (its own doc comment: "the engine has no wall
 * hosting" - true when it was written, no longer true - see
 * engine/openings/hostOpening.ts). Interior doors and per-room exterior
 * windows need to be HOSTED in the specific wall that actually borders
 * that room, which needs that wall's real, store-assigned id - and a
 * `Command` object returned before execution has no id yet (the store
 * assigns it). So this module doesn't return a plan as data; it takes an
 * `execute` callback and drives construction itself, wall by wall,
 * reading back each real id from its CommandResult before building the
 * openings that host in it - see buildHouseDesign() below. The caller
 * (AICommandPipeline) still owns the one all-or-nothing history group
 * this all happens inside, and still never touches a store directly -
 * every single mutation here, too, goes through the passed-in `execute`,
 * which in the running app is CommandExecutor.execute() itself.
 *
 * Layout: a simple, robust two-row grid - rooms most people would expect
 * near the entrance (living room, kitchen, dining room) in the front
 * row, the rest (bedrooms, bathroom, study) in the back row, each row
 * split evenly along the footprint's length. Every interior wall is a
 * single straight, full-span wall (a row divider or the front/back
 * spine), so every wall meets the next at a clean butt joint with no
 * gap and no special-cased corner geometry beyond what
 * buildSimpleHousePlan's own shell already establishes for the exterior
 * (see computeGrid()). This is a deliberately "boring but always valid"
 * floor plan, not an attempt at realistic architectural variety - see
 * this milestone's own report for that tradeoff.
 */

export interface HouseDesignSummary {
  footprint: HouseFootprint;
  center: { x: number; z: number };
  rooms: string[];
  exteriorWalls: number;
  interiorWalls: number;
  doors: number;
  windows: number;
  pillars: number;
  hasRoof: boolean;
  skippedWindows: number;
}

export interface HouseDesignOutcome {
  command: Command;
  result: CommandResult;
}

export type HouseDesignResult =
  | { success: true; outcomes: HouseDesignOutcome[]; summary: HouseDesignSummary }
  | { success: false; error: string; outcomes: HouseDesignOutcome[] };

export type Execute = (command: Command) => CommandResult;

/** The most rooms one design will lay out - past this a two-row grid stops producing usable cells on any footprint this planner accepts. */
const MAX_ROOMS = 8;
/** A room cell (and, in turn, the wall segments around it) below this in either direction reads as a sliver, not a room. */
const MIN_ROOM_SIDE = 1.6;
/** A window is only added when its room is at least this much wider than the window itself - otherwise it's skipped, not forced (task section 11: avoid overlap rather than guess). */
const WINDOW_CLEARANCE = 0.6;

const SIZE_FOOTPRINTS: Readonly<Record<"small" | "large", HouseFootprint>> = {
  small: { length: 7, width: 6 },
  large: { length: 13, width: 10 }
};

const DEFAULT_ROOMS: Readonly<Record<"small" | "medium" | "large", readonly string[]>> = {
  small: ["Living Room", "Kitchen", "Bedroom", "Bathroom"],
  medium: ["Living Room", "Kitchen", "Bedroom 1", "Bedroom 2", "Bathroom"],
  large: ["Living Room", "Kitchen", "Bedroom 1", "Bedroom 2", "Bedroom 3", "Bathroom", "Dining Room"]
};

/** Rooms that read as "public"/near-the-entrance - preferred in the front row when a layout has to split named rooms across two rows. */
const FRONT_ROOM = /living|kitchen|dining/i;

function clean(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/** The footprint a request resolves to - its own, or one sized from its size adjective and bedroom count. Exported so a caller can preview it (e.g. the architect's location ghost) before planning. */
export function resolveFootprint(request: HouseDesignRequest): HouseFootprint {
  if (request.footprint) {
    return request.footprint;
  }
  const base = request.size === "small" || request.size === "large" ? SIZE_FOOTPRINTS[request.size] : DEFAULT_HOUSE_FOOTPRINT;
  // More bedrooms than the default layout was sized for: grow the
  // footprint's length so rooms stay real rooms, not slivers - only when
  // the caller didn't already pin an explicit size or footprint.
  if (!request.size && request.bedrooms && request.bedrooms > 3) {
    const grownLength = base.length + (request.bedrooms - 3) * 1.5;
    return { length: Math.min(HOUSE_FOOTPRINT_LIMITS.max, grownLength), width: base.width };
  }
  return base;
}

/** Gives repeated room names a stable, distinct number: ["Bedroom","Bedroom"] -> ["Bedroom 1","Bedroom 2"]. A name that appears once is left exactly as given. */
function numberDuplicates(names: readonly string[]): string[] {
  const total = new Map<string, number>();
  for (const name of names) {
    total.set(name, (total.get(name) ?? 0) + 1);
  }
  const seen = new Map<string, number>();
  return names.map((name) => {
    if ((total.get(name) ?? 0) <= 1) {
      return name;
    }
    const index = (seen.get(name) ?? 0) + 1;
    seen.set(name, index);
    return `${name} ${index}`;
  });
}

function bedroomList(count: number): string[] {
  return count === 1 ? ["Bedroom"] : Array.from({ length: count }, (_, i) => `Bedroom ${i + 1}`);
}

function resolveRooms(request: HouseDesignRequest): string[] {
  if (request.rooms && request.rooms.length > 0) {
    // "... with 3 bedrooms" is parsed as a named-room clause mentioning
    // only "Bedroom" three times (see houseIntent.ts's readNamedRooms) -
    // that's a bedroom COUNT, not an exhaustive room list: a real house
    // still gets its living room, kitchen and bathroom too (task section
    // 3), exactly as a bare "3 bedroom house" already does below. Only a
    // clause that also names a non-bedroom room ("... with a living
    // room, kitchen and 2 bedrooms") is treated as the complete,
    // intentional list, used verbatim.
    const onlyBedrooms = request.rooms.every((name) => name === "Bedroom");
    if (!onlyBedrooms) {
      // A bedroom COUNT given alongside the list ("a 3-bedroom house with a
      // living room, kitchen and two bathrooms") still counts: bedrooms the
      // list doesn't name are added, before the bathrooms - never dropped.
      const named = request.rooms.filter((name) => name === "Bedroom" || name === "Master Bedroom").length;
      const missing = Math.max(0, (request.bedrooms ?? 0) - named);
      if (missing === 0) {
        return numberDuplicates(request.rooms);
      }
      const rooms = [...request.rooms];
      const firstBathroom = rooms.indexOf("Bathroom");
      rooms.splice(firstBathroom === -1 ? rooms.length : firstBathroom, 0, ...Array.from({ length: missing }, () => "Bedroom"));
      return numberDuplicates(rooms);
    }
    return ["Living Room", "Kitchen", ...bedroomList(request.rooms.length), "Bathroom"];
  }
  if (request.bedrooms !== undefined && request.bedrooms > 0) {
    return ["Living Room", "Kitchen", ...bedroomList(request.bedrooms), "Bathroom"];
  }
  return [...DEFAULT_ROOMS[request.size ?? "medium"]];
}

export interface RoomCell {
  name: string;
  center: { x: number; z: number };
  /** Along X. */
  length: number;
  /** Along Z. */
  width: number;
  side: "front" | "back" | "single";
}

export interface InteriorWallSpec {
  /** "spine" separates the front and back rows; "divider" separates two rooms within one row. */
  kind: "spine" | "divider";
  center: { x: number; z: number };
  length: number;
  rotation: number;
}

export interface HouseLayout {
  footprint: HouseFootprint;
  center: { x: number; z: number };
  rooms: RoomCell[];
  interiorWalls: InteriorWallSpec[];
}

/**
 * The two-row room grid inside the footprint's exterior walls (see the
 * module doc comment). Rooms most people expect near the entrance go in
 * the front row (same +Z side buildSimpleHousePlan's own shell puts its
 * door on); the rest go in the back row. A single room spans the whole
 * interior, with no interior walls at all.
 */
function computeGrid(footprint: HouseFootprint, center: { x: number; z: number }, rooms: readonly string[]): HouseLayout {
  const innerHalfX = footprint.length / 2 - WALL_THICKNESS;
  const innerHalfZ = footprint.width / 2 - WALL_THICKNESS;
  const xMin = center.x - innerHalfX;
  const xMax = center.x + innerHalfX;
  const zMin = center.z - innerHalfZ;
  const zMax = center.z + innerHalfZ;

  if (rooms.length <= 1) {
    const cell: RoomCell = { name: rooms[0] ?? "Room", center, length: xMax - xMin, width: zMax - zMin, side: "single" };
    return { footprint, center, rooms: [cell], interiorWalls: [] };
  }

  const ordered = [...rooms].sort((a, b) => Number(FRONT_ROOM.test(b)) - Number(FRONT_ROOM.test(a)));
  const frontCount = Math.ceil(ordered.length / 2);
  const frontNames = ordered.slice(0, frontCount);
  const backNames = ordered.slice(frontCount);

  const spineZ = center.z;
  const frontZMin = spineZ + WALL_THICKNESS / 2;
  const backZMax = spineZ - WALL_THICKNESS / 2;

  const cells: RoomCell[] = [];
  const interiorWalls: InteriorWallSpec[] = [];

  const layoutRow = (names: readonly string[], rowZMin: number, rowZMax: number, side: "front" | "back"): void => {
    const cellWidth = (xMax - xMin) / names.length;
    const rowDepth = rowZMax - rowZMin;
    const rowCenterZ = (rowZMin + rowZMax) / 2;
    names.forEach((name, index) => {
      const cellXMin = xMin + index * cellWidth;
      cells.push({ name, center: { x: clean(cellXMin + cellWidth / 2), z: clean(rowCenterZ) }, length: clean(cellWidth), width: clean(rowDepth), side });
      if (index > 0) {
        interiorWalls.push({
          kind: "divider",
          center: { x: clean(cellXMin), z: clean(rowCenterZ) },
          length: clean(rowDepth),
          rotation: QUARTER_TURN
        });
      }
    });
  };

  layoutRow(frontNames, frontZMin, zMax, "front");
  if (backNames.length > 0) {
    layoutRow(backNames, zMin, backZMax, "back");
    interiorWalls.push({ kind: "spine", center: { x: clean(center.x), z: clean(spineZ) }, length: clean(xMax - xMin), rotation: 0 });
  }

  return { footprint, center, rooms: cells, interiorWalls };
}

function tooSmall(layout: HouseLayout): string | null {
  for (const room of layout.rooms) {
    if (room.length < MIN_ROOM_SIDE || room.width < MIN_ROOM_SIDE) {
      return `${room.name} would be only ${room.length.toFixed(1)} m × ${room.width.toFixed(1)} m on a ${layout.footprint.length} m × ${layout.footprint.width} m footprint with ${layout.rooms.length} rooms - too small to be a real room. Use a larger footprint or fewer rooms.`;
    }
  }
  return null;
}

/**
 * Validates and lays out a design, without executing anything - pure, so it's independently testable and so AICommandPipeline can report a clear failure before any command runs.
 * `center`, when given, is where the house goes (the architect's chosen coordinates); otherwise findHouseCenter() picks a spot clear of `occupied`.
 */
export function planHouseDesign(
  request: HouseDesignRequest,
  occupied: readonly PlanBox[],
  center?: { x: number; z: number }
): { ok: true; layout: HouseLayout } | { ok: false; error: string } {
  const footprint = resolveFootprint(request);
  const { min, max } = HOUSE_FOOTPRINT_LIMITS;
  if (footprint.length < min || footprint.length > max || footprint.width < min || footprint.width > max) {
    return { ok: false, error: `A ${footprint.length} m × ${footprint.width} m footprint is outside what the house planner supports (each side must be ${min}-${max} m).` };
  }

  const rooms = resolveRooms(request);
  if (rooms.length > MAX_ROOMS) {
    return { ok: false, error: `${rooms.length} rooms is more than this house planner supports (up to ${MAX_ROOMS}) - ask for fewer rooms.` };
  }

  const layout = computeGrid(footprint, center ? { x: clean(center.x), z: clean(center.z) } : findHouseCenter(footprint, occupied), rooms);
  const problem = tooSmall(layout);
  if (problem) {
    return { ok: false, error: problem };
  }
  return { ok: true, layout };
}

function fail(outcomes: HouseDesignOutcome[], error: string): HouseDesignResult {
  return { success: false, error, outcomes };
}

/**
 * The house's construction stages, in build order. buildHouseDesign()
 * runs all five back to back (the one-shot AI path); the architect
 * conversation (engine/architect/) runs them one at a time, each its own
 * undo step. Both build exactly the same commands - the functions below
 * are the only place a stage's commands are written.
 */
export const HOUSE_STAGES = ["foundation", "structure", "openings", "rooms", "roof"] as const;
export type HouseStage = (typeof HOUSE_STAGES)[number];

/** The real, store-assigned ids of the walls the structure stage built - what the openings stage hosts its doors and windows in. */
export interface HouseStructureRefs {
  frontWallId: string;
  backWallId: string;
  leftWallId: string;
  rightWallId: string;
  interiorWallIds: string[];
}

/** Where a layout's parts sit, relative to the house: shared by every stage builder below. */
function frame(layout: HouseLayout) {
  const { footprint, center } = layout;
  return {
    halfLength: footprint.length / 2,
    halfWidth: footprint.width / 2,
    standingY: SLAB_THICKNESS + WALL_HEIGHT / 2,
    at: (x: number, y: number, z: number) => ({ x: clean(center.x + x), y: clean(y), z: clean(center.z + z) })
  };
}

/** Stage 1: one slab, matching the footprint exactly. */
export function foundationStageCommands(layout: HouseLayout): AddSlabCommand[] {
  const { at } = frame(layout);
  return [
    {
      type: "slab.add",
      slab: { length: layout.footprint.length, width: layout.footprint.width, thickness: SLAB_THICKNESS, rotation: 0, position: at(0, SLAB_THICKNESS / 2, 0) }
    }
  ];
}

/**
 * Stage 2, in this exact order: the front, back, left and right exterior
 * walls (same shell as buildSimpleHousePlan's), the four corner pillars,
 * then the interior walls (row dividers, then the front/back spine).
 * readStructureRefs() relies on that order.
 */
export function structureStageCommands(layout: HouseLayout): (AddWallCommand | AddPillarCommand)[] {
  const { footprint, interiorWalls } = layout;
  const { halfLength, halfWidth, standingY, at } = frame(layout);
  const alongX = footprint.length - 2 * PILLAR_SIZE;
  const alongZ = footprint.width - 2 * PILLAR_SIZE;
  const wallX = halfLength - WALL_THICKNESS / 2;
  const wallZ = halfWidth - WALL_THICKNESS / 2;
  const exteriorWall = (x: number, z: number, wallLength: number, rotation: number): AddWallCommand => ({
    type: "wall.add",
    wall: { length: clean(wallLength), height: WALL_HEIGHT, thickness: WALL_THICKNESS, rotation, position: at(x, standingY, z) }
  });

  const pillarX = halfLength - PILLAR_SIZE / 2;
  const pillarZ = halfWidth - PILLAR_SIZE / 2;
  const pillarSigns: [number, number][] = [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1]
  ];
  const pillars: AddPillarCommand[] = pillarSigns.map(([signX, signZ]) => ({
    type: "pillar.add",
    pillar: { width: PILLAR_SIZE, depth: PILLAR_SIZE, height: WALL_HEIGHT, rotation: 0, position: at(signX * pillarX, standingY, signZ * pillarZ) }
  }));

  const interior: AddWallCommand[] = interiorWalls.map((spec) => ({
    type: "wall.add",
    wall: {
      length: spec.length,
      height: WALL_HEIGHT,
      thickness: WALL_THICKNESS,
      rotation: spec.rotation,
      position: { x: spec.center.x, y: standingY, z: spec.center.z }
    }
  }));

  return [
    exteriorWall(0, wallZ, alongX, 0),
    exteriorWall(0, -wallZ, alongX, 0),
    exteriorWall(-wallX, 0, alongZ, QUARTER_TURN),
    exteriorWall(wallX, 0, alongZ, QUARTER_TURN),
    ...pillars,
    ...interior
  ];
}

/** Reads the wall ids back out of the structure stage's results, given in structureStageCommands()' order. Null when any wall is missing one. */
export function readStructureRefs(results: readonly CommandResult[]): HouseStructureRefs | null {
  const id = (index: number): string | undefined => (results[index]?.success ? results[index].objectId : undefined);
  const [frontWallId, backWallId, leftWallId, rightWallId] = [id(0), id(1), id(2), id(3)];
  const interiorWallIds = results.slice(8).map((result) => (result.success ? result.objectId : undefined));
  if (!frontWallId || !backWallId || !leftWallId || !rightWallId || interiorWallIds.some((wallId) => !wallId)) {
    return null;
  }
  return { frontWallId, backWallId, leftWallId, rightWallId, interiorWallIds: interiorWallIds as string[] };
}

/**
 * Stage 3: the entrance door centered on the front wall, one door centered
 * on each interior wall (connecting the two rooms it separates), then the
 * exterior windows: every back-row room, plus whichever room sits at each
 * side (or the single room, which gets all three) - never the front wall,
 * which already carries the entrance door. A window is skipped, not
 * forced, when its room is too narrow for it to fit cleanly (task section
 * 11: avoid overlap rather than guess). Every opening is hosted in a real
 * wall from `refs`.
 */
export function openingsStageCommands(layout: HouseLayout, refs: HouseStructureRefs): { commands: (AddDoorCommand | AddWindowCommand)[]; skippedWindows: number } {
  const { center, rooms } = layout;
  const commands: (AddDoorCommand | AddWindowCommand)[] = [{ type: "door.add", door: { ...DOOR, hostId: refs.frontWallId } }];
  for (const wallId of refs.interiorWallIds) {
    commands.push({ type: "door.add", door: { ...DOOR, hostId: wallId } });
  }

  let skippedWindows = 0;
  const addWindow = (hostId: string, roomSpan: number, point: { x?: number; z?: number }): void => {
    if (roomSpan < WINDOW.width + WINDOW_CLEARANCE) {
      skippedWindows += 1;
      return;
    }
    commands.push({ type: "window.add", window: { ...WINDOW, hostId, position: { x: center.x + (point.x ?? 0), z: center.z + (point.z ?? 0) } } });
  };

  if (rooms.length === 1) {
    const room = rooms[0];
    addWindow(refs.backWallId, room.width, { x: 0 });
    addWindow(refs.leftWallId, room.length, { z: 0 });
    addWindow(refs.rightWallId, room.length, { z: 0 });
  } else {
    for (const room of rooms) {
      if (room.side === "back") {
        addWindow(refs.backWallId, room.length, { x: room.center.x - center.x });
      }
    }
    // The front and back rows occupy disjoint Z-ranges of the same left/
    // right wall, so the front-row edge room and the back-row edge room
    // each get their own side window - one wall, two windows, never
    // overlapping (the row split itself keeps them well apart).
    const edge = (side: "front" | "back", pick: (a: RoomCell, b: RoomCell) => number): RoomCell | undefined =>
      rooms.filter((room) => room.side === side).sort(pick)[0];
    const leftRooms = [edge("front", (a, b) => a.center.x - b.center.x), edge("back", (a, b) => a.center.x - b.center.x)];
    const rightRooms = [edge("front", (a, b) => b.center.x - a.center.x), edge("back", (a, b) => b.center.x - a.center.x)];
    for (const room of leftRooms) {
      if (room) addWindow(refs.leftWallId, room.width, { z: room.center.z - center.z });
    }
    for (const room of rightRooms) {
      if (room) addWindow(refs.rightWallId, room.width, { z: room.center.z - center.z });
    }
  }
  return { commands, skippedWindows };
}

/** Stage 4: one "room" element per cell - a real, named, positioned space, not a floating label (task section 10). */
export function roomsStageCommands(layout: HouseLayout): AddElementCommand[] {
  return layout.rooms.map((room) => ({
    type: "element.add",
    element: {
      kind: "room",
      label: room.name,
      position: { x: room.center.x, z: room.center.z },
      dimensions: { length: room.length, width: room.width }
    }
  }));
}

/**
 * Stage 5: the roof, sized to the footprint plus a small eave overhang -
 * baseY in the "roof" catalog entry (elements/catalog.ts) is calibrated to
 * sit exactly on top of this WALL_HEIGHT + SLAB_THICKNESS shell already,
 * so omitting position.y lands it correctly without this file needing to
 * know that number itself.
 */
export function roofStageCommands(layout: HouseLayout): AddElementCommand[] {
  const eave = 0.6;
  return [
    {
      type: "element.add",
      element: { kind: "roof", position: { x: layout.center.x, z: layout.center.z }, dimensions: { length: layout.footprint.length + eave, width: layout.footprint.width + eave } }
    }
  ];
}

const EXTERIOR_WALL_NAMES = ["front", "back", "left", "right"];

/**
 * Executes a validated layout as one sequence of real commands, via
 * `execute` (in the running app, CommandExecutor.execute()) - every stage
 * above, in order: walls and pillars first (each one's real id read back
 * from its CommandResult), then the openings that host in those specific
 * walls, then the room elements, then the roof. Stops and reports the
 * first failure (a window that doesn't fit is the one exception - it is
 * left out, not fatal); the caller wraps this whole call in one history
 * group, so a failure part-way through is fully rolled back by the caller
 * (see AICommandPipeline.run()) - nothing here ever undoes anything itself.
 */
export function buildHouseDesign(layout: HouseLayout, execute: Execute): HouseDesignResult {
  const outcomes: HouseDesignOutcome[] = [];
  const run = (command: Command): CommandResult | null => {
    const result = execute(command);
    outcomes.push({ command, result });
    return result.success ? result : null;
  };

  for (const slab of foundationStageCommands(layout)) {
    if (!run(slab)) {
      return fail(outcomes, "Could not place the floor slab.");
    }
  }

  const structureResults: CommandResult[] = [];
  for (const [index, command] of structureStageCommands(layout).entries()) {
    const result = run(command);
    if (!result) {
      return fail(
        outcomes,
        index < 4 ? `Could not place the ${EXTERIOR_WALL_NAMES[index]} exterior wall.` : index < 8 ? "Could not place a corner pillar." : "Could not place an interior wall."
      );
    }
    structureResults.push(result);
  }
  const refs = readStructureRefs(structureResults);
  if (!refs) {
    return fail(outcomes, "Could not read back the walls just built.");
  }

  const { commands: openings, skippedWindows } = openingsStageCommands(layout, refs);
  for (const [index, command] of openings.entries()) {
    if (command.type === "window.add") {
      run(command);
      continue;
    }
    if (!run(command)) {
      return fail(outcomes, index === 0 ? "Could not place the entrance door." : "Could not place an interior door.");
    }
  }

  for (const [index, command] of roomsStageCommands(layout).entries()) {
    if (!run(command)) {
      return fail(outcomes, `Could not place the "${layout.rooms[index].name}" room.`);
    }
  }

  for (const roof of roofStageCommands(layout)) {
    if (!run(roof)) {
      return fail(outcomes, "Could not place the roof.");
    }
  }

  const summary: HouseDesignSummary = {
    footprint: layout.footprint,
    center: layout.center,
    rooms: layout.rooms.map((room) => room.name),
    exteriorWalls: 4,
    interiorWalls: layout.interiorWalls.length,
    doors: 1 + layout.interiorWalls.length,
    windows: outcomes.filter((outcome) => outcome.command.type === "window.add" && outcome.result.success).length,
    pillars: 4,
    hasRoof: true,
    skippedWindows
  };
  return { success: true, outcomes, summary };
}

/** Convenience: validates and builds in one call - what AICommandPipeline actually uses. */
export function designAndBuildHouse(request: HouseDesignRequest, occupied: readonly PlanBox[], execute: Execute): HouseDesignResult {
  const planned = planHouseDesign(request, occupied);
  if (!planned.ok) {
    return fail([], planned.error);
  }
  return buildHouseDesign(planned.layout, execute);
}

/**
 * "AI DESIGN COMPLETE" (task section 16): a concise, human-readable
 * summary of what a successful design actually built - never raw JSON.
 * Goes in AIPipelineResult.notes, so it renders through the exact same
 * "Note: ..." line the command bar already shows for any provider's
 * notes (ui/commandBar.ts) - no new UI needed for this.
 */
export function summarizeHouseDesign(summary: HouseDesignSummary): string {
  const { footprint, rooms, exteriorWalls, interiorWalls, doors, windows, hasRoof, skippedWindows } = summary;
  const parts = [
    `Designed a ${footprint.length} m × ${footprint.width} m house: ${rooms.length} room${rooms.length === 1 ? "" : "s"} (${rooms.join(", ")}), `,
    `${exteriorWalls} exterior wall${exteriorWalls === 1 ? "" : "s"}`,
    interiorWalls > 0 ? `, ${interiorWalls} interior wall${interiorWalls === 1 ? "" : "s"}` : "",
    `, ${doors} door${doors === 1 ? "" : "s"}`,
    `, ${windows} window${windows === 1 ? "" : "s"}`,
    hasRoof ? ", and a roof." : "."
  ];
  const sentence = parts.join("");
  return skippedWindows > 0
    ? `${sentence} (${skippedWindows} window${skippedWindows === 1 ? " was" : "s were"} skipped - the room${skippedWindows === 1 ? "" : "s"} too narrow to fit one cleanly.)`
    : sentence;
}
