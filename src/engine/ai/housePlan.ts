import type {
  AddDoorCommand,
  AddPillarCommand,
  AddSlabCommand,
  AddWallCommand,
  AddWindowCommand,
  Command
} from "../commands/types";

/**
 * The deterministic construction plan for a simple house: the reference
 * layout MockAIProvider returns for a house instruction, and the one the
 * OpenAI system prompt describes (providers/OpenAIProvider.ts). It is
 * plain command data - the same `<type>.add` commands the ribbon and the
 * AI already issue - and CommandExecutor executes it like any other
 * commands. Nothing here touches a store, a mesh, or history.
 *
 * Coordinates are the engine's own: world X/Y/Z in meters, +Y up,
 * `position` is the center of the object's box, `rotation` is radians
 * around Y, and "front" is +Z (the Front view's camera side). On an
 * L x W footprint (L along X, W along Z), centered on `center`:
 *
 * - slab: L x W, 0.2 m thick, on the ground, so its top is at y = 0.2
 * - 4 corner pillars, 0.4 x 0.4, standing on the slab, flush with its corners
 * - 4 perimeter walls, 0.2 m thick, standing on the slab between the
 *   pillars with their outer faces flush with the slab's edges; the front
 *   and back walls run along X, and the left and right walls are turned
 *   90 degrees to run along Z
 * - 1 door on the outside face of the front (+Z) wall, centered
 * - 2 windows with a 0.9 m sill, on the outside faces of the back (-Z)
 *   and right (+X) walls
 *
 * Parts meet face to face and no two boxes share any volume, so the
 * geometry analysis finds no overlapping pair. Doors and windows sit on
 * the walls' outside faces rather than inside them, because the engine
 * has no wall hosting (openings aren't cut into walls).
 */

export interface HouseFootprint {
  /** Along X, in meters. */
  length: number;
  /** Along Z, in meters. */
  width: number;
}

export interface HousePlanOptions extends HouseFootprint {
  /** Plan-view center of the footprint. Defaults to the origin. */
  center?: { x: number; z: number };
}

/** The footprint used when an instruction doesn't give one. */
export const DEFAULT_HOUSE_FOOTPRINT: HouseFootprint = { length: 10, width: 8 };

/** Accepted footprint sides, in meters. Below 4 m the door and windows no longer fit their walls. */
export const HOUSE_FOOTPRINT_LIMITS = { min: 4, max: 40 } as const;

const SLAB_THICKNESS = 0.2;
const WALL_HEIGHT = 2.7;
const WALL_THICKNESS = 0.2;
const PILLAR_SIZE = 0.4;
const DOOR = { width: 0.9, height: 2.1, thickness: 0.05 };
const WINDOW = { width: 1.2, height: 1.2, thickness: 0.05 };
const WINDOW_SILL = 0.9;
const QUARTER_TURN = Math.PI / 2;

/** Gap kept, in plan, between a house and existing objects when it has to move aside. */
const SITE_CLEARANCE = 1;
/** How far the plan reaches past its footprint: doors and windows sit on the walls' outside faces. */
const OPENING_REACH = Math.max(DOOR.thickness, WINDOW.thickness);

/** Strips floating-point noise so every coordinate is a clean decimal (e.g. 5 - 0.1 is exactly 4.9). */
function clean(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/** The plan's commands, in build order: slab, walls, pillars, door, windows. */
export function buildSimpleHousePlan(options: HousePlanOptions): Command[] {
  const { length, width } = options;
  const centerX = options.center?.x ?? 0;
  const centerZ = options.center?.z ?? 0;
  const at = (x: number, y: number, z: number) => ({ x: clean(centerX + x), y: clean(y), z: clean(centerZ + z) });

  const floor = SLAB_THICKNESS; // the slab's top
  const standingY = floor + WALL_HEIGHT / 2;
  const halfLength = length / 2;
  const halfWidth = width / 2;

  const slab: AddSlabCommand = {
    type: "slab.add",
    slab: { length, width, thickness: SLAB_THICKNESS, rotation: 0, position: at(0, SLAB_THICKNESS / 2, 0) }
  };

  const wall = (x: number, z: number, wallLength: number, rotation: number): AddWallCommand => ({
    type: "wall.add",
    wall: { length: clean(wallLength), height: WALL_HEIGHT, thickness: WALL_THICKNESS, rotation, position: at(x, standingY, z) }
  });
  const alongX = length - 2 * PILLAR_SIZE;
  const alongZ = width - 2 * PILLAR_SIZE;
  const wallX = halfLength - WALL_THICKNESS / 2;
  const wallZ = halfWidth - WALL_THICKNESS / 2;
  const walls = [
    wall(0, wallZ, alongX, 0), // front
    wall(0, -wallZ, alongX, 0), // back
    wall(-wallX, 0, alongZ, QUARTER_TURN), // left
    wall(wallX, 0, alongZ, QUARTER_TURN) // right
  ];

  const pillarX = halfLength - PILLAR_SIZE / 2;
  const pillarZ = halfWidth - PILLAR_SIZE / 2;
  const pillars: AddPillarCommand[] = [
    [-1, -1], // back left
    [1, -1], // back right
    [1, 1], // front right
    [-1, 1] // front left
  ].map(([signX, signZ]) => ({
    type: "pillar.add",
    pillar: {
      width: PILLAR_SIZE,
      depth: PILLAR_SIZE,
      height: WALL_HEIGHT,
      rotation: 0,
      position: at(signX * pillarX, standingY, signZ * pillarZ)
    }
  }));

  const door: AddDoorCommand = {
    type: "door.add",
    door: { ...DOOR, rotation: 0, position: at(0, floor + DOOR.height / 2, halfWidth + DOOR.thickness / 2) }
  };

  const windowY = floor + WINDOW_SILL + WINDOW.height / 2;
  const windows: AddWindowCommand[] = [
    {
      type: "window.add",
      window: { ...WINDOW, rotation: 0, position: at(-length / 4, windowY, -(halfWidth + WINDOW.thickness / 2)) }
    },
    {
      type: "window.add",
      window: { ...WINDOW, rotation: QUARTER_TURN, position: at(halfLength + WINDOW.thickness / 2, windowY, -width / 4) }
    }
  ];

  return [slab, ...walls, ...pillars, door, ...windows];
}

/** A plan-view box, e.g. an object's `aabb` from the geometry analysis. Only X and Z are read. */
export interface PlanBox {
  min: { x: number; z: number };
  max: { x: number; z: number };
}

/**
 * Where to center a house so it doesn't land on anything: the origin if
 * the plan fits there, otherwise just past the largest X any existing
 * object reaches, with SITE_CLEARANCE to spare, on the next half meter.
 * `occupied` is typically every object's `aabb` from the context's
 * geometry section. Boxes that only touch the plan don't count, the same
 * rule the geometry analysis uses.
 */
export function findHouseCenter(footprint: HouseFootprint, occupied: readonly PlanBox[]): { x: number; z: number } {
  const reachX = footprint.length / 2 + OPENING_REACH;
  const reachZ = footprint.width / 2 + OPENING_REACH;
  const blocked = occupied.some(
    (box) => box.min.x < reachX && box.max.x > -reachX && box.min.z < reachZ && box.max.z > -reachZ
  );
  if (!blocked) {
    return { x: 0, z: 0 };
  }

  const farthestX = Math.max(...occupied.map((box) => box.max.x));
  return { x: Math.ceil((farthestX + SITE_CLEARANCE + reachX) * 2) / 2, z: 0 };
}
