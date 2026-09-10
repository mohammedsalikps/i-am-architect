import type { Vector3Data } from "../objects/types";
import type { WindowData } from "./types";

export interface CreateWindowOptions {
  position?: Partial<Vector3Data>;
  rotation?: number;
  width?: number;
  height?: number;
  thickness?: number;
  material?: string;
  color?: string;
  /** The wall hosting this window, if any - see engine/openings/hostOpening.ts. */
  hostId?: string | null;
}

const DEFAULTS = {
  width: 1.2,
  height: 1.2,
  thickness: 0.05,
  material: "generic",
  color: "#7ec8e3" // a glass-like light blue, distinct from every sibling type's grey/neutral default
} as const;

let nextId = 1;

/** Makes new window ids come after `ids` - the same rule as createWall.ts's reserveWallIds(). */
export function reserveWindowIds(ids: Iterable<string>): void {
  for (const id of ids) {
    const match = /^window-(\d+)$/.exec(id);
    if (match) {
      nextId = Math.max(nextId, Number(match[1]) + 1);
    }
  }
}

/**
 * Creates a new window with sensible defaults - mirrors
 * door/createDoor.ts's createDoorData() and the other sibling object
 * types' equivalents exactly. The base always rests on the ground
 * (y = height / 2) unless a full position is supplied. Options stay
 * flat (width/height/thickness) for a simple call site - only the
 * stored WindowData nests them under `dimensions`.
 */
export function createWindowData(options: CreateWindowOptions = {}): WindowData {
  const height = options.height ?? DEFAULTS.height;
  const position: Vector3Data = { x: 0, y: height / 2, z: 0, ...options.position };

  const windowData: WindowData = {
    id: `window-${nextId++}`,
    type: "window",
    position,
    rotation: options.rotation ?? 0,
    dimensions: {
      width: options.width ?? DEFAULTS.width,
      height,
      thickness: options.thickness ?? DEFAULTS.thickness
    },
    material: options.material ?? DEFAULTS.material,
    color: options.color ?? DEFAULTS.color,
    assemblyId: null,
    hostId: options.hostId ?? null
  };

  return windowData;
}

/** World-space offset applied to a duplicate so it never sits exactly on top of the original - same value the sibling object types use. */
const DUPLICATE_OFFSET = 0.75;

/**
 * Creates an independent copy of a window: same dimensions, material,
 * color and rotation, a fresh unique id (via createWindowData's own
 * counter), and a small position offset so the two don't overlap. The
 * offset takes it off its wall's face, so the copy isn't hosted.
 */
export function duplicateWindowData(windowData: WindowData): WindowData {
  return createWindowData({
    position: {
      x: windowData.position.x + DUPLICATE_OFFSET,
      y: windowData.position.y,
      z: windowData.position.z + DUPLICATE_OFFSET
    },
    rotation: windowData.rotation,
    width: windowData.dimensions.width,
    height: windowData.dimensions.height,
    thickness: windowData.dimensions.thickness,
    material: windowData.material,
    color: windowData.color
  });
}
