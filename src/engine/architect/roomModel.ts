// Explicit .ts extensions on value imports let Node run this file directly
// (engine/architect/verify.ts does). Harmless for Vite.
import { placementFromWorld, wallAxes } from "../openings/hostOpening.ts";
import type { AIContextObject, AIProjectSnapshot } from "../ai/types";

/**
 * The rooms of the CURRENT model, read from a snapshot - what room-aware
 * conversational edits ("add a window to the kitchen", "make the bedroom
 * wall 4 metres long") resolve against. Nothing here comes from a plan
 * or is remembered between turns: a room is a real `room` element, its
 * walls are the real walls whose geometry borders it, its doors and
 * windows are the real openings hosted in those walls inside its span.
 * So a room built by hand, by the AI Prompt, or by the architect's stages
 * all resolve the same way, and an edit made since is always seen.
 *
 * Sides are named the way the rest of the app names directions (see
 * ai/README.md, "Construction geometry analysis"), from the Front view:
 * front = +Z, back = -Z, left = -X, right = +X.
 *
 * Only axis-aligned rooms and walls are understood (rotations that are
 * multiples of 90°) - the house planner only makes those. Anything at
 * another angle is reported, not guessed at.
 */

export type Side = "front" | "back" | "left" | "right";
export const SIDES: readonly Side[] = ["back", "front", "left", "right"];

export interface PlanPointXZ {
  x: number;
  z: number;
}

export interface RoomInfo {
  id: string;
  name: string;
  center: PlanPointXZ;
  /** Extent along world X. */
  sizeX: number;
  /** Extent along world Z. */
  sizeZ: number;
}

export interface RoomWall {
  wall: AIContextObject;
  side: Side;
  /** Nothing but the outside beyond it. */
  exterior: boolean;
  /** Rooms on its other side, along this room's stretch of it. */
  neighbours: string[];
  /** This room's stretch of the wall, as offsets along the wall from its centre (see hostOpening.ts). */
  span: { from: number; to: number };
}

export interface RoomOpening {
  object: AIContextObject;
  wall: RoomWall;
  /** Along its wall from the wall's centre. */
  offset: number;
}

export interface RoomModel {
  room: RoomInfo;
  walls: RoomWall[];
  openings: RoomOpening[];
  /** Furniture standing inside the room. */
  furniture: AIContextObject[];
}

const ANGLE_TOLERANCE = 0.02;
/** How far a wall's centre line may sit from a room's edge and still border it: the planner puts room edges on interior walls' centre lines and on exterior walls' inner faces. */
const EDGE_REACH = 0.05;
/** Shorter shared stretches than this are a corner touch, not a bordering wall. */
const MIN_SHARED = 0.3;

function quarterTurns(rotation: number): number | null {
  const turns = rotation / (Math.PI / 2);
  const nearest = Math.round(turns);
  return Math.abs(turns - nearest) < ANGLE_TOLERANCE ? ((nearest % 4) + 4) % 4 : null;
}

/** Every room element in the model that this module can work with, sorted by name. Rotated (non-90°) rooms are left out. */
export function listRooms(snapshot: AIProjectSnapshot): RoomInfo[] {
  const rooms: RoomInfo[] = [];
  for (const object of snapshot.objects) {
    if (object.type !== "element" || object.kind !== "room") continue;
    const turns = quarterTurns(object.rotation);
    if (turns === null) continue;
    const length = object.dimensions.length ?? 0;
    const width = object.dimensions.width ?? 0;
    const swapped = turns % 2 === 1;
    rooms.push({
      id: object.id,
      name: object.label ?? object.id,
      center: { x: object.position.x, z: object.position.z },
      sizeX: swapped ? width : length,
      sizeZ: swapped ? length : width
    });
  }
  return rooms.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

function contains(room: RoomInfo, point: PlanPointXZ, inset = 0): boolean {
  return Math.abs(point.x - room.center.x) <= room.sizeX / 2 - inset && Math.abs(point.z - room.center.z) <= room.sizeZ / 2 - inset;
}

interface WallLine {
  wall: AIContextObject;
  /** "x": runs along X (fixed z); "z": runs along Z (fixed x). */
  runs: "x" | "z";
  /** Its fixed coordinate: z for an X-running wall, x for a Z-running one. */
  at: number;
  from: number;
  to: number;
  thickness: number;
}

function wallLines(snapshot: AIProjectSnapshot): WallLine[] {
  const lines: WallLine[] = [];
  for (const wall of snapshot.objects) {
    if (wall.type !== "wall") continue;
    const turns = quarterTurns(wall.rotation);
    if (turns === null) continue;
    const half = (wall.dimensions.length ?? 0) / 2;
    const runs = turns % 2 === 0 ? "x" : "z";
    const along = runs === "x" ? wall.position.x : wall.position.z;
    lines.push({ wall, runs, at: runs === "x" ? wall.position.z : wall.position.x, from: along - half, to: along + half, thickness: wall.dimensions.thickness ?? 0.2 });
  }
  return lines;
}

/** The side of `room` that `line` borders, with the stretch they share - or null. */
function bordering(room: RoomInfo, line: WallLine): { side: Side; from: number; to: number } | null {
  const reach = line.thickness / 2 + EDGE_REACH;
  const halfX = room.sizeX / 2;
  const halfZ = room.sizeZ / 2;
  let side: Side | null = null;
  let roomFrom: number;
  let roomTo: number;
  if (line.runs === "x") {
    if (Math.abs(line.at - (room.center.z - halfZ)) <= reach) side = "back";
    else if (Math.abs(line.at - (room.center.z + halfZ)) <= reach) side = "front";
    roomFrom = room.center.x - halfX;
    roomTo = room.center.x + halfX;
  } else {
    if (Math.abs(line.at - (room.center.x - halfX)) <= reach) side = "left";
    else if (Math.abs(line.at - (room.center.x + halfX)) <= reach) side = "right";
    roomFrom = room.center.z - halfZ;
    roomTo = room.center.z + halfZ;
  }
  if (!side) return null;
  const from = Math.max(roomFrom, line.from);
  const to = Math.min(roomTo, line.to);
  return to - from >= MIN_SHARED ? { side, from, to } : null;
}

const OPPOSITE: Readonly<Record<Side, Side>> = { front: "back", back: "front", left: "right", right: "left" };

/** A world point on `line` at coordinate `along` (x for an X-running wall, z for a Z-running one), as an offset along the wall. */
function offsetOf(line: WallLine, along: number): number {
  const point = line.runs === "x" ? { x: along, z: line.at } : { x: line.at, z: along };
  const axis = wallAxes(line.wall.rotation).along;
  return (point.x - line.wall.position.x) * axis.x + (point.z - line.wall.position.z) * axis.z;
}

function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/** Everything about one room: its bordering walls, its doors and windows, its furniture. */
export function describeRoom(snapshot: AIProjectSnapshot, room: RoomInfo): RoomModel {
  const rooms = listRooms(snapshot);
  const lines = wallLines(snapshot);
  const walls: RoomWall[] = [];
  for (const line of lines) {
    const border = bordering(room, line);
    if (!border) continue;
    const neighbours: string[] = [];
    for (const other of rooms) {
      if (other.id === room.id) continue;
      const theirs = bordering(other, line);
      if (theirs && theirs.side === OPPOSITE[border.side] && Math.min(theirs.to, border.to) - Math.max(theirs.from, border.from) >= MIN_SHARED) {
        neighbours.push(other.name);
      }
    }
    const a = round(offsetOf(line, border.from));
    const b = round(offsetOf(line, border.to));
    walls.push({ wall: line.wall, side: border.side, exterior: neighbours.length === 0, neighbours, span: { from: Math.min(a, b), to: Math.max(a, b) } });
  }
  walls.sort((a, b) => SIDES.indexOf(a.side) - SIDES.indexOf(b.side) || a.wall.id.localeCompare(b.wall.id, undefined, { numeric: true }));

  const openings: RoomOpening[] = [];
  for (const object of snapshot.objects) {
    if ((object.type !== "door" && object.type !== "window") || !object.hostId) continue;
    const roomWall = walls.find((entry) => entry.wall.id === object.hostId);
    if (!roomWall) continue;
    const size = { width: object.dimensions.width ?? 0, height: object.dimensions.height ?? 0, thickness: object.dimensions.thickness ?? 0 };
    const offset = round(placementFromWorld(hostWallOf(roomWall.wall), size, object.position).offset);
    if (offset >= roomWall.span.from - 1e-6 && offset <= roomWall.span.to + 1e-6) {
      openings.push({ object, wall: roomWall, offset });
    }
  }

  const furniture = snapshot.objects.filter((object) => object.type === "asset" && contains(room, object.position));
  return { room, walls, openings, furniture };
}

/** The HostWall shape hostOpening.ts's helpers take, from a snapshot wall. */
export function hostWallOf(wall: AIContextObject): { id: string; position: AIContextObject["position"]; rotation: number; dimensions: { length: number; height: number; thickness: number } } {
  return {
    id: wall.id,
    position: wall.position,
    rotation: wall.rotation,
    dimensions: { length: wall.dimensions.length ?? 0, height: wall.dimensions.height ?? 0, thickness: wall.dimensions.thickness ?? 0 }
  };
}

// --- resolving references in text ---

const NUMBER_WORDS: Readonly<Record<string, string>> = { one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", first: "1", second: "2", third: "3", fourth: "4" };

/** Lower-cases and spells numbers as digits, so "bedroom two" and "the second bedroom" read like "bedroom 2". */
function normalise(text: string): string {
  // Possessives and punctuation go; a full stop survives only inside a number ("2.5").
  let lower = ` ${text
    .toLowerCase()
    .replace(/[’']s\b/g, "")
    .replace(/\.(?!\d)/g, " ")
    .replace(/[^a-z0-9.\- ]+/g, " ")} `;
  lower = lower.replace(/\b(first|second|third|fourth)\s+(bed\s*room|bath\s*room)\b/g, (_m, ordinal: string, noun: string) => `${noun} ${NUMBER_WORDS[ordinal]}`);
  lower = lower.replace(/\b(one|two|three|four|five|six|seven|eight)\b/g, (word) => NUMBER_WORDS[word]);
  return lower.replace(/\s+/g, " ");
}

/** Room types people name generically, mapped to the room names they cover. */
const ROOM_TYPES: readonly { words: RegExp; plural: RegExp; matches: RegExp; label: string }[] = [
  { words: /\b(?:bed ?rooms?|master)\b/, plural: /\bbed ?rooms\b/, matches: /bed/i, label: "bedroom" },
  { words: /\b(?:bath ?rooms?|toilets?|washrooms?|wc)\b/, plural: /\bbath ?rooms\b/, matches: /bath|toilet|wc|wash/i, label: "bathroom" },
  { words: /\bkitchens?\b/, plural: /\bkitchens\b/, matches: /kitchen/i, label: "kitchen" },
  { words: /\b(?:living|lounge|sitting|family room)\b/, plural: /$^/, matches: /living|lounge|family|studio/i, label: "living room" },
  { words: /\bdining\b/, plural: /$^/, matches: /dining/i, label: "dining room" },
  { words: /\b(?:study|office)\b/, plural: /$^/, matches: /study|office/i, label: "study" }
];

export type RoomMatch =
  | { kind: "found"; rooms: RoomInfo[] }
  | { kind: "ambiguous"; options: RoomInfo[]; label: string }
  | { kind: "unknown"; name: string }
  | { kind: "none" };

/**
 * The rooms `text` refers to. An exact room name ("Bedroom 2", "bedroom
 * two") wins; then a room type - one room of that type is found, several
 * are ambiguous unless named in the plural ("the bedrooms"). `none` when
 * the text names no room at all.
 */
export function resolveRooms(rooms: readonly RoomInfo[], text: string): RoomMatch {
  const said = normalise(text);
  const exact = rooms.filter((room) => said.includes(` ${normalise(room.name).trim()} `));
  // "Bedroom 1" also contains "Bedroom" - keep only the longest names that matched.
  const longest = exact.filter((room) => !exact.some((other) => other !== room && normalise(other.name).includes(normalise(room.name).trim())));
  if (longest.length > 0) return { kind: "found", rooms: longest };

  for (const type of ROOM_TYPES) {
    if (!type.words.test(said)) continue;
    const matching = rooms.filter((room) => type.matches.test(room.name));
    if (matching.length === 0) return { kind: "unknown", name: type.label };
    if (matching.length === 1 || type.plural.test(said)) return { kind: "found", rooms: matching };
    return { kind: "ambiguous", options: matching, label: type.label };
  }
  const unnamed = /\b(?:the|my)\s+([a-z]+(?:\s+room)?)\s*$/.exec(said.trim());
  if (unnamed && /room|garage|hall|porch|garden|attic|basement|cellar|pantry|closet|laundry|utility/.test(unnamed[1])) {
    return { kind: "unknown", name: unnamed[1] };
  }
  return { kind: "none" };
}

/**
 * A side named in `text` - "the back wall", "left side", "the right one".
 * With `strict`, only a side followed by "wall" or "side" counts, so a
 * direction in the same sentence ("move it 1 m left") isn't read as a
 * wall. Compass points are not understood.
 */
export function readSide(text: string, strict = false): Side | null {
  const said = normalise(text).replace(/\b(?:front|back|rear) door\b/g, " ");
  const match = strict
    ? /\b(front|back|rear|left|right)(?:\s+hand)?\s+(?:wall|side)\b/.exec(said)
    : /\b(front|back|rear|left|right)\b(?:\s+(?:hand\s+)?(?:wall|side|one))?/.exec(said);
  if (!match) return null;
  return match[1] === "rear" ? "back" : (match[1] as Side);
}

/** Every construction object id spelled out in `text` ("wall-3", "door-12") that really exists, in order. */
export function idsIn(snapshot: AIProjectSnapshot, text: string, type?: string): AIContextObject[] {
  const found: AIContextObject[] = [];
  for (const match of text.toLowerCase().matchAll(/\b([a-z]+(?:-[a-z]+)*-\d+)\b/g)) {
    const object = snapshot.objects.find((candidate) => candidate.id === match[1] && (!type || candidate.type === type));
    if (object && !found.includes(object)) found.push(object);
  }
  return found;
}

export function sideLabel(side: Side): string {
  return `${side} wall`;
}

/** "back wall (exterior, 11.6 m)" / "right wall (shared with Kitchen, 3.7 m)". */
export function describeWall(entry: RoomWall): string {
  const length = Math.round((entry.wall.dimensions.length ?? 0) * 100) / 100;
  return `${sideLabel(entry.side)} (${entry.exterior ? "exterior" : `shared with ${entry.neighbours.join(" and ")}`}, ${length} m, ${entry.wall.id})`;
}
