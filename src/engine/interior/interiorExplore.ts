// Explicit .ts extensions on value imports let Node run this file directly
// (engine/interior/verify.ts does). Harmless for Vite.
import { isRoom } from "../elements/rooms.ts";
import type { ElementData } from "../elements/types";

/**
 * Interior Explore: walking through the rooms of the current project at a
 * person's eye height. Everything here is a VIEW of the model - it reads
 * the rooms, floors and objects, and changes only which objects are drawn
 * (through the same VisibilityStore as the hierarchy's eye buttons), never
 * the model, its undo history or the saved document. Pure apart from the
 * session's calls on the visibility and selection stores it is given.
 *
 * Plan coordinates as everywhere else: X east, Z south, metres. A room's
 * "local" frame is its own axes - the same transform as rooms.ts's
 * isInsideRoom(), so "inside" means the same thing here as there.
 */

/** A person's eye, above the floor they stand on, metres. */
export const EYE_HEIGHT = 1.6;
/** How close the eye may come to a room's edge (its walls), metres - never into a wall. */
export const WALL_CLEARANCE = 0.35;
/** The view's initial downward tilt, radians (about 10°) - the floor and furniture in view, not just the far wall. */
export const INITIAL_PITCH = -0.18;
/** How far the look may tilt up or down, radians (about 70°). */
export const PITCH_LIMIT = 1.2;

export interface InteriorRoom {
  id: string;
  name: string;
  center: { x: number; z: number };
  /** The room's own turn about Y, radians. */
  rotation: number;
  /** Half the room's own length (local X) and width (local Z), metres. */
  halfLength: number;
  halfWidth: number;
  /** Its size as it lies in the plan: east-west and north-south, metres. */
  planX: number;
  planZ: number;
  /** The floor a person stands on: the room's base, or the top of a slab under it. */
  floorY: number;
  height: number;
}

/** Where the eye is and which way it looks: yaw about Y (0 looks south, +Z), pitch up (+) or down (-). */
export interface InteriorViewpoint {
  position: { x: number; y: number; z: number };
  yaw: number;
  pitch: number;
}

/** A slab as Interior Explore needs it - a floor someone may stand on. */
export interface FloorSlab {
  position: { x: number; y: number; z: number };
  rotation: number;
  dimensions: { length: number; width: number; thickness: number };
}

function toLocal(origin: { x: number; z: number }, rotation: number, point: { x: number; z: number }): { x: number; z: number } {
  const dx = point.x - origin.x;
  const dz = point.z - origin.z;
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  return { x: dx * cos - dz * sin, z: dx * sin + dz * cos };
}

function toWorld(origin: { x: number; z: number }, rotation: number, local: { x: number; z: number }): { x: number; z: number } {
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  return { x: origin.x + local.x * cos + local.z * sin, z: origin.z - local.x * sin + local.z * cos };
}

const round = (value: number): number => Math.round(value * 1000) / 1000;

/** The floor under a room's centre: its own base, raised to the top of a slab it stands on (a house's rooms sit on its floor slab). */
export function floorUnder(room: ElementData, slabs: readonly FloorSlab[]): number {
  const base = room.position.y - room.dimensions.height / 2;
  let floor = base;
  for (const slab of slabs) {
    const local = toLocal(slab.position, slab.rotation, room.position);
    if (Math.abs(local.x) > slab.dimensions.length / 2 || Math.abs(local.z) > slab.dimensions.width / 2) continue;
    const top = slab.position.y + slab.dimensions.thickness / 2;
    // A floor slab around the room's base - not a slab far below, nor one overhead.
    if (top >= base - 0.5 && top <= base + 0.6) floor = Math.max(floor, top);
  }
  return round(floor);
}

/** The project's rooms, as found in it now - any number, any names, in the model's own order. */
export function interiorRooms(elements: readonly ElementData[], slabs: readonly FloorSlab[]): InteriorRoom[] {
  return elements.filter(isRoom).map((room) => {
    const turns = Math.round(room.rotation / (Math.PI / 2));
    const quarter = Math.abs(room.rotation - turns * (Math.PI / 2)) < 0.02 && Math.abs(turns) % 2 === 1;
    return {
      id: room.id,
      name: room.label || room.id,
      center: { x: room.position.x, z: room.position.z },
      rotation: room.rotation,
      halfLength: room.dimensions.length / 2,
      halfWidth: room.dimensions.width / 2,
      planX: quarter ? room.dimensions.width : room.dimensions.length,
      planZ: quarter ? room.dimensions.length : room.dimensions.width,
      floorY: floorUnder(room, slabs),
      height: room.dimensions.height
    };
  });
}

/** `point` brought inside the room, WALL_CLEARANCE from its edges (to the centre line in a room narrower than twice that). */
export function clampToRoom(point: { x: number; z: number }, room: InteriorRoom): { x: number; z: number } {
  const local = toLocal(room.center, room.rotation, point);
  const reachX = Math.max(0, room.halfLength - WALL_CLEARANCE);
  const reachZ = Math.max(0, room.halfWidth - WALL_CLEARANCE);
  const clamped = { x: Math.min(reachX, Math.max(-reachX, local.x)), z: Math.min(reachZ, Math.max(-reachZ, local.z)) };
  const world = toWorld(room.center, room.rotation, clamped);
  return { x: round(world.x), z: round(world.z) };
}

/**
 * Where to stand on entering a room: eye height above its floor, in one
 * corner (its own south-west, 0.6 m in - less in a small room), looking
 * across to the opposite corner and slightly down, so the floor, the far
 * walls, their openings and the furniture are all in view.
 */
export function roomViewpoint(room: InteriorRoom): InteriorViewpoint {
  const insetX = Math.min(Math.max(WALL_CLEARANCE, Math.min(0.6, room.halfLength * 0.4)), room.halfLength);
  const insetZ = Math.min(Math.max(WALL_CLEARANCE, Math.min(0.6, room.halfWidth * 0.4)), room.halfWidth);
  const stand = clampToRoom(toWorld(room.center, room.rotation, { x: -room.halfLength + insetX, z: room.halfWidth - insetZ }), room);
  const across = toWorld(room.center, room.rotation, { x: room.halfLength - insetX, z: -room.halfWidth + insetZ });
  const dx = across.x - stand.x;
  const dz = across.z - stand.z;
  // A room too small to have a corner to stand in: look along its length from the middle.
  const yaw = Math.hypot(dx, dz) > 1e-6 ? Math.atan2(dx, dz) : room.rotation + Math.PI / 2;
  return { position: { x: stand.x, y: round(room.floorY + EYE_HEIGHT), z: stand.z }, yaw, pitch: INITIAL_PITCH };
}

/** The unit direction a view looks along. */
export function lookDirection(view: { yaw: number; pitch: number }): { x: number; y: number; z: number } {
  const flat = Math.cos(view.pitch);
  return { x: Math.sin(view.yaw) * flat, y: Math.sin(view.pitch), z: Math.cos(view.yaw) * flat };
}

/**
 * One step of walking: `forward` metres along the level look direction and
 * `sideways` metres to its right, kept inside the room at eye height - the
 * camera never leaves the room, sinks into the floor or rises off it.
 */
export function walk(view: InteriorViewpoint, forward: number, sideways: number, room: InteriorRoom): InteriorViewpoint {
  const fx = Math.sin(view.yaw);
  const fz = Math.cos(view.yaw);
  // Right of the level look direction: (fx, fz) turned a quarter clockwise seen from above.
  const rx = -fz;
  const rz = fx;
  const next = clampToRoom({ x: view.position.x + fx * forward + rx * sideways, z: view.position.z + fz * forward + rz * sideways }, room);
  return { ...view, position: { x: next.x, y: round(room.floorY + EYE_HEIGHT), z: next.z } };
}

/** A look turned by `yaw` and tilted by `pitch` radians - the tilt held within PITCH_LIMIT. */
export function turn(view: InteriorViewpoint, yaw: number, pitch: number): InteriorViewpoint {
  return { ...view, yaw: view.yaw + yaw, pitch: Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, view.pitch + pitch)) };
}

/** "north-east" - the compass direction of a look (north is -Z). */
export function facing(yaw: number): string {
  const bearing = ((Math.atan2(Math.sin(yaw), -Math.cos(yaw)) * 180) / Math.PI + 360) % 360;
  const names = ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"];
  return names[Math.round(bearing / 45) % 8];
}

/** An object as the session needs it: where it is and what it is. */
export interface ExploreObject {
  id: string;
  type: string;
  kind?: string;
  position: { x: number; y: number; z: number };
}

/** What the session changes, and only this: which objects are drawn, and the selection. */
export interface ExploreVisibility {
  getHidden(): ReadonlySet<string>;
  setHidden(id: string, hidden: boolean): void;
}
export interface ExploreSelection {
  get(): string | null;
  select(id: string): void;
  clear(): void;
}

export interface InteriorExploreSources {
  elements(): readonly ElementData[];
  slabs(): readonly FloorSlab[];
  objects(): readonly ExploreObject[];
  visibility: ExploreVisibility;
  selection: ExploreSelection;
}

/**
 * Entering, moving between rooms and leaving. On entering: the selection
 * is set aside (no handles, nothing picked by accident) and every roof is
 * hidden - from inside, a roof is a lid that hides the room and its light.
 * In a room: its own walls, doors, windows, floor and furniture are drawn
 * even if they had been hidden. On leaving: every object it touched gets
 * its earlier visibility back, and the selection returns. Rooms, walls,
 * openings and furniture are never changed - only whether they're drawn.
 */
export class InteriorExploreSession {
  private readonly sources: InteriorExploreSources;
  private hiddenBefore: Set<string> | null = null;
  private readonly touched = new Set<string>();
  private selectionBefore: string | null = null;
  private roomId: string | null = null;

  constructor(sources: InteriorExploreSources) {
    this.sources = sources;
  }

  isActive(): boolean {
    return this.hiddenBefore !== null;
  }

  currentRoomId(): string | null {
    return this.roomId;
  }

  rooms(): InteriorRoom[] {
    return interiorRooms(this.sources.elements(), this.sources.slabs());
  }

  /** Starts exploring. With no rooms in the project, changes nothing and says why. */
  enter(): { ok: true; rooms: InteriorRoom[] } | { ok: false; message: string } {
    const rooms = this.rooms();
    if (rooms.length === 0) {
      return { ok: false, message: "There are no rooms to explore yet. Build a house, or create a room (“Create a 4 by 5 metre kitchen at 0, 0”), then explore it." };
    }
    if (!this.isActive()) {
      this.hiddenBefore = new Set(this.sources.visibility.getHidden());
      this.selectionBefore = this.sources.selection.get();
      this.sources.selection.clear();
    }
    this.apply(null);
    return { ok: true, rooms };
  }

  /** Into a room: its viewpoint, and its contents drawn. Null (nothing changed) for a room that isn't in the project. */
  goTo(roomId: string): { room: InteriorRoom; viewpoint: InteriorViewpoint } | null {
    if (!this.isActive()) return null;
    const room = this.rooms().find((entry) => entry.id === roomId);
    if (!room) return null;
    this.roomId = room.id;
    this.apply(room);
    return { room, viewpoint: roomViewpoint(room) };
  }

  /** The current room as the project has it now - null once it is gone. */
  currentRoom(): InteriorRoom | null {
    return this.roomId ? (this.rooms().find((entry) => entry.id === this.roomId) ?? null) : null;
  }

  /** Back to the ordinary view: every touched object's visibility as it was, and the selection. */
  exit(): void {
    if (!this.hiddenBefore) return;
    const before = this.hiddenBefore;
    for (const id of this.touched) this.sources.visibility.setHidden(id, before.has(id));
    this.touched.clear();
    this.hiddenBefore = null;
    this.roomId = null;
    const selected = this.selectionBefore;
    this.selectionBefore = null;
    if (selected && this.sources.objects().some((object) => object.id === selected)) this.sources.selection.select(selected);
  }

  /** Every roof hidden; the room's own contents (walls on its edges, openings in them, its furniture and fittings) drawn. */
  private apply(room: InteriorRoom | null): void {
    const before = this.hiddenBefore!;
    const objects = this.sources.objects();
    const roofs = objects.filter((object) => object.kind === "roof").map((object) => object.id);
    const keep = new Set<string>();
    if (room) {
      for (const object of objects) {
        if (object.kind === "roof" || (object.kind === "room" && object.id !== room.id)) continue;
        const local = toLocal(room.center, room.rotation, object.position);
        // Walls stand on the room's edges, openings in them: a wall's thickness of reach beyond the floor.
        if (Math.abs(local.x) <= room.halfLength + WALL_CLEARANCE && Math.abs(local.z) <= room.halfWidth + WALL_CLEARANCE) keep.add(object.id);
      }
    }
    const want = new Set([...before, ...roofs].filter((id) => !keep.has(id)));
    const current = this.sources.visibility.getHidden();
    // Only the roofs, this room's contents and what it already changed - an eye button
    // pressed meanwhile on anything else is the person's, and stays as they set it.
    for (const id of new Set([...roofs, ...keep, ...this.touched])) {
      const hide = want.has(id);
      if (current.has(id) !== hide) {
        this.sources.visibility.setHidden(id, hide);
        this.touched.add(id);
      }
    }
  }
}
