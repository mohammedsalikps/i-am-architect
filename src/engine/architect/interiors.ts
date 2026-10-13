// Explicit .ts extensions on value imports let Node run this file directly
// (engine/architect/verify.ts does). Harmless for Vite.
import { getAssetDefinition } from "../assets/catalog.ts";
import { DOOR, PILLAR_SIZE, SLAB_THICKNESS, WALL_THICKNESS, WINDOW } from "../ai/housePlan.ts";
import { openingsStageCommands } from "../ai/houseDesign.ts";
import type { HouseLayout } from "../ai/houseDesign.ts";
import { analyzeConstructionGeometry } from "../ai/geometry/analyzeConstructionGeometry.ts";
import { wallAxes } from "../openings/hostOpening.ts";
import { describeRoom, listRooms } from "./roomModel.ts";
import type { AIProjectSnapshot } from "../ai/types";
import type { AddAssetCommand } from "../commands/types";

/**
 * The architect's interiors stage: deterministic furniture for each room
 * of a planned house, as ordinary `asset.add` commands - the same command
 * the Assets tab and the AI already place furniture with, so every piece
 * is an ordinary, selectable, draggable, undoable asset.
 *
 * Pure: reads only the HouseLayout (the same one the house was built
 * from) and the asset catalog's real dimensions. Each room type has a
 * short list of pieces; each piece a short list of candidate spots (back
 * to the outer wall, the inner wall, or a side wall; centred or in a
 * corner) and, for a few, smaller sizes to fall back to (a single bed, a
 * shorter counter). The first spot that fits is used; a piece with none
 * is left out and counted in `skipped`, never forced. "Fits" means, in
 * world plan coordinates:
 *
 * - inside the room's cell;
 * - clear of every door's swing zone (entrance, spine and divider doors -
 *   all centred on their walls, see houseDesign.ts's openings stage);
 * - clear of interior walls and the corner pillars;
 * - for pieces taller than a window sill, clear of the windows;
 * - not overlapping another piece (a rug may lie under others).
 *
 * Every model's back is at its local -Z (see scripts/generate-asset-models.mjs),
 * so rotation 0 puts a piece's back toward -Z, π toward +Z, π/2 toward -X
 * and -π/2 toward +X. Pieces stand on the slab, not the ground.
 */

/** A clear zone in plan: x/z extents in world meters. */
interface PlanRect {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
}

/**
 * Which wall a piece's back is toward: the room's exterior wall ("outer"),
 * the wall across from it ("inner"), or a side wall - the one at the
 * room's far end (away from the house's centre line) or its near end.
 */
type BackWall = "outer" | "inner" | "far" | "near";

/**
 * One spot to try for a piece - its centre in the room's own frame: `u`
 * runs along X from the room's far end, `v` along Z from the outer wall.
 */
interface Candidate {
  u: number;
  v: number;
  back: BackWall;
}

interface PlacedPiece {
  candidate: Candidate;
  /** The piece's own width as placed (it may be a fallback size). */
  width: number;
  rect: PlanRect;
  flat: boolean;
}

interface PieceSpec {
  key: string;
  assetId: string;
  /** A rug: may lie under other pieces. */
  flat?: boolean;
  /** Widths to try, largest first, when the catalog size doesn't fit - a single bed, a shorter counter. */
  widths?: readonly number[];
  candidates: (room: RoomFrame, placed: ReadonlyMap<string, PlacedPiece>, width: number) => Candidate[];
}

/** A room's size in its own frame: L along X, W along Z. */
interface RoomFrame {
  L: number;
  W: number;
}

/** One room to furnish: its plan box, and which way it faces. */
interface FurnishTarget {
  name: string;
  center: { x: number; z: number };
  /** Along X. */
  sizeX: number;
  /** Along Z. */
  sizeZ: number;
  /** Its far end - the quiet one, away from the doors - is at -X. */
  farIsMinX: boolean;
  /** Its outer (exterior) wall is at -Z. */
  outerIsMinZ: boolean;
}

interface KeepOuts {
  always: PlanRect[];
  tallOnly: PlanRect[];
}

export interface FurnishingPlan {
  commands: AddAssetCommand[];
  /** Per room name, the indices into `commands` of that room's pieces. */
  byRoom: Map<string, number[]>;
  /** Pieces left out because no candidate spot fit. */
  skipped: number;
}

const WALL_GAP = 0.05;
/** How far an interior wall reaches either side of its centre line. */
const HALF_WALL = WALL_THICKNESS / 2;
const DOOR_CLEAR_HALF = DOOR.width / 2 + 0.1;
/** How far into a room a door's swing needs to stay clear. */
const DOOR_CLEAR_DEPTH = 0.8;
const WINDOW_CLEAR_HALF = WINDOW.width / 2 + 0.1;
const WINDOW_CLEAR_DEPTH = 0.6;
/** A piece taller than this would block a window. */
const TALL = 1.0;
const EPSILON = 1e-6;

function clean(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

function size(assetId: string): { width: number; height: number; depth: number } {
  const definition = getAssetDefinition(assetId);
  if (!definition) {
    throw new Error(`Interiors reference unknown asset "${assetId}".`);
  }
  return definition.defaultDimensions;
}

function isSide(back: BackWall): boolean {
  return back === "far" || back === "near";
}

function opposite(back: BackWall): BackWall {
  return ({ outer: "inner", inner: "outer", far: "near", near: "far" } as const)[back];
}

/** A candidate `distance` out from `c` along the direction its back faces away from. */
function inFront(c: Candidate, distance: number): Candidate {
  const sign = c.back === "outer" || c.back === "far" ? 1 : -1;
  return isSide(c.back) ? { ...c, u: c.u + sign * distance } : { ...c, v: c.v + sign * distance };
}

/** A candidate moved `distance` along the wall its back is against. */
function along(c: Candidate, distance: number): Candidate {
  return isSide(c.back) ? { ...c, v: c.v + distance } : { ...c, u: c.u + distance };
}

/** A piece of `depth` with its back to `back`, centred `at` along that wall (null = centred on the wall). */
function onWall(room: RoomFrame, back: BackWall, depth: number, at: number | null = null): Candidate {
  const off = WALL_GAP + HALF_WALL + depth / 2;
  switch (back) {
    case "outer":
      return { u: at ?? room.L / 2, v: WALL_GAP + depth / 2, back };
    case "inner":
      return { u: at ?? room.L / 2, v: room.W - WALL_GAP - depth / 2, back };
    case "far":
      return { u: off, v: at ?? room.W / 2, back };
    case "near":
      return { u: room.L - off, v: at ?? room.W / 2, back };
  }
}

/** Every corner spot for a piece of `width` × `depth`: back to each wall, at either end of it. */
function cornerSpots(room: RoomFrame, width: number, depth: number, prefer: readonly BackWall[] = ["outer", "inner", "far", "near"]): Candidate[] {
  const endU = WALL_GAP + HALF_WALL + width / 2;
  const endV = WALL_GAP + width / 2;
  return prefer.flatMap((back) =>
    isSide(back) ? [onWall(room, back, depth, endV), onWall(room, back, depth, room.W - endV)] : [onWall(room, back, depth, endU), onWall(room, back, depth, room.L - endU)]
  );
}

const corners =
  (assetId: string, prefer?: readonly BackWall[]) =>
  (room: RoomFrame, _placed: ReadonlyMap<string, PlacedPiece>, width: number): Candidate[] =>
    cornerSpots(room, width, size(assetId).depth, prefer);

/** Four chairs around a placed table, two on each long side, facing it. */
function chairsAround(tableKey: string): PieceSpec[] {
  const chair = size("dining-chair");
  const reach = size("dining-table").depth / 2 + 0.05 + chair.depth / 2;
  const specs: PieceSpec[] = [];
  for (const side of [-1, 1]) {
    for (const offset of [-1, 1]) {
      specs.push({
        key: `chair${side}${offset}`,
        assetId: "dining-chair",
        candidates: (_room, placed) => {
          const table = placed.get(tableKey);
          if (!table) return [];
          const spread = offset * Math.min(0.4, table.width / 2 - chair.width / 2);
          const c = table.candidate;
          // A chair faces the table: its back is toward the wall on its own side.
          if (isSide(c.back)) {
            return [{ u: c.u + side * reach, v: c.v + spread, back: side < 0 ? "far" : "near" }];
          }
          return [{ u: c.u + spread, v: c.v + side * reach, back: side < 0 ? "outer" : "inner" }];
        }
      });
    }
  }
  return specs;
}

function diningTable(key: string): PieceSpec {
  return {
    key,
    assetId: "dining-table",
    widths: [size("dining-table").width, 1.2],
    candidates: (room) => [
      { u: room.L / 2, v: room.W / 2, back: "outer" },
      { u: room.L / 2, v: room.W / 2, back: "far" },
      { u: room.L / 2, v: room.W / 2 + 0.4, back: "outer" },
      { u: room.L / 2, v: room.W / 2 - 0.4, back: "outer" }
    ]
  };
}

const BEDROOM: PieceSpec[] = [
  {
    key: "bed",
    assetId: "bed",
    // A double, then a small double, then a single.
    widths: [size("bed").width, 1.2, 0.9],
    candidates: (room, _placed, width) => {
      const { depth } = size("bed");
      const room4side = width / 2 + size("bedside-table").width + 0.15;
      return [
        onWall(room, "outer", depth),
        onWall(room, "inner", depth),
        onWall(room, "far", depth),
        onWall(room, "near", depth),
        onWall(room, "outer", depth, room4side),
        onWall(room, "outer", depth, room.L - room4side),
        onWall(room, "inner", depth, room4side),
        onWall(room, "inner", depth, room.L - room4side),
        onWall(room, "far", depth, room4side),
        onWall(room, "far", depth, room.W - room4side)
      ];
    }
  },
  ...[-1, 1].map(
    (offset): PieceSpec => ({
      key: `bedside${offset}`,
      assetId: "bedside-table",
      candidates: (room, placed) => {
        const bed = placed.get("bed");
        if (!bed) return [];
        const table = size("bedside-table");
        const wall = onWall(room, bed.candidate.back, table.depth, isSide(bed.candidate.back) ? bed.candidate.v : bed.candidate.u);
        return [along(wall, offset * (bed.width / 2 + 0.05 + table.width / 2))];
      }
    })
  ),
  { key: "wardrobe", assetId: "wardrobe", candidates: corners("wardrobe", ["inner", "far", "near", "outer"]) }
];

const LIVING: PieceSpec[] = [
  {
    key: "sofa",
    assetId: "sofa",
    widths: [size("sofa").width, 1.6],
    candidates: (room, _placed, width) => {
      const { depth } = size("sofa");
      return [
        onWall(room, "inner", depth),
        onWall(room, "outer", depth),
        onWall(room, "far", depth),
        onWall(room, "near", depth),
        ...cornerSpots(room, width, depth, ["inner", "outer"])
      ];
    }
  },
  {
    key: "coffee",
    assetId: "coffee-table",
    candidates: (_room, placed) => {
      const sofa = placed.get("sofa");
      return sofa ? [inFront(sofa.candidate, size("sofa").depth / 2 + 0.4 + size("coffee-table").depth / 2)] : [];
    }
  },
  {
    key: "tv",
    assetId: "tv-console",
    candidates: (room, placed) => {
      const sofa = placed.get("sofa");
      if (!sofa) return [];
      const c = sofa.candidate;
      return [onWall(room, opposite(c.back), size("tv-console").depth, isSide(c.back) ? c.v : c.u)];
    }
  },
  {
    key: "rug",
    assetId: "rug",
    flat: true,
    candidates: (_room, placed) => {
      const coffee = placed.get("coffee");
      return coffee ? [coffee.candidate] : [];
    }
  },
  {
    key: "lamp",
    assetId: "floor-lamp",
    candidates: (room, placed) => {
      const sofa = placed.get("sofa");
      if (!sofa) return [];
      const lamp = size("floor-lamp");
      const c = sofa.candidate;
      const wall = onWall(room, c.back, lamp.depth, isSide(c.back) ? c.v : c.u);
      const offset = sofa.width / 2 + 0.1 + lamp.width / 2;
      return [along(wall, offset), along(wall, -offset)];
    }
  },
  { key: "plant", assetId: "plant", candidates: corners("plant") }
];

const KITCHEN = (withDining: boolean): PieceSpec[] => [
  { key: "counter", assetId: "kitchen-counter", widths: [size("kitchen-counter").width, 1.6, 1.2], candidates: corners("kitchen-counter") },
  ...(withDining ? [diningTable("table"), ...chairsAround("table")] : [])
];

const DINING: PieceSpec[] = [diningTable("table"), ...chairsAround("table"), { key: "plant", assetId: "plant", candidates: corners("plant") }];

const BATHROOM: PieceSpec[] = [{ key: "toilet", assetId: "toilet", candidates: corners("toilet") }];

const STUDY: PieceSpec[] = [
  {
    key: "desk",
    assetId: "dining-table",
    widths: [size("dining-table").width, 1.2],
    candidates: (room, _placed, width) => {
      const { depth } = size("dining-table");
      return [onWall(room, "outer", depth), onWall(room, "far", depth), onWall(room, "inner", depth), ...cornerSpots(room, width, depth)];
    }
  },
  {
    key: "chair",
    assetId: "dining-chair",
    candidates: (_room, placed) => {
      const desk = placed.get("desk");
      if (!desk) return [];
      const seat = inFront(desk.candidate, size("dining-table").depth / 2 + 0.05 + size("dining-chair").depth / 2);
      // Facing the desk: its back is toward the wall opposite the desk's.
      return [{ ...seat, back: opposite(desk.candidate.back) }];
    }
  },
  { key: "plant", assetId: "plant", candidates: corners("plant") }
];

/** Which furniture set a room gets, from its name. Anything unrecognized ("Studio", "Room") is furnished as a living space. A kitchen gets a table only when the house has no dining room (`allNames`). */
function piecesFor(name: string, allNames: readonly string[]): PieceSpec[] {
  if (/bed/i.test(name)) return BEDROOM;
  if (/kitchen/i.test(name)) return KITCHEN(!allNames.some((room) => /dining/i.test(room)));
  if (/dining/i.test(name)) return DINING;
  if (/bath|toilet|wc|wash/i.test(name)) return BATHROOM;
  if (/study|office/i.test(name)) return STUDY;
  return LIVING;
}

/** Every zone no piece may stand in, in world plan coordinates - door swings, interior walls, corner pillars - and, separately, the window zones only tall pieces must avoid. */
function keepOuts(layout: HouseLayout): KeepOuts {
  const { center, footprint, interiorWalls } = layout;
  const innerX0 = center.x - footprint.length / 2 + WALL_THICKNESS;
  const innerX1 = center.x + footprint.length / 2 - WALL_THICKNESS;
  const innerZ0 = center.z - footprint.width / 2 + WALL_THICKNESS;
  const innerZ1 = center.z + footprint.width / 2 - WALL_THICKNESS;
  const always: PlanRect[] = [];

  // The entrance door, centred on the front (+Z) wall.
  always.push({ x0: center.x - DOOR_CLEAR_HALF, x1: center.x + DOOR_CLEAR_HALF, z0: innerZ1 - DOOR_CLEAR_DEPTH, z1: innerZ1 });

  for (const wall of interiorWalls) {
    if (wall.kind === "spine") {
      // The wall itself, and its door's swing zone on both sides.
      always.push({ x0: wall.center.x - wall.length / 2, x1: wall.center.x + wall.length / 2, z0: wall.center.z - HALF_WALL, z1: wall.center.z + HALF_WALL });
      always.push({
        x0: wall.center.x - DOOR_CLEAR_HALF,
        x1: wall.center.x + DOOR_CLEAR_HALF,
        z0: wall.center.z - HALF_WALL - DOOR_CLEAR_DEPTH,
        z1: wall.center.z + HALF_WALL + DOOR_CLEAR_DEPTH
      });
    } else {
      always.push({ x0: wall.center.x - HALF_WALL, x1: wall.center.x + HALF_WALL, z0: wall.center.z - wall.length / 2, z1: wall.center.z + wall.length / 2 });
      always.push({
        x0: wall.center.x - HALF_WALL - DOOR_CLEAR_DEPTH,
        x1: wall.center.x + HALF_WALL + DOOR_CLEAR_DEPTH,
        z0: wall.center.z - DOOR_CLEAR_HALF,
        z1: wall.center.z + DOOR_CLEAR_HALF
      });
    }
  }

  // The corner pillars reach past the exterior walls' inner faces.
  const reach = PILLAR_SIZE - WALL_THICKNESS + WALL_GAP;
  for (const [x, z] of [
    [innerX0, innerZ0],
    [innerX1, innerZ0],
    [innerX0, innerZ1],
    [innerX1, innerZ1]
  ]) {
    always.push({ x0: x - reach, x1: x + reach, z0: z - reach, z1: z + reach });
  }

  // Windows: read from the openings stage itself, so these zones are
  // exactly where its windows go. Placeholder ids stand in for the walls
  // (only which wall each window is in matters here).
  const refs = { frontWallId: "front", backWallId: "back", leftWallId: "left", rightWallId: "right", interiorWallIds: interiorWalls.map((_, i) => `interior-${i}`) };
  const tallOnly: PlanRect[] = [];
  for (const command of openingsStageCommands(layout, refs).commands) {
    if (command.type !== "window.add") continue;
    const position = command.window.position ?? {};
    const host = command.window.hostId;
    if (host === "back") {
      const x = position.x ?? center.x;
      tallOnly.push({ x0: x - WINDOW_CLEAR_HALF, x1: x + WINDOW_CLEAR_HALF, z0: innerZ0, z1: innerZ0 + WINDOW_CLEAR_DEPTH });
    } else if (host === "left" || host === "right") {
      const z = position.z ?? center.z;
      const x0 = host === "left" ? innerX0 : innerX1 - WINDOW_CLEAR_DEPTH;
      tallOnly.push({ x0, x1: x0 + WINDOW_CLEAR_DEPTH, z0: z - WINDOW_CLEAR_HALF, z1: z + WINDOW_CLEAR_HALF });
    }
  }
  return { always, tallOnly };
}

function overlaps(a: PlanRect, b: PlanRect): boolean {
  return a.x0 < b.x1 - EPSILON && a.x1 > b.x0 + EPSILON && a.z0 < b.z1 - EPSILON && a.z1 > b.z0 + EPSILON;
}

/**
 * Plans the furniture for `roomNames` (every room when omitted) of a
 * planned layout - keep-outs come from the layout itself, so this works
 * before anything is built. Rooms not in the layout are ignored.
 * Deterministic: the same layout and names always produce the same
 * commands.
 */
export function planFurnishings(layout: HouseLayout, roomNames?: readonly string[]): FurnishingPlan {
  const wanted = roomNames ? new Set(roomNames) : null;
  const targets: FurnishTarget[] = layout.rooms
    .filter((cell) => !wanted || wanted.has(cell.name))
    .map((cell) => ({
      name: cell.name,
      center: cell.center,
      sizeX: cell.length,
      sizeZ: cell.width,
      // The far end is the one away from the house's centre line (where the
      // spine and entrance doors are); the outer wall is the exterior one
      // (-Z for the back row and a single room).
      farIsMinX: cell.center.x <= layout.center.x,
      outerIsMinZ: cell.side !== "front"
    }));
  return placeFurniture(targets, keepOuts(layout), layout.rooms.map((cell) => cell.name));
}

/** Element kinds that are surfaces or spaces, not obstacles: furniture stands on or in them. */
const NOT_OBSTACLES = new Set(["room", "roof", "landscape", "path", "flooring", "ceiling", "foundation"]);

/**
 * Keep-outs read from the model as it is NOW: every wall's, pillar's and
 * free-standing object's footprint, each hosted door's swing zone and
 * each hosted window's zone, wherever they really are - so a moved door
 * or an added window is respected. `ignore` lists objects about to be
 * removed (the furniture being replaced).
 */
function sceneKeepOuts(snapshot: AIProjectSnapshot, ignore: ReadonlySet<string>): KeepOuts {
  const geometry = analyzeConstructionGeometry(snapshot);
  const byId = new Map(snapshot.objects.map((object) => [object.id, object]));
  const always: PlanRect[] = [];
  const tallOnly: PlanRect[] = [];
  for (const entry of geometry.objects) {
    const object = byId.get(entry.id);
    if (!object || ignore.has(object.id)) continue;
    const { min, max } = entry.aabb;
    const footprint: PlanRect = { x0: min.x, x1: max.x, z0: min.z, z1: max.z };
    if (object.type === "door" || object.type === "window") {
      const wall = object.hostId ? byId.get(object.hostId) : undefined;
      if (!wall) {
        always.push(footprint);
        continue;
      }
      const { along, normal } = wallAxes(wall.rotation);
      const isDoor = object.type === "door";
      const halfAlong = (object.dimensions.width ?? 0) / 2 + (isDoor ? DOOR_CLEAR_HALF - DOOR.width / 2 : WINDOW_CLEAR_HALF - WINDOW.width / 2);
      const halfNormal = (wall.dimensions.thickness ?? WALL_THICKNESS) / 2 + (isDoor ? DOOR_CLEAR_DEPTH : WINDOW_CLEAR_DEPTH);
      const extentX = Math.abs(along.x) * halfAlong + Math.abs(normal.x) * halfNormal;
      const extentZ = Math.abs(along.z) * halfAlong + Math.abs(normal.z) * halfNormal;
      (isDoor ? always : tallOnly).push({
        x0: object.position.x - extentX,
        x1: object.position.x + extentX,
        z0: object.position.z - extentZ,
        z1: object.position.z + extentZ
      });
      continue;
    }
    if (object.type === "slab" || object.type === "beam") continue;
    if (object.type === "element" && object.kind && NOT_OBSTACLES.has(object.kind)) continue;
    // Overhead (a ceiling light) or flat on the floor (a rug) - nothing to walk around.
    if (min.y >= 2 || max.y <= SLAB_THICKNESS + 0.05) continue;
    always.push(footprint);
  }
  return { always, tallOnly };
}

/**
 * Plans furniture for real room elements in the current model (`roomIds`
 * are room element ids). With `replace`, the furniture already inside
 * those rooms is what gets replaced (listed in `replaced`, and not an
 * obstacle); without it, that furniture stays and is planned around.
 * Everything else is a keep-out where it really stands. Rooms that
 * aren't axis-aligned are skipped. `byRoom` is keyed by room name.
 */
export function planFurnishingsInScene(
  snapshot: AIProjectSnapshot,
  roomIds: readonly string[],
  /** `variant` 1-3 mirrors the arrangement (1: end to end, 2: wall to wall, 3: both) - what "refurnish" uses to offer a different layout of the same room. */
  options: { replace?: boolean; variant?: number } = {}
): FurnishingPlan & { replaced: string[] } {
  const flipEnds = ((options.variant ?? 0) & 1) === 1;
  const flipWalls = ((options.variant ?? 0) & 2) === 2;
  const rooms = listRooms(snapshot);
  const targets: FurnishTarget[] = [];
  const replaced: string[] = [];
  for (const id of roomIds) {
    const room = rooms.find((candidate) => candidate.id === id);
    if (!room) continue;
    const model = describeRoom(snapshot, room);
    if (options.replace) replaced.push(...model.furniture.map((object) => object.id));
    const exterior = (side: string) => model.walls.some((wall) => wall.side === side && wall.exterior);
    // The quiet end is the one with fewer doors.
    const doorsAt = (sign: number) =>
      model.openings.filter((opening) => opening.object.type === "door" && Math.sign(Math.round((opening.object.position.x - room.center.x) * 100)) === sign).length;
    targets.push({
      name: room.name,
      center: room.center,
      sizeX: room.sizeX,
      sizeZ: room.sizeZ,
      farIsMinX: (doorsAt(-1) <= doorsAt(1)) !== flipEnds,
      outerIsMinZ: (exterior("back") || !exterior("front")) !== flipWalls
    });
  }
  const plan = placeFurniture(targets, sceneKeepOuts(snapshot, new Set(replaced)), rooms.map((room) => room.name));
  return { ...plan, replaced };
}

function placeFurniture(targets: readonly FurnishTarget[], zones: KeepOuts, allNames: readonly string[]): FurnishingPlan {
  const commands: AddAssetCommand[] = [];
  const byRoom = new Map<string, number[]>();
  let skipped = 0;

  for (const target of targets) {
    const L = target.sizeX;
    const W = target.sizeZ;
    const xMin = target.center.x - L / 2;
    const xMax = target.center.x + L / 2;
    const zMin = target.center.z - W / 2;
    const zMax = target.center.z + W / 2;
    const { farIsMinX, outerIsMinZ } = target;
    const room: RoomFrame = { L, W };
    const bounds: PlanRect = { x0: xMin, x1: xMax, z0: zMin, z1: zMax };

    const placed = new Map<string, PlacedPiece>();
    const indices: number[] = [];
    for (const spec of piecesFor(target.name, allNames)) {
      const catalog = size(spec.assetId);
      const { height, depth } = catalog;
      let chosen: PlacedPiece | null = null;
      for (const width of spec.widths ?? [catalog.width]) {
        for (const candidate of spec.candidates(room, placed, width)) {
          const sideways = isSide(candidate.back);
          const halfX = (sideways ? depth : width) / 2;
          const halfZ = (sideways ? width : depth) / 2;
          const x = farIsMinX ? xMin + candidate.u : xMax - candidate.u;
          const z = outerIsMinZ ? zMin + candidate.v : zMax - candidate.v;
          const rect: PlanRect = { x0: x - halfX, x1: x + halfX, z0: z - halfZ, z1: z + halfZ };
          const inside = rect.x0 >= bounds.x0 - EPSILON && rect.x1 <= bounds.x1 + EPSILON && rect.z0 >= bounds.z0 - EPSILON && rect.z1 <= bounds.z1 + EPSILON;
          if (!inside) continue;
          if (zones.always.some((zone) => overlaps(rect, zone))) continue;
          if (height > TALL && zones.tallOnly.some((zone) => overlaps(rect, zone))) continue;
          if (!spec.flat && [...placed.values()].some((other) => !other.flat && overlaps(rect, other.rect))) continue;
          chosen = { candidate, width, rect, flat: !!spec.flat };
          break;
        }
        if (chosen) break;
      }
      if (!chosen) {
        skipped += 1;
        continue;
      }
      placed.set(spec.key, chosen);
      const { candidate } = chosen;
      let rotation: number;
      if (isSide(candidate.back)) {
        // Back toward -X is π/2; toward +X, -π/2.
        rotation = (candidate.back === "far") === farIsMinX ? Math.PI / 2 : -Math.PI / 2;
      } else {
        // Back toward -Z is 0; toward +Z, π.
        rotation = (candidate.back === "outer") === outerIsMinZ ? 0 : Math.PI;
      }
      indices.push(commands.length);
      commands.push({
        type: "asset.add",
        asset: {
          assetId: spec.assetId,
          position: { x: clean((chosen.rect.x0 + chosen.rect.x1) / 2), y: clean(SLAB_THICKNESS + height / 2), z: clean((chosen.rect.z0 + chosen.rect.z1) / 2) },
          rotation: clean(rotation),
          ...(chosen.width !== catalog.width ? { dimensions: { width: chosen.width } } : {})
        }
      });
    }
    byRoom.set(target.name, indices);
  }
  return { commands, byRoom, skipped };
}
