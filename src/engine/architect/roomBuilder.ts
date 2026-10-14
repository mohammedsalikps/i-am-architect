import type { AIContextObject, AIProjectSnapshot } from "../ai/types.ts";
import type { AddElementCommand, AddWallCommand } from "../commands/types";
import { readDistance, readLocation } from "./parseUtterance.ts";
import type { LocationRef } from "./parseUtterance.ts";
import { describeRoom as describeRoomInScene, listRooms } from "./roomModel.ts";
import type { RoomInfo, Side } from "./roomModel.ts";
import { WALL_MATERIALS, readWallMaterial, wallMaterial } from "./wallBuilder.ts";

/**
 * One room, built by conversation: "Create a 4 m by 5 m kitchen, 3 m high".
 * The EAVARA Architect asks for whatever wasn't said - the room's name,
 * size, ceiling height, floor, walls and placement - shows the result as a
 * preview in the 3D scene, and only then builds it: the room zone (an
 * "element" of kind "room") plus its enclosing walls, as one undoable
 * batch through the existing commands. Plain data and geometry here; the
 * session owns the turns, the scene reads and the commands.
 *
 * Conventions, stated to the user in every preview: a room's length runs
 * east-west (X) and its width north-south (Z), measured to the walls'
 * centrelines - the same convention as the house planner, so the record
 * book's room area reads the same either way. Only the ground floor can be
 * built: this model has no storeys.
 */

export type RoomFloor = "ground";
/** A masonry library id, or "none" for a room marked out without walls. */
export type RoomWalls = string;

export type RoomPlacement =
  | { kind: "location"; location: LocationRef }
  | { kind: "beside"; roomId: string; roomName: string; side?: Side };

export interface RoomDraft {
  name?: string;
  /** Metres along X (east-west), to wall centrelines. */
  length?: number;
  /** Metres along Z (north-south), to wall centrelines. */
  width?: number;
  /** Ceiling height, metres. */
  height?: number;
  floor?: RoomFloor;
  walls?: RoomWalls;
  /** Wall thickness, metres - the material's typical value unless the user says otherwise. */
  wallThickness?: number;
  placement?: RoomPlacement;
}

export type RoomSlot = "name" | "length" | "width" | "height" | "floor" | "walls" | "placement";
export const ROOM_SLOTS: readonly RoomSlot[] = ["name", "length", "width", "height", "floor", "walls", "placement"];

export const ROOM_LIMITS = { length: { min: 1.5, max: 30 }, width: { min: 1.5, max: 30 }, height: { min: 2, max: 6 } } as const;
const STANDARD_CEILING = 2.7;

const ROOM_NAMES: readonly { pattern: RegExp; label: string }[] = [
  { pattern: /\bmaster\s+bed\s*rooms?\b/i, label: "Master Bedroom" },
  { pattern: /\bguest\s+(?:bed\s*)?rooms?\b/i, label: "Guest Room" },
  { pattern: /\bbed\s*rooms?\b/i, label: "Bedroom" },
  { pattern: /\bliving\s+rooms?\b|\blounge\b|\bsitting\s+rooms?\b/i, label: "Living Room" },
  { pattern: /\bfamily\s+rooms?\b/i, label: "Family Room" },
  { pattern: /\bdining\s+rooms?\b/i, label: "Dining Room" },
  { pattern: /\bkitchens?\b/i, label: "Kitchen" },
  { pattern: /\bbath\s*rooms?\b|\btoilet\b|\bwc\b|\bwashroom\b/i, label: "Bathroom" },
  { pattern: /\bstud(?:y|ies)\b|\b(?:home\s+)?office\b/i, label: "Study" },
  { pattern: /\bhall(?:way)?\b|\bcorridor\b/i, label: "Hall" },
  { pattern: /\butility\s+rooms?\b|\blaundry\b/i, label: "Utility" },
  { pattern: /\bgarage\b/i, label: "Garage" },
  { pattern: /\bstore(?:room)?\b|\bstorage\b|\bpantry\b/i, label: "Store" }
];

/** "create a ... kitchen/bedroom/room" - the room words this builder answers to. */
export const ROOM_WORD = /\b(?:rooms?|bed\s*rooms?|kitchens?|bath\s*rooms?|living\s+rooms?|lounge|dining\s+rooms?|stud(?:y|ies)|office|hall(?:way)?|corridor|utility|laundry|garage|store(?:room)?|storage|pantry|toilet|washroom|wc|family\s+room|guest\s+room)\b/i;

export function readRoomName(text: string): string | undefined {
  const named = /\b(?:called|named)\s+["“]?([a-z][a-z0-9 ]{1,30}?)["”]?(?:[,.]|$)/i.exec(text);
  if (named) return named[1].trim().replace(/\b\w/g, (letter) => letter.toUpperCase());
  return ROOM_NAMES.find(({ pattern }) => pattern.test(text))?.label;
}

const UNIT = String.raw`(?:mm|millimet(?:er|re)s?|cm|centimet(?:er|re)s?|m|met(?:er|re)s?)`;
const DIST = String.raw`(?:\d+(?:\.\d+)?\s*${UNIT}|(?:half\s+(?:a\s+)?|(?:a|an|one|two|three|four|five|six|seven|eight|nine|ten|twelve|fifteen|twenty)\s+)met(?:er|re)s?)\b`;

function qualified(text: string, after: string, before: string): number | undefined {
  const trailing = new RegExp(String.raw`(${DIST})\s*(?:${after})\b`, "i").exec(text);
  if (trailing) return readDistance(trailing[1]);
  const leading = new RegExp(String.raw`\b(?:${before})\s*(?:of|is|=|:|to)?\s*(${DIST})`, "i").exec(text);
  return leading ? readDistance(leading[1]) : undefined;
}

/** Compass words or side words for "beside the living room on the east side". */
export function readRoomSide(text: string): Side | undefined {
  if (/\b(?:east|right)(?:\s+side)?\b|\bto\s+the\s+right\s+of\b/i.test(text)) return "right";
  if (/\b(?:west|left)(?:\s+side)?\b|\bto\s+the\s+left\s+of\b/i.test(text)) return "left";
  if (/\b(?:north|back|rear)(?:\s+side)?\b|\bbehind\b/i.test(text)) return "back";
  if (/\b(?:south|front)(?:\s+side)?\b|\bin\s+front\s+of\b/i.test(text)) return "front";
  return undefined;
}

export const SIDE_WORDS: Readonly<Record<Side, string>> = { right: "east", left: "west", back: "north", front: "south" };

/** "beside the living room", "next to the kitchen on the east", "north of bedroom 2". */
export function readBeside(text: string, rooms: readonly RoomInfo[]): { room: RoomInfo; side?: Side } | { unknown: string } | undefined {
  const match = /\b(?:beside|next\s+to|adjacent\s+to|alongside|against|(?:east|west|north|south)\s+of|behind|in\s+front\s+of|to\s+the\s+(?:left|right)\s+of)\s+(?:the\s+|my\s+)?([a-z0-9 ]+?)(?:\s+(?:on|to)\s+the\b.*|[,.]|$)/i.exec(text);
  if (!match) return undefined;
  const target = match[1].trim().toLowerCase();
  const room =
    rooms.find((candidate) => candidate.name.toLowerCase() === target) ??
    rooms.find((candidate) => target.includes(candidate.name.toLowerCase()) || candidate.name.toLowerCase().includes(target));
  if (!room) return { unknown: match[1].trim() };
  const side = readRoomSide(match[0].replace(match[1], " "));
  return side ? { room, side } : { room };
}

/** Everything about the room that `text` states - nothing assumed. */
export function readRoomDraft(text: string, rooms: readonly RoomInfo[]): RoomDraft & { unknownNeighbour?: string; otherFloor?: string } {
  const draft: RoomDraft & { unknownNeighbour?: string; otherFloor?: string } = {};
  const name = readRoomName(text);
  if (name) draft.name = name;

  const pair = new RegExp(String.raw`\b(\d+(?:\.\d+)?)\s*(?:m(?:et(?:er|re)s?)?)?\s*(?:x|×|by)\s*(\d+(?:\.\d+)?)\s*(?:m(?:et(?:er|re)s?)?)?\b`, "i").exec(text);
  if (pair) {
    draft.length = Number(pair[1]);
    draft.width = Number(pair[2]);
  }
  const length = qualified(text, "long|in\\s+length", "length");
  const width = qualified(text, "wide|deep|in\\s+width", "width|depth");
  const height = qualified(text, "high|tall|ceiling|in\\s+height", "height|ceiling(?:\\s+height)?");
  if (length !== undefined) draft.length = length;
  if (width !== undefined) draft.width = width;
  if (height !== undefined) draft.height = height;

  if (/\bground\s+floor\b|\bdownstairs\b/i.test(text)) draft.floor = "ground";
  const upper = /\b(first|second|third|upper|top)\s+floor\b|\bupstairs\b|\bbasement\b/i.exec(text);
  if (upper) draft.otherFloor = upper[0];

  if (/\b(?:no|without)\s+walls?\b|\bjust\s+(?:mark|the\s+area)\b|\bmark\s+(?:it\s+)?out\b/i.test(text)) draft.walls = "none";
  const material = readWallMaterial(text);
  if (material) draft.walls = material;
  const thick = /\bwalls?\b.*?(\d+(?:\.\d+)?\s*(?:mm|cm|m))\s*thick|(\d+(?:\.\d+)?\s*(?:mm|cm|m))\s*(?:thick\s+)?walls?\b/i.exec(text);
  if (thick) {
    const value = readDistance(thick[1] ?? thick[2]);
    if (value !== undefined) draft.wallThickness = value;
  }

  const beside = readBeside(text, rooms);
  if (beside && "room" in beside) draft.placement = { kind: "beside", roomId: beside.room.id, roomName: beside.room.name, ...(beside.side ? { side: beside.side } : {}) };
  else if (beside && "unknown" in beside) draft.unknownNeighbour = beside.unknown;
  else {
    const location = readLocation(text.replace(pair?.[0] ?? "\u0000", " "));
    if (location) draft.placement = { kind: "location", location };
  }
  return draft;
}

export function missingRoomSlot(draft: RoomDraft): RoomSlot | undefined {
  return ROOM_SLOTS.find((slot) => draft[slot] === undefined);
}

export function roomSizeProblem(slot: "length" | "width" | "height", value: number): string | null {
  const { min, max } = ROOM_LIMITS[slot];
  return !isFinite(value) || value < min || value > max ? `A room ${slot === "height" ? "ceiling height" : slot} must be ${min}–${max} m.` : null;
}

/** The answer to one question, from the raw words ("4.5" is metres; "standard" is a 2.7 m ceiling). */
export function readRoomSlotAnswer(slot: RoomSlot, text: string, rooms: readonly RoomInfo[]): Partial<RoomDraft> | undefined {
  const said = text.trim();
  switch (slot) {
    case "name": {
      const name = readRoomName(said) ?? (/^[a-z][a-z0-9 ]{1,30}$/i.test(said) && !/^(?:yes|no|ok|cancel)$/i.test(said) ? said.replace(/\b\w/g, (letter) => letter.toUpperCase()) : undefined);
      return name ? { name } : undefined;
    }
    case "length":
    case "width":
    case "height": {
      if (slot === "height" && /\b(?:standard|typical|usual|normal|default)\b/i.test(said)) return { height: STANDARD_CEILING };
      const value = readDistance(said) ?? (/^(?:about\s+|around\s+)?(\d+(?:\.\d+)?)\s*$/i.exec(said) ? Number(/(\d+(?:\.\d+)?)/.exec(said)![1]) : undefined);
      return value === undefined ? undefined : { [slot]: value };
    }
    case "floor":
      return /\bground\b|\bdownstairs\b|^yes\b/i.test(said) ? { floor: "ground" } : undefined;
    case "walls": {
      if (/\b(?:no|none|without)\b/i.test(said)) return { walls: "none" };
      const material = readWallMaterial(said);
      return material ? { walls: material } : undefined;
    }
    case "placement": {
      const draft = readRoomDraft(said, rooms);
      return draft.placement ? { placement: draft.placement } : undefined;
    }
  }
}

export interface RoomQuestion {
  text: string;
  choices: { label: string; say: string }[];
}

export function roomQuestion(slot: RoomSlot, draft: RoomDraft, rooms: readonly RoomInfo[]): RoomQuestion {
  const what = draft.name ? `the ${draft.name.toLowerCase()}` : "the room";
  switch (slot) {
    case "name":
      return {
        text: "What room is it?",
        choices: ["Kitchen", "Bedroom", "Living Room", "Bathroom", "Study"].map((label) => ({ label, say: label.toLowerCase() }))
      };
    case "length":
      return { text: `How long should ${what} be east–west, in metres (to the wall centrelines)?`, choices: [3, 4, 5].map((value) => ({ label: `${value} m`, say: `${value} m` })) };
    case "width":
      return { text: `And how wide north–south, in metres?`, choices: [3, 4, 5].map((value) => ({ label: `${value} m`, say: `${value} m` })) };
    case "height":
      return {
        text: `What ceiling height? A standard storey is ${STANDARD_CEILING} m.`,
        choices: [
          { label: `${STANDARD_CEILING} m (standard)`, say: `${STANDARD_CEILING} m` },
          { label: "3 m", say: "3 m" }
        ]
      };
    case "floor":
      return { text: "Which floor? Only the ground floor can be built in this model - upper storeys aren't supported yet.", choices: [{ label: "Ground floor", say: "ground floor" }] };
    case "walls":
      return {
        text: `Should I build walls around it? ${WALL_MATERIALS.map((material) => `${material.label} (${Math.round(material.typicalThickness * 1000)} mm)`).join(", ")} - or no walls, just mark out the area.`,
        choices: [...WALL_MATERIALS.map((material) => ({ label: material.label, say: material.label.toLowerCase() })), { label: "No walls", say: "no walls" }]
      };
    case "placement":
      return {
        text: `Where should ${what} go? Say coordinates for its centre (e.g. “at 4, 2”)${rooms.length > 0 ? `, “beside the ${rooms[0].name.toLowerCase()}”` : ""}, or pick a spot in the 3D view.`,
        choices: [
          { label: "📍 Pick in the 3D view", say: "pick a location" },
          ...rooms.slice(0, 3).map((room) => ({ label: `Beside ${room.name}`, say: `beside the ${room.name.toLowerCase()}` }))
        ]
      };
  }
}

/** A complete draft's own numbers. */
export interface CompleteRoom {
  name: string;
  length: number;
  width: number;
  height: number;
  walls: RoomWalls;
  wallThickness: number;
}

export function completeRoom(draft: RoomDraft): CompleteRoom | null {
  if (!draft.name || draft.length === undefined || draft.width === undefined || draft.height === undefined || !draft.walls) return null;
  const thickness = draft.wallThickness ?? wallMaterial(draft.walls)?.typicalThickness ?? 0.2;
  return { name: draft.name, length: draft.length, width: draft.width, height: draft.height, walls: draft.walls, wallThickness: thickness };
}

/** Where a room "beside" another goes: flush against that side, centred on it. */
export function besideCenter(neighbour: RoomInfo, side: Side, room: { length: number; width: number }): { x: number; z: number } {
  const round = (value: number) => Math.round(value * 1000) / 1000;
  switch (side) {
    case "right":
      return { x: round(neighbour.center.x + neighbour.sizeX / 2 + room.length / 2), z: neighbour.center.z };
    case "left":
      return { x: round(neighbour.center.x - neighbour.sizeX / 2 - room.length / 2), z: neighbour.center.z };
    case "front":
      return { x: neighbour.center.x, z: round(neighbour.center.z + neighbour.sizeZ / 2 + room.width / 2) };
    case "back":
      return { x: neighbour.center.x, z: round(neighbour.center.z - neighbour.sizeZ / 2 - room.width / 2) };
  }
}

export interface Box2 {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export interface SceneEntry {
  object: AIContextObject;
  box: Box2;
}

/** The edge line a side of a room sits on: "x" or "z" fixed at `at`. */
function edgeOf(center: { x: number; z: number }, room: { length: number; width: number }, side: Side): { axis: "x" | "z"; at: number; from: number; to: number } {
  switch (side) {
    case "right":
      return { axis: "x", at: center.x + room.length / 2, from: center.z - room.width / 2, to: center.z + room.width / 2 };
    case "left":
      return { axis: "x", at: center.x - room.length / 2, from: center.z - room.width / 2, to: center.z + room.width / 2 };
    case "front":
      return { axis: "z", at: center.z + room.width / 2, from: center.x - room.length / 2, to: center.x + room.length / 2 };
    case "back":
      return { axis: "z", at: center.z - room.width / 2, from: center.x - room.length / 2, to: center.x + room.length / 2 };
  }
}

/** A wall already standing along this room's `side` (covering at least half of it) - shared, not built twice. */
export function sharedWallOn(entries: readonly SceneEntry[], center: { x: number; z: number }, room: { length: number; width: number }, side: Side): AIContextObject | null {
  const edge = edgeOf(center, room, side);
  for (const { object, box } of entries) {
    if (object.type !== "wall") continue;
    const across = edge.axis === "x" ? [box.minX, box.maxX] : [box.minZ, box.maxZ];
    const along = edge.axis === "x" ? [box.minZ, box.maxZ] : [box.minX, box.maxX];
    const thin = across[1] - across[0] <= 0.6;
    const onLine = across[0] <= edge.at + 0.05 && across[1] >= edge.at - 0.05;
    const overlap = Math.min(along[1], edge.to) - Math.max(along[0], edge.from);
    if (thin && onLine && overlap >= (edge.to - edge.from) / 2) return object;
  }
  return null;
}

/** What the room's footprint would overlap - touching is fine, and so are the shared walls along its sides. */
export function roomConflicts(entries: readonly SceneEntry[], center: { x: number; z: number }, room: { length: number; width: number }, ignore: ReadonlySet<string>): AIContextObject[] {
  const tolerance = 0.05;
  const sharedOn = new Map((["front", "back", "left", "right"] as const).map((side) => [side, sharedWallOn(entries, center, room, side)]));
  // Inside a shared wall's thickness is that wall's: another room's wall butting into it there is a joint, not an overlap.
  const inset = (side: Side) => (sharedOn.get(side)?.dimensions.thickness ?? 0) / 2;
  const x0 = center.x - room.length / 2 + tolerance + inset("left");
  const x1 = center.x + room.length / 2 - tolerance - inset("right");
  const z0 = center.z - room.width / 2 + tolerance + inset("back");
  const z1 = center.z + room.width / 2 - tolerance - inset("front");
  const shared = new Set([...sharedOn.values()].map((wall) => wall?.id).filter((id): id is string => !!id));
  return entries
    .filter(({ object }) => !ignore.has(object.id) && !shared.has(object.id) && object.kind !== "landscape" && object.kind !== "path")
    // A door or window in a shared wall belongs to that wall, not to this room.
    .filter(({ object }) => !(object.hostId && shared.has(object.hostId)))
    .filter(({ box }) => box.minX < x1 && box.maxX > x0 && box.minZ < z1 && box.maxZ > z0)
    .map(({ object }) => object);
}

export interface RoomWallSpec {
  side: Side;
  center: { x: number; z: number };
  length: number;
  rotation: number;
}

/** The four enclosing walls on the room's centrelines - front/back spanning the corners, left/right between them. */
export function roomWallSpecs(center: { x: number; z: number }, room: CompleteRoom): RoomWallSpec[] {
  const t = room.wallThickness;
  const round = (value: number) => Math.round(value * 1000) / 1000;
  return [
    { side: "front", center: { x: center.x, z: round(center.z + room.width / 2) }, length: round(room.length + t), rotation: 0 },
    { side: "back", center: { x: center.x, z: round(center.z - room.width / 2) }, length: round(room.length + t), rotation: 0 },
    { side: "left", center: { x: round(center.x - room.length / 2), z: center.z }, length: round(room.width - t), rotation: Math.PI / 2 },
    { side: "right", center: { x: round(center.x + room.length / 2), z: center.z }, length: round(room.width - t), rotation: Math.PI / 2 }
  ];
}

export function roomElementCommand(center: { x: number; z: number }, room: CompleteRoom): AddElementCommand {
  return {
    type: "element.add",
    element: { kind: "room", label: room.name, position: { x: center.x, z: center.z }, dimensions: { length: room.length, width: room.width, height: room.height } }
  };
}

export function roomWallCommand(spec: RoomWallSpec, room: CompleteRoom): AddWallCommand {
  const material = wallMaterial(room.walls);
  return {
    type: "wall.add",
    wall: {
      length: spec.length,
      height: room.height,
      thickness: room.wallThickness,
      ...(material ? { material: material.id, color: material.color } : {}),
      rotation: spec.rotation,
      position: { x: spec.center.x, z: spec.center.z }
    }
  };
}

const fmt = (value: number): string => `${Number(value.toFixed(3))} m`;

/** "a 4 m × 5 m kitchen (20 m²), 3 m ceiling, 230 mm brick walls, centred at (4, 2) on the ground floor". */
export function describeRoom(room: CompleteRoom, center: { x: number; z: number }): string {
  const walls = room.walls === "none" ? "no walls (area marked out only)" : `${Math.round(room.wallThickness * 1000)} mm ${wallMaterial(room.walls)?.label.toLowerCase() ?? room.walls} walls`;
  return `a ${fmt(room.length)} × ${fmt(room.width)} ${room.name.toLowerCase()} (${Number((room.length * room.width).toFixed(2))} m² to wall centrelines), ${fmt(room.height)} ceiling, ${walls}, centred at (${center.x}, ${center.z}) on the ground floor`;
}

// --- an existing room, read back from the scene ---

/**
 * A room as the scene has it right now, with the walls along its sides
 * sorted into the ones that move with it and the ones that don't. Nothing
 * is remembered from the conversation that built it - only the room
 * element and the walls' saved positions and sizes are read - so a project
 * that was saved and reopened, or a room laid out by hand, behaves exactly
 * like a room built a moment ago.
 *
 * - `own`: a wall bordering only this room, laid out exactly where
 *   roomWallSpecs() puts that side's wall (on the side's centre line, its
 *   length matching). These are the walls a room is built with; they
 *   move, resize and change material with it.
 * - `fixed`: any other wall along a side - shared with a neighbouring
 *   room, or part of a longer wall. It stays where it is, and the room may
 *   only change in ways that keep that side on it (fixedWallProblem()).
 *
 * Sizes are in plan terms - length along X, width along Z - whichever way
 * the element itself is turned (`swapped`: its own `length` runs along Z).
 */
export interface RoomParts {
  id: string;
  name: string;
  center: { x: number; z: number };
  room: CompleteRoom;
  swapped: boolean;
  own: Partial<Record<Side, AIContextObject>>;
  fixed: { side: Side; wall: AIContextObject; neighbours: string[] }[];
}

/** How closely an own wall must sit where roomWallSpecs() would put it, metres. */
const OWN_FIT = 0.02;

/** `roomId`'s parts as the scene has them - null if it isn't a room this module can work with (missing, or turned at an angle). */
export function roomPartsOf(snapshot: AIProjectSnapshot, roomId: string): RoomParts | null {
  const info = listRooms(snapshot).find((room) => room.id === roomId);
  const element = snapshot.objects.find((object) => object.id === roomId);
  if (!info || !element) return null;
  const height = element.dimensions.height ?? 2.7;
  const own: Partial<Record<Side, AIContextObject>> = {};
  const fixed: RoomParts["fixed"] = [];
  for (const entry of describeRoomInScene(snapshot, info).walls) {
    const { wall, side } = entry;
    const thickness = wall.dimensions.thickness ?? 0.2;
    const spec = roomWallSpecs(info.center, { name: info.name, length: info.sizeX, width: info.sizeZ, height, walls: wall.material, wallThickness: thickness }).find((candidate) => candidate.side === side);
    const quarterTurns = ((Math.round(wall.rotation / (Math.PI / 2)) % 4) + 4) % 4;
    const runsAlongX = quarterTurns % 2 === 0;
    const isOwn =
      spec !== undefined &&
      entry.neighbours.length === 0 &&
      own[side] === undefined &&
      runsAlongX === (side === "front" || side === "back") &&
      Math.abs(wall.position.x - spec.center.x) <= OWN_FIT &&
      Math.abs(wall.position.z - spec.center.z) <= OWN_FIT &&
      Math.abs((wall.dimensions.length ?? 0) - spec.length) <= OWN_FIT;
    if (isOwn) own[side] = wall;
    else fixed.push({ side, wall, neighbours: entry.neighbours });
  }
  const sample = Object.values(own)[0] ?? fixed[0]?.wall;
  const turns = ((Math.round(element.rotation / (Math.PI / 2)) % 4) + 4) % 4;
  return {
    id: roomId,
    name: info.name,
    center: { ...info.center },
    room: { name: info.name, length: info.sizeX, width: info.sizeZ, height, walls: sample ? sample.material : "none", wallThickness: sample?.dimensions.thickness ?? 0.2 },
    swapped: turns % 2 === 1,
    own,
    fixed
  };
}

function joinNames(names: readonly string[]): string {
  return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * Why `parts` can't take this new centre and size without breaking a wall
 * it doesn't own - or null. A fixed wall stays where it is, so the side it
 * runs along must stay on it (same line, not running past its ends), and
 * the ceiling can't change under it.
 */
export function fixedWallProblem(parts: RoomParts, center: { x: number; z: number }, room: { length: number; width: number; height: number }): string | null {
  const name = parts.name.toLowerCase();
  for (const { side, wall, neighbours } of parts.fixed) {
    const whose =
      neighbours.length > 0
        ? `${wall.id}, which it shares with the ${joinNames(neighbours.map((neighbour) => neighbour.toLowerCase()))}`
        : `${wall.id}, which is longer than that side and isn't one of the ${name}'s own walls`;
    const lead = `The ${name}'s ${SIDE_WORDS[side]} side is ${whose}`;
    const before = edgeOf(parts.center, parts.room, side);
    const after = edgeOf(center, room, side);
    if (Math.abs(after.at - before.at) > 0.001) {
      return `${lead}, so that wall stays where it is - and this change would pull the ${name} off it, leaving it open on that side.`;
    }
    const half = (wall.dimensions.length ?? 0) / 2;
    const middle = after.axis === "x" ? wall.position.z : wall.position.x;
    const reach = (wall.dimensions.thickness ?? 0.2) / 2 + OWN_FIT;
    if (after.from < middle - half - reach || after.to > middle + half + reach) {
      return `${lead}, so that wall stays where it is - and this change would run the ${name} past its end, leaving a gap at the corner.`;
    }
    if (Math.abs(room.height - parts.room.height) > 1e-9 && Math.abs((wall.dimensions.height ?? 0) - room.height) > 1e-9) {
      return `${lead}, so its height (${fmt(wall.dimensions.height ?? 0)}) can't change with this room alone - a ${fmt(room.height)} ceiling would leave the walls uneven.`;
    }
  }
  return null;
}
