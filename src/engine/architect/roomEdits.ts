// Explicit .ts extensions on value imports let Node run this file directly
// (engine/architect/verify.ts does). Harmless for Vite.
import { DOOR, WINDOW, WINDOW_SILL } from "../ai/housePlan.ts";
import { analyzeConstructionGeometry } from "../ai/geometry/analyzeConstructionGeometry.ts";
import { halfTravel, hostingProblems, placementFromWorld, wallAxes } from "../openings/hostOpening.ts";
import type { AIContextObject, AIProjectSnapshot } from "../ai/types";
import type { CommandResult } from "../commands/types";
import { getAssetDefinition } from "../assets/catalog.ts";
import { planFurnishingsInScene } from "./interiors.ts";
import type { FurnishingPlan } from "./interiors.ts";
import { describeRoom, describeWall, hostWallOf, idsIn, listRooms, readSide, resolveRooms } from "./roomModel.ts";
import type { RoomInfo, RoomModel, RoomWall, Side } from "./roomModel.ts";
import type { ArchitectChoice, ArchitectReply, ArchitectTone } from "./ArchitectSession.ts";
import type { Direction } from "./parseUtterance.ts";

/**
 * Room-aware conversational edits on the house as it stands:
 *
 *   "Add a window to the kitchen."        → a window hosted in the kitchen's exterior wall
 *   "Move the front door one metre left."  → the entrance door slid along its wall
 *   "Refurnish bedroom 2."                 → that room's furniture replaced, planned around its real doors/windows
 *   "Make the bedroom wall 4 metres long." → that wall's length changed
 *   "Show me the living room."             → the camera frames it, with the roof out of the way
 *
 * Every reference resolves against the current snapshot (roomModel.ts):
 * real room elements, the real walls that border them, the real openings
 * hosted in those walls. Nothing is invented - an id that appears in a
 * reply was read from the model. When a room, wall or opening could be
 * more than one thing, the reply is a question whose chips each name one
 * real target; nothing changes until one is chosen.
 *
 * Every edit is one batch through the shared CommandExecutor and history
 * (`run`) - one undo step - and is checked against a fresh snapshot
 * afterwards: success is reported only when the model actually changed
 * the way it was asked to. An edit that would change nothing says so and
 * runs nothing.
 */

export interface RoomEditContext {
  snapshot: () => AIProjectSnapshot;
  run: (commands: readonly unknown[]) => { ok: true; results: CommandResult[] } | { ok: false; message: string };
}

/** A typed answer to a question: when the next message names exactly one option's key, its `say` runs. */
export interface PendingOption {
  keys: string[];
  say: string;
}

export interface RoomEditResult {
  reply: ArchitectReply;
  options?: PendingOption[];
  /** Rooms furnished by this edit, and the asset ids each now holds. */
  furnished?: { room: string; ids: string[] }[];
}

/** Kept between an opening and the end of the room's stretch of a wall: half an interior wall plus a little. */
const EDGE_CLEARANCE = 0.15;
const SEARCH_STEP = 0.05;

function fmt(value: number): string {
  return String(Math.round(value * 100) / 100);
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function list(items: readonly string[]): string {
  return items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function result(text: string, tone: ArchitectTone, choices: ArchitectChoice[] = [], extra: Partial<ArchitectReply> = {}, more: Partial<RoomEditResult> = {}): RoomEditResult {
  return { reply: { text, tone, choices, ...extra }, ...more };
}

function nothingChanged(text: string, choices: ArchitectChoice[] = []): RoomEditResult {
  return result(`${text} Nothing was changed.`, "error", choices);
}

/**
 * The one room `text` is about, or a reply asking which. `say` builds the
 * full instruction for a chip that picks a given room, so every chip is a
 * complete, unambiguous command.
 */
function oneRoom(snapshot: AIProjectSnapshot, text: string, say: (room: RoomInfo) => string, allowMany = false): { rooms: RoomInfo[] } | RoomEditResult {
  const rooms = listRooms(snapshot);
  if (rooms.length === 0) {
    return result("There are no rooms in the model yet. Build a house first (e.g. “Build a 3-bedroom house”), then I can work room by room.", "info", [
      { label: "Build a 3-bedroom house", say: "Build a 3 bedroom house" }
    ]);
  }
  const chips = (options: readonly RoomInfo[]) => options.slice(0, 8).map((room) => ({ label: room.name, say: say(room) }));
  const match = resolveRooms(rooms, text);
  if (match.kind === "found") {
    if (match.rooms.length === 1 || allowMany) return { rooms: match.rooms };
    return result(`Which room — ${list(match.rooms.map((room) => room.name))}?`, "question", chips(match.rooms), {}, {
      options: match.rooms.map((room) => ({ keys: [room.name.toLowerCase()], say: say(room) }))
    });
  }
  if (match.kind === "ambiguous") {
    return result(`Which ${match.label}? There are ${match.options.length}: ${list(match.options.map((room) => room.name))}.`, "question", chips(match.options), {}, {
      options: match.options.map((room) => ({ keys: [room.name.toLowerCase()], say: say(room) }))
    });
  }
  if (match.kind === "unknown") {
    return result(`There's no ${match.name} in this house. Its rooms are ${list(rooms.map((room) => room.name))}.`, "question", chips(rooms), {}, {
      options: rooms.map((room) => ({ keys: [room.name.toLowerCase()], say: say(room) }))
    });
  }
  return result(`Which room? This house has ${list(rooms.map((room) => room.name))}.`, "question", chips(rooms), {}, {
    options: rooms.map((room) => ({ keys: [room.name.toLowerCase()], say: say(room) }))
  });
}

function isResult(value: unknown): value is RoomEditResult {
  return typeof value === "object" && value !== null && "reply" in value;
}

/** The roof elements over `rooms` - hidden while showing them, so the camera can see in. */
function roofsOver(snapshot: AIProjectSnapshot, rooms: readonly RoomInfo[]): string[] {
  const geometry = analyzeConstructionGeometry(snapshot);
  const roofs = new Set(snapshot.objects.filter((object) => object.type === "element" && object.kind === "roof").map((object) => object.id));
  return geometry.objects
    .filter(
      (entry) =>
        roofs.has(entry.id) &&
        rooms.some(
          (room) =>
            entry.aabb.min.x < room.center.x + room.sizeX / 2 &&
            entry.aabb.max.x > room.center.x - room.sizeX / 2 &&
            entry.aabb.min.z < room.center.z + room.sizeZ / 2 &&
            entry.aabb.max.z > room.center.z - room.sizeZ / 2
        )
    )
    .map((entry) => entry.id);
}

function summary(model: RoomModel): string {
  const exterior = model.walls.filter((wall) => wall.exterior).length;
  const doors = model.openings.filter((opening) => opening.object.type === "door").length;
  const windows = model.openings.filter((opening) => opening.object.type === "window").length;
  return `${model.room.name}: ${fmt(model.room.sizeX)} × ${fmt(model.room.sizeZ)} m, ${plural(exterior, "exterior wall")}, ${plural(doors, "door")}, ${plural(windows, "window")}, ${plural(model.furniture.length, "piece")} of furniture.`;
}

// --- "Show me the living room" ---

export function showRoom(ctx: RoomEditContext, text: string): RoomEditResult {
  const snapshot = ctx.snapshot();
  const found = oneRoom(snapshot, text, (room) => `Show me the ${room.name}`, true);
  if (isResult(found)) return found;
  const models = found.rooms.map((room) => describeRoom(snapshot, room));
  const hide = roofsOver(snapshot, found.rooms);
  const focusIds = [...found.rooms.map((room) => room.id), ...models.flatMap((model) => model.furniture.map((object) => object.id))];
  const lead = found.rooms.length === 1 ? "Here's the" : "Here are the";
  return result(
    `${lead} ${list(found.rooms.map((room) => room.name))}.\n${models.map(summary).join("\n")}${hide.length > 0 ? "\nI've hidden the roof so you can see inside." : ""}`,
    "info",
    [
      ...(hide.length > 0 ? [{ label: "Show the roof again", say: "Show the roof" }] : []),
      ...(found.rooms.length === 1
        ? [
            { label: `Add a window to the ${found.rooms[0].name}`, say: `Add a window to the ${found.rooms[0].name}` },
            { label: `Refurnish the ${found.rooms[0].name}`, say: `Refurnish the ${found.rooms[0].name}` }
          ]
        : [])
    ],
    { focusIds, ...(hide.length > 0 ? { hideIds: hide } : {}) }
  );
}

// --- "Add a window to the kitchen" ---

/** Which of a room's walls is meant: an id in the text, a side, or (for a window) its exterior walls. */
function pickWalls(snapshot: AIProjectSnapshot, model: RoomModel, text: string, opening: "door" | "window" | null): RoomWall[] {
  const named = idsIn(snapshot, text, "wall").map((wall) => model.walls.find((entry) => entry.wall.id === wall.id)).filter((entry): entry is RoomWall => !!entry);
  if (named.length > 0) return named;
  const side = readSide(text);
  if (side) return model.walls.filter((entry) => entry.side === side);
  if (opening === "window") return model.walls.filter((entry) => entry.exterior);
  return [...model.walls];
}

function wallChoice(model: RoomModel, entry: RoomWall, say: (wallRef: string) => string): ArchitectChoice {
  const sameSide = model.walls.filter((other) => other.side === entry.side).length > 1;
  const ref = sameSide ? entry.wall.id : `${entry.side} wall`;
  return { label: describeWall(entry), say: say(ref) };
}

/** Returns null when `text` names no room - the caller then falls back to the selected wall. */
export function addOpeningToRoom(ctx: RoomEditContext, opening: "door" | "window", text: string): RoomEditResult | null {
  const snapshot = ctx.snapshot();
  if (resolveRooms(listRooms(snapshot), text).kind === "none") return null;
  const found = oneRoom(snapshot, text, (room) => `Add a ${opening} to the ${room.name}`);
  if (isResult(found)) return found;
  const room = found.rooms[0];
  const model = describeRoom(snapshot, room);
  if (model.walls.length === 0) {
    return nothingChanged(`I can't find any walls around the ${room.name} — its walls may have been moved or deleted.`);
  }

  let walls = pickWalls(snapshot, model, text, opening);
  const side = readSide(text);
  if (walls.length === 0 && side) {
    return result(`The ${room.name} has no ${side} wall I can find. Its walls: ${list(model.walls.map(describeWall))}.`, "question", model.walls.map((entry) => wallChoice(model, entry, (ref) => `Add a ${opening} to the ${ref} of the ${room.name}`)));
  }
  if (walls.length === 0) {
    // A window, but no exterior wall: it would look into the next room.
    walls = [...model.walls];
    return result(
      `The ${room.name} has no outside wall, so a window would look into ${list([...new Set(model.walls.flatMap((entry) => entry.neighbours))])}. Which wall should it go in?`,
      "question",
      walls.map((entry) => wallChoice(model, entry, (ref) => `Add a ${opening} to the ${ref} of the ${room.name}`)),
      {},
      { options: walls.map((entry) => ({ keys: [entry.side], say: `Add a ${opening} to the ${entry.side} wall of the ${room.name}` })) }
    );
  }
  if (walls.length > 1) {
    return result(
      `Which wall of the ${room.name}? ${opening === "window" ? "It has more than one outside wall" : "It has several walls"}.`,
      "question",
      walls.map((entry) => wallChoice(model, entry, (ref) => `Add a ${opening} to the ${ref} of the ${room.name}`)),
      {},
      { options: walls.map((entry) => ({ keys: [entry.side, `${entry.side} wall`], say: `Add a ${opening} to the ${entry.side} wall of the ${room.name}` })) }
    );
  }

  const target = walls[0];
  const host = hostWallOf(target.wall);
  const standard = opening === "window" ? WINDOW : DOOR;
  const sill = opening === "window" ? WINDOW_SILL : 0;
  const siblings = snapshot.objects
    .filter((object) => (object.type === "door" || object.type === "window") && object.hostId === target.wall.id)
    .map((object) => {
      const objectSize = { width: object.dimensions.width ?? 0, height: object.dimensions.height ?? 0, thickness: object.dimensions.thickness ?? 0 };
      return { id: object.id, size: objectSize, placement: placementFromWorld(host, objectSize, object.position) };
    });
  const wallName = `the ${room.name}'s ${target.side} wall (${target.wall.id})`;
  const middleOfRoom = (target.span.from + target.span.to) / 2;

  /** The free offset nearest the room's centre for an opening `width` wide, inside the room's stretch of the wall - or null. */
  const freeOffset = (width: number): number | null => {
    const size = { ...standard, width };
    const lo = target.span.from + width / 2 + EDGE_CLEARANCE;
    const hi = target.span.to - width / 2 - EDGE_CLEARANCE;
    const travel = halfTravel(host, size);
    for (let step = 0; middleOfRoom + step * SEARCH_STEP <= hi + 1e-9 || middleOfRoom - step * SEARCH_STEP >= lo - 1e-9; step += 1) {
      for (const candidate of step === 0 ? [middleOfRoom] : [middleOfRoom + step * SEARCH_STEP, middleOfRoom - step * SEARCH_STEP]) {
        if (candidate < lo - 1e-9 || candidate > hi + 1e-9 || Math.abs(candidate) > travel + 1e-9) continue;
        if (hostingProblems(host, { id: "new", size }, { offset: candidate, sill }, siblings).length === 0) {
          return Math.round(candidate * 1000) / 1000;
        }
      }
    }
    return null;
  };

  // The standard size first; a narrower standard size only when that doesn't fit - and the reply says so.
  let width = standard.width;
  let offset: number | null = null;
  for (const trial of opening === "window" ? [WINDOW.width, 0.9, 0.6] : [DOOR.width, 0.8]) {
    offset = freeOffset(trial);
    if (offset !== null) {
      width = trial;
      break;
    }
  }
  if (offset === null) {
    const existing = siblings.map((sibling) => sibling.id);
    return nothingChanged(
      `There's no free space for a ${opening} in ${wallName}${existing.length > 0 ? ` — the ${room.name}'s stretch of it already holds ${list(existing)}` : ` — the ${room.name}'s stretch of it is only ${fmt(target.span.to - target.span.from)} m`}.`
    );
  }

  const size = { ...standard, width };
  const command = opening === "window" ? { type: "window.add", window: { ...size, hostId: target.wall.id, offset, sill } } : { type: "door.add", door: { ...size, hostId: target.wall.id, offset, sill } };
  const ran = ctx.run([command]);
  if (!ran.ok) return nothingChanged(`I couldn't add the ${opening}: ${ran.message}`);
  const id = ran.results[0]?.objectId;
  const placed = id ? ctx.snapshot().objects.find((object) => object.id === id) : undefined;
  if (!placed || placed.hostId !== target.wall.id) {
    return result(`The engine reported adding a ${opening}, but I can't find it in ${wallName}. Please check the model (Undo reverses it).`, "error", [{ label: "Undo", say: "undo" }]);
  }
  return result(
    `Added a ${fmt(width)} m ${opening} (${placed.id}) to ${wallName}${target.exterior ? "" : `, opening into ${list(target.neighbours)}`}, ${Math.abs(offset - middleOfRoom) < 0.01 ? "centred on the room" : "at the nearest free spot to the room's centre"}.` +
      (width !== standard.width ? ` A standard ${fmt(standard.width)} m ${opening} didn't fit beside ${list(siblings.map((sibling) => sibling.id))}, so this one is narrower.` : ""),
    "success",
    [
      { label: "Undo", say: "undo" },
      { label: `Show me the ${room.name}`, say: `Show me the ${room.name}` }
    ],
    { focusIds: [placed.id] }
  );
}

// --- "Move the front door one metre left" ---

const DIRECTION_VECTORS: Readonly<Record<Direction, { x: number; z: number }>> = {
  left: { x: -1, z: 0 },
  right: { x: 1, z: 0 },
  front: { x: 0, z: 1 },
  back: { x: 0, z: -1 }
};
const DIRECTION_WORDS: Readonly<Record<Direction, string>> = { left: "left", right: "right", front: "toward the front", back: "toward the back" };

interface OpeningRef {
  object: AIContextObject;
  /** "the front door", "the Kitchen window" - for replies. */
  name: string;
  where: string;
}

/** Every exterior opening of a type, with the side it faces - from all rooms' bordering walls. */
function exteriorOpenings(snapshot: AIProjectSnapshot, type: "door" | "window"): { object: AIContextObject; side: Side; room: string }[] {
  const out: { object: AIContextObject; side: Side; room: string }[] = [];
  for (const room of listRooms(snapshot)) {
    for (const opening of describeRoom(snapshot, room).openings) {
      if (opening.object.type === type && opening.wall.exterior && !out.some((entry) => entry.object.id === opening.object.id)) {
        out.push({ object: opening.object, side: opening.wall.side, room: room.name });
      }
    }
  }
  return out;
}

function openingLabel(snapshot: AIProjectSnapshot, object: AIContextObject): string {
  const rooms = listRooms(snapshot)
    .filter((room) => describeRoom(snapshot, room).openings.some((opening) => opening.object.id === object.id))
    .map((room) => room.name);
  return `${object.id} (${rooms.length > 0 ? rooms.join(" ↔ ") : "no room"})`;
}

function resolveOpening(
  snapshot: AIProjectSnapshot,
  text: string,
  type: "door" | "window",
  say: (ref: string) => string,
  sayRoom: (room: RoomInfo) => string
): OpeningRef | RoomEditResult {
  const named = idsIn(snapshot, text, type);
  if (named.length === 1) return { object: named[0], name: named[0].id, where: "" };

  const choose = (candidates: readonly AIContextObject[], question: string): RoomEditResult =>
    result(
      question,
      "question",
      candidates.slice(0, 8).map((object) => ({ label: openingLabel(snapshot, object), say: say(object.id) })),
      { focusIds: candidates.map((object) => object.id) },
      { options: candidates.map((object) => ({ keys: [object.id], say: say(object.id) })) }
    );

  const lower = text.toLowerCase();
  const entrance = /\b(?:front|main|entrance)\s+door\b|\bentrance\b/.test(lower);
  const rear = /\b(?:back|rear)\s+door\b/.test(lower);
  if (type === "door" && (entrance || rear)) {
    const exterior = exteriorOpenings(snapshot, "door");
    const facing = exterior.filter((entry) => entry.side === (entrance ? "front" : "back"));
    const pool = facing.length > 0 ? facing : entrance ? exterior : [];
    if (pool.length === 1) return { object: pool[0].object, name: entrance ? "the front door" : "the back door", where: `in the ${pool[0].room}'s ${pool[0].side} wall` };
    if (pool.length === 0) return nothingChanged(`I can't find ${entrance ? "a front door" : "a back door"} — no door is in an outside wall${entrance ? "" : " at the back"}.`);
    return choose(pool.map((entry) => entry.object), `There are ${pool.length} outside doors. Which one is the ${entrance ? "front" : "back"} door?`);
  }

  const rooms = listRooms(snapshot);
  const match = resolveRooms(rooms, text);
  if (match.kind === "ambiguous") {
    return result(
      `Which ${match.label}? There are ${match.options.length}: ${list(match.options.map((room) => room.name))}.`,
      "question",
      match.options.map((room) => ({ label: room.name, say: sayRoom(room) })),
      {},
      { options: match.options.map((room) => ({ keys: [room.name.toLowerCase()], say: sayRoom(room) })) }
    );
  }
  if (match.kind === "unknown") return nothingChanged(`There's no ${match.name} in this house.`);
  let candidates: AIContextObject[];
  let where = "";
  if (match.kind === "found") {
    const models = match.rooms.map((room) => describeRoom(snapshot, room));
    // Strict: "move the bedroom door 1 m left" names a direction, not the left wall.
    const side = readSide(text, true);
    candidates = models.flatMap((model) => model.openings.filter((opening) => opening.object.type === type && (!side || opening.wall.side === side)).map((opening) => opening.object));
    candidates = candidates.filter((object, index) => candidates.findIndex((other) => other.id === object.id) === index);
    where = ` in the ${list(match.rooms.map((room) => room.name))}`;
    if (candidates.length === 0) return nothingChanged(`The ${list(match.rooms.map((room) => room.name))} ${match.rooms.length === 1 ? "has" : "have"} no ${type}${side ? ` in the ${side} wall` : ""}.`);
  } else {
    candidates = snapshot.objects.filter((object) => object.type === type && object.hostId);
    if (candidates.length === 0) return nothingChanged(`There's no ${type} in a wall to move.`);
  }
  if (candidates.length === 1) return { object: candidates[0], name: `the ${type}${where}`, where: "" };
  return choose(candidates, `Which ${type}${where}? There are ${candidates.length}.`);
}

/** "north wall" etc. as a room side: north is the back (-Z), south the front (+Z), east the right (+X), west the left. */
const COMPASS_SIDE: Readonly<Record<string, Side>> = { north: "back", south: "front", east: "right", west: "left" };
const OPPOSITE_SIDE: Readonly<Record<Side, Side>> = { front: "back", back: "front", left: "right", right: "left" };

/** The opening already there: "the door", "the kitchen window", "that door", "door-3" - never "a/another door" (that's adding one). */
const EXISTING_OPENING = String.raw`(?:(?:the|that|this)\s+(?:[a-z0-9-]+\s+){0,2}?(?:door|window)|(?:door|window)-\d+)`;
/** Where it goes: a whole wall named by its side - "the other wall", "the north wall", "the left-hand wall". Never "the left side of …". */
const DESTINATION_WALL = String.raw`(?:the\s+)?(other|opposite|front|back|rear|left|right|north|south|east|west)(?:[\s-]+hand)?\s+wall\b`;

/**
 * "Put the door on the other wall", "move the window to the north wall": an
 * existing opening moved into ANOTHER wall - not along its own wall, and
 * not a new one. "Move/shift" says where with to/onto/into ("move the door
 * on the front wall 1 m left" names which door, then slides it); "put/
 * place" with on/in too. The destination phrase is group `destMove`/`destPut`.
 */
export const RELOCATE_OPENING = new RegExp(
  String.raw`\b(?:(?:move|shift|switch|relocate)\s+${EXISTING_OPENING}\s+(?<destMove>(?:to|onto|into)\s+${DESTINATION_WALL})|(?:put|place)\s+${EXISTING_OPENING}\s+(?<destPut>(?:on|onto|in|into|to)\s+${DESTINATION_WALL}))`,
  "i"
);

/** A distance in the words ("1 m", "50 cm", "half a metre"): a slide along the wall, never a move to another wall. parseUtterance also checks readDistance(). */
const SAYS_DISTANCE = /\b(?:\d+(?:\.\d+)?|a|an|one|two|three|four|five|six|seven|eight|nine|ten|half(?:\s+a)?)\s*(?:m|cm|mm|met(?:er|re)s?|centimet(?:er|re)s?|millimet(?:er|re)s?)\b/i;

export function isRelocation(text: string): boolean {
  return RELOCATE_OPENING.test(text) && !SAYS_DISTANCE.test(text);
}

/** A room as the user can tell it apart: its name, with its id when another room has the same name. */
function roomLabel(room: RoomInfo, among: readonly RoomInfo[]): string {
  return among.some((other) => other !== room && other.name.toLowerCase() === room.name.toLowerCase()) ? `${room.name} (${room.id})` : room.name;
}

/**
 * "Put the door on the other wall": the opening moves into another wall of
 * its room - the opposite one for "other"/"opposite", or the side named -
 * centred on that room's stretch of it, keeping its size and (a window) its
 * sill height, as one validated update (same id, one undo step). A room
 * named for the destination ("… of the kitchen", "… of room-3") must be the
 * opening's own; a door between two rooms is asked about (whose wall?).
 */
export function relocateOpening(ctx: RoomEditContext, request: { text: string; opening: "door" | "window" }): RoomEditResult {
  const { text, opening } = request;
  const match = RELOCATE_OPENING.exec(text);
  if (!match) return nothingChanged(`Which wall should the ${opening} go in?`);
  const destination = match.groups?.destMove ?? match.groups?.destPut ?? "";
  const word = (/(other|opposite|front|back|rear|left|right|north|south|east|west)/i.exec(destination)?.[1] ?? "other").toLowerCase();
  // "… to the north wall of the kitchen" / "… of room-3": whose wall is meant.
  const after = text.slice((match.index ?? 0) + match[0].length);
  const ofRoom = /^\s+of\s+(?:the\s+)?([a-z0-9][\w -]*?)\s*(?:[.,!?;]|$)/i.exec(after);
  // Which opening is meant is read from the words WITHOUT the destination ("the kitchen door", not "… on the left wall of the bedroom").
  const which = text.replace(destination, " ").replace(ofRoom?.[0] ?? "", " ");
  const snapshot = ctx.snapshot();
  const target = resolveOpening(
    snapshot,
    which,
    opening,
    (ref) => `Put ${ref} on the ${word} wall`,
    (room) => `Put the ${room.name} ${opening} on the ${word} wall`
  );
  if (isResult(target)) return target;
  const all = listRooms(snapshot);
  const rooms = all.filter((room) => describeRoom(snapshot, room).openings.some((entry) => entry.object.id === target.object.id));
  if (rooms.length === 0) return nothingChanged(`${target.object.id} isn't in a room's wall, so there's no "${word} wall" to move it to.`);
  const theirs = rooms.map((room) => `the ${roomLabel(room, all)}`).join(" and ");

  let room: RoomInfo | undefined;
  if (ofRoom) {
    const said = ofRoom[1].trim().toLowerCase();
    const byId = all.filter((candidate) => candidate.id.toLowerCase() === said);
    const named = byId.length > 0 ? byId : (() => {
      const found = resolveRooms(all, said);
      return found.kind === "found" ? found.rooms : found.kind === "ambiguous" ? found.options : [];
    })();
    const own = named.filter((candidate) => rooms.some((mine) => mine.id === candidate.id));
    if (named.length > 0 && own.length === 0) {
      return nothingChanged(`${target.object.id} is in ${theirs}, so it can only move to another wall of ${rooms.length === 1 ? "that room" : "those rooms"} - not into the ${named[0].name}. Add a new ${opening} there instead.`);
    }
    if (own.length === 1) room = own[0];
  }
  if (!room) {
    const named = resolveRooms(rooms, which);
    if (named.kind === "found" && named.rooms.length === 1) room = named.rooms[0];
    else if (rooms.length === 1) room = rooms[0];
  }
  if (!room) {
    // Between two rooms: "the north wall" or "the other wall" depends on whose wall - ask, never guess. Answered by room id, so two rooms with the same name can still be told apart.
    const say = (entry: RoomInfo): string => `Put ${target.object.id} on the ${word} wall of ${entry.id}`;
    const unique = (entry: RoomInfo): boolean => !rooms.some((other) => other !== entry && other.name.toLowerCase() === entry.name.toLowerCase());
    return result(
      `${target.object.id} is between ${theirs}. Which room's ${word} wall should it go to? Nothing was changed.`,
      "question",
      rooms.map((entry) => ({ label: `The ${roomLabel(entry, rooms)}'s ${word} wall`, say: say(entry) })),
      { focusIds: [target.object.id] },
      { options: rooms.map((entry) => ({ keys: unique(entry) ? [entry.id, entry.name.toLowerCase()] : [entry.id], say: say(entry) })) }
    );
  }
  const model = describeRoom(snapshot, room);
  const current = model.openings.find((entry) => entry.object.id === target.object.id)!;
  const side: Side = word === "other" || word === "opposite" ? OPPOSITE_SIDE[current.wall.side] : word === "rear" ? "back" : (COMPASS_SIDE[word] ?? (word as Side));
  const wanted = model.walls.find((wall) => wall.side === side);
  if (!wanted) return nothingChanged(`The ${room.name} has no ${side} wall to put ${target.name} in.`);
  if (wanted.wall.id === current.wall.wall.id) return nothingChanged(`${target.name[0].toUpperCase()}${target.name.slice(1)} is already in the ${room.name}'s ${side} wall (${wanted.wall.id}).`);
  // Centred on this room's stretch of the wall; a window keeps the height of its sill above the wall's base.
  const offset = Math.round(((wanted.span.from + wanted.span.to) / 2) * 1000) / 1000;
  const fromWall = current.wall.wall;
  const sill = Math.round((target.object.position.y - (fromWall.position.y - (fromWall.dimensions.height ?? 0) / 2) - (target.object.dimensions.height ?? 0) / 2) * 1000) / 1000;
  const placement = opening === "window" ? { offset, sill } : { offset };
  const run = ctx.run([{ type: `${opening}.update`, id: target.object.id, changes: { hostId: wanted.wall.id, hostPlacement: placement } }]);
  if (!run.ok) return result(`${target.name[0].toUpperCase()}${target.name.slice(1)} can't go in the ${room.name}'s ${side} wall: ${run.message} Nothing was changed.`, "error", []);
  const after2 = ctx.snapshot().objects.find((object) => object.id === target.object.id);
  if (after2?.hostId !== wanted.wall.id) return result(`The engine accepted the move, but ${target.object.id} isn't in ${wanted.wall.id}. Please check it (Undo reverses it).`, "error", [{ label: "Undo", say: "undo" }], { focusIds: [target.object.id] });
  return result(
    `Moved ${target.name} (${target.object.id}) from the ${room.name}'s ${current.wall.side} wall (${current.wall.wall.id}) to its ${side} wall (${wanted.wall.id}), centred on it. One undo puts it back.`,
    "success",
    [{ label: "Undo", say: "undo" }],
    { focusIds: [target.object.id, wanted.wall.id] }
  );
}

export function moveOpening(ctx: RoomEditContext, request: { text: string; opening: "door" | "window"; distance?: number; direction?: Direction }): RoomEditResult {
  const { text, opening, distance, direction } = request;
  const snapshot = ctx.snapshot();
  const how = `${distance !== undefined ? `${fmt(distance)} m` : "1 m"} ${direction ? DIRECTION_WORDS[direction] : "left"}`;
  const target = resolveOpening(
    snapshot,
    text,
    opening,
    (ref) => `Move ${ref} ${how}`,
    (room) => `Move the ${room.name} ${opening} ${how}`
  );
  if (isResult(target)) return target;
  const wall = target.object.hostId ? snapshot.objects.find((object) => object.id === target.object.hostId) : undefined;
  if (!wall) return nothingChanged(`${target.object.id} isn't in a wall, so it has no wall to slide along.`);
  const along = wallAxes(wall.rotation).along;
  const runsAlongX = Math.abs(along.x) > Math.abs(along.z);
  const ways: Direction[] = runsAlongX ? ["left", "right"] : ["front", "back"];

  if (distance === undefined) {
    return result(`How far should ${target.name} (${target.object.id}) move?`, "question", [0.5, 1].map((metres) => ({ label: `${fmt(metres)} m ${DIRECTION_WORDS[direction ?? ways[0]]}`, say: `Move ${target.object.id} ${fmt(metres)} m ${DIRECTION_WORDS[direction ?? ways[0]]}` })));
  }
  if (distance <= 0) {
    return nothingChanged(`Moving ${target.name} ${fmt(distance)} m wouldn't move it.`);
  }
  if (!direction) {
    return result(`Which way should ${target.name} (${target.object.id}) move? Its wall runs ${runsAlongX ? "left–right" : "front–back"}.`, "question", ways.map((way) => ({ label: `${fmt(distance)} m ${DIRECTION_WORDS[way]}`, say: `Move ${target.object.id} ${fmt(distance)} m ${DIRECTION_WORDS[way]}` })));
  }
  const vector = DIRECTION_VECTORS[direction];
  const dot = vector.x * along.x + vector.z * along.z;
  if (Math.abs(dot) < 0.5) {
    return result(
      `${target.name[0].toUpperCase()}${target.name.slice(1)} (${target.object.id}) is in a wall that runs ${runsAlongX ? "left–right" : "front–back"}, so it can't move ${DIRECTION_WORDS[direction]} without leaving the wall. Move it along the wall instead?`,
      "question",
      ways.map((way) => ({ label: `${fmt(distance)} m ${DIRECTION_WORDS[way]}`, say: `Move ${target.object.id} ${fmt(distance)} m ${DIRECTION_WORDS[way]}` })),
      { focusIds: [target.object.id] }
    );
  }

  const host = hostWallOf(wall);
  const size = { width: target.object.dimensions.width ?? 0, height: target.object.dimensions.height ?? 0, thickness: target.object.dimensions.thickness ?? 0 };
  const before = placementFromWorld(host, size, target.object.position);
  const offset = Math.round((before.offset + Math.sign(dot) * distance) * 1000) / 1000;
  const ran = ctx.run([{ type: `${opening}.update`, id: target.object.id, changes: { hostPlacement: { offset } } }]);
  if (!ran.ok) return nothingChanged(`I couldn't move ${target.name} (${target.object.id}) ${fmt(distance)} m ${DIRECTION_WORDS[direction]}: ${ran.message}`, [{ label: `Try ${fmt(distance / 2)} m`, say: `Move ${target.object.id} ${fmt(distance / 2)} m ${DIRECTION_WORDS[direction]}` }]);

  const after = ctx.snapshot().objects.find((object) => object.id === target.object.id);
  const moved = after ? Math.hypot(after.position.x - target.object.position.x, after.position.z - target.object.position.z) : 0;
  if (!after || Math.abs(moved - distance) > 0.01) {
    return result(`The engine accepted the move, but ${target.object.id} moved ${fmt(moved)} m instead of ${fmt(distance)} m. Please check it (Undo reverses it).`, "error", [{ label: "Undo", say: "undo" }], { focusIds: [target.object.id] });
  }
  return result(
    `Moved ${target.name} (${target.object.id}) ${fmt(distance)} m ${DIRECTION_WORDS[direction]} along ${wall.id} — its centre is now at (${fmt(after.position.x)}, ${fmt(after.position.z)}). Directions are as seen in the Front view.`,
    "success",
    [{ label: "Undo", say: "undo" }],
    { focusIds: [target.object.id] }
  );
}

// --- "Make the bedroom wall 4 metres long" ---

export function setWallLength(ctx: RoomEditContext, request: { text: string; length: number }): RoomEditResult {
  const { text, length } = request;
  const snapshot = ctx.snapshot();
  if (!Number.isFinite(length) || length <= 0) return nothingChanged("A wall needs a length greater than 0.");
  const say = (ref: string) => `Make ${ref} ${fmt(length)} metres long`;

  let wall: AIContextObject | undefined = idsIn(snapshot, text, "wall")[0];
  let name = wall ? wall.id : "";
  if (!wall) {
    const rooms = listRooms(snapshot);
    const between = /\bbetween\s+(?:the\s+)?(.+?)\s+and\s+(?:the\s+)?(.+?)(?:\s+\d|\s+(?:to|one|two|three|four|five|six|seven|eight|nine|ten|half)\b|$)/i.exec(text);
    if (between) {
      const a = resolveRooms(rooms, between[1]);
      const b = resolveRooms(rooms, between[2]);
      if (a.kind !== "found" || b.kind !== "found" || a.rooms.length !== 1 || b.rooms.length !== 1) {
        return result(`I couldn't tell which two rooms you mean. Name them exactly, e.g. “the wall between the Kitchen and the Living Room”. Rooms: ${list(rooms.map((room) => room.name))}.`, "question");
      }
      const shared = describeRoom(snapshot, a.rooms[0]).walls.filter((entry) => entry.neighbours.includes(b.rooms[0].name));
      if (shared.length === 0) return nothingChanged(`The ${a.rooms[0].name} and the ${b.rooms[0].name} don't share a wall.`);
      wall = shared[0].wall;
      name = `the wall between the ${a.rooms[0].name} and the ${b.rooms[0].name}`;
    } else {
      const side = readSide(text);
      const found = oneRoom(snapshot, text, (room) => say(`the ${side ? `${side} ` : ""}wall of the ${room.name}`));
      if (isResult(found)) return found;
      const room = found.rooms[0];
      const model = describeRoom(snapshot, room);
      const walls = pickWalls(snapshot, model, text, null);
      if (walls.length === 0) {
        return result(`The ${room.name} has no ${readSide(text) ?? ""} wall I can find. Its walls: ${list(model.walls.map(describeWall))}.`, "question", model.walls.map((entry) => wallChoice(model, entry, (ref) => say(`the ${ref} of the ${room.name}`))));
      }
      if (walls.length > 1) {
        return result(
          `Which wall of the ${room.name}? Changing a wall's length changes the whole wall, including any stretch shared with other rooms.`,
          "question",
          walls.map((entry) => wallChoice(model, entry, (ref) => say(`the ${ref} of the ${room.name}`))),
          {},
          { options: walls.map((entry) => ({ keys: [entry.side, `${entry.side} wall`], say: say(`the ${entry.side} wall of the ${room.name}`) })) }
        );
      }
      wall = walls[0].wall;
      name = `the ${room.name}'s ${walls[0].side} wall`;
    }
  }

  const before = wall.dimensions.length ?? 0;
  if (Math.abs(before - length) < 0.005) {
    return result(`${name[0].toUpperCase()}${name.slice(1)} (${wall.id}) is already ${fmt(length)} m long. Nothing was changed.`, "info", [], { focusIds: [wall.id] });
  }
  const ran = ctx.run([{ type: "update_object", objectId: wall.id, changes: { dimensions: { length } } }]);
  if (!ran.ok) return nothingChanged(`I couldn't make ${wall.id} ${fmt(length)} m long: ${ran.message}`);
  const after = ctx.snapshot().objects.find((object) => object.id === wall!.id);
  if (!after || Math.abs((after.dimensions.length ?? 0) - length) > 0.005) {
    return result(`The engine accepted the change, but ${wall.id} is ${fmt(after?.dimensions.length ?? 0)} m long, not ${fmt(length)} m. Please check it (Undo reverses it).`, "error", [{ label: "Undo", say: "undo" }], { focusIds: [wall.id] });
  }
  const shorter = length < before;
  return result(
    `${name[0].toUpperCase()}${name.slice(1)} (${wall.id}) is now ${fmt(length)} m long (was ${fmt(before)} m), still centred where it was.` +
      (shorter ? " It no longer reaches as far as before, so the walls it met may now leave a gap — Undo reverses it." : " It now runs further than before and may cross the walls it met — Undo reverses it."),
    "success",
    [{ label: "Undo", say: "undo" }],
    { focusIds: [wall.id] }
  );
}

// --- "Refurnish bedroom 2" ---

/** A furniture arrangement as comparable text: which pieces, where, which way, how wide. Angles are taken modulo a full turn. */
function signature(entries: readonly { assetId: string; x: number; z: number; rotation: number; width: number }[]): string {
  const turn = 2 * Math.PI;
  return entries
    .map((entry) => `${entry.assetId}@${entry.x.toFixed(3)},${entry.z.toFixed(3)},${(((entry.rotation % turn) + turn) % turn).toFixed(3)},${entry.width.toFixed(3)}`)
    .sort()
    .join("|");
}

function plannedSignature(plan: FurnishingPlan): string {
  return signature(
    plan.commands.map((command) => ({
      assetId: command.asset.assetId,
      x: command.asset.position?.x ?? 0,
      z: command.asset.position?.z ?? 0,
      rotation: command.asset.rotation ?? 0,
      width: command.asset.dimensions?.width ?? getAssetDefinition(command.asset.assetId)?.defaultDimensions.width ?? 0
    }))
  );
}

/**
 * Furnishes the rooms `text` names from the model as it stands. With
 * `replace` (refurnish), the furniture already in them is removed first,
 * in the same undo step, and the new arrangement is one that differs from
 * the current one: the default plan around the room's doors and windows
 * as they are now, or - when that is what's already there - the mirrored
 * variant that leaves the fewest pieces out. When every arrangement is
 * the current one, nothing is changed. Without `replace`, only empty
 * rooms are furnished.
 */
export function furnishRooms(ctx: RoomEditContext, text: string, replace: boolean): RoomEditResult {
  const snapshot = ctx.snapshot();
  const verb = replace ? "Refurnish" : "Furnish";
  const found = oneRoom(snapshot, text, (room) => `${verb} the ${room.name}`, true);
  if (isResult(found)) return found;
  const rooms = found.rooms;
  const models = rooms.map((room) => describeRoom(snapshot, room));
  const targets = replace ? rooms : rooms.filter((_, index) => models[index].furniture.length === 0);
  if (targets.length === 0) {
    return result(`${list(rooms.map((room) => room.name))} ${rooms.length === 1 ? "is" : "are"} already furnished. Nothing was changed.`, "info", [
      { label: `Refurnish the ${rooms[0].name}`, say: `Refurnish the ${rooms[0].name}` }
    ]);
  }
  const ids = targets.map((room) => room.id);
  let plan = planFurnishingsInScene(snapshot, ids, { replace });
  let variant = 0;
  if (replace) {
    const current = signature(
      models
        .filter((model) => targets.includes(model.room))
        .flatMap((model) => model.furniture)
        .map((object) => ({ assetId: object.assetId ?? "", x: object.position.x, z: object.position.z, rotation: object.rotation, width: object.dimensions.width ?? 0 }))
    );
    if (plannedSignature(plan) === current) {
      const alternatives = [1, 2, 3]
        .map((index) => ({ index, plan: planFurnishingsInScene(snapshot, ids, { replace, variant: index }) }))
        .filter((entry) => entry.plan.commands.length > 0 && plannedSignature(entry.plan) !== current)
        .sort((a, b) => a.plan.skipped - b.plan.skipped || b.plan.commands.length - a.plan.commands.length || a.index - b.index);
      if (alternatives.length === 0) {
        return result(
          `The ${list(targets.map((room) => room.name))} already ${targets.length === 1 ? "has" : "have"} the only arrangement I can find that fits around ${targets.length === 1 ? "its" : "their"} doors and windows. Nothing was changed.`,
          "info"
        );
      }
      plan = alternatives[0].plan;
      variant = alternatives[0].index;
    }
  }
  // Never "refurnish" a room into an empty one.
  if (plan.commands.length === 0) {
    return nothingChanged(`No furniture fits in the ${list(targets.map((room) => room.name))} clear of its doors and windows.`);
  }

  const commands = [...plan.replaced.map((id) => ({ type: "asset.delete", id })), ...plan.commands];
  const ran = ctx.run(commands);
  if (!ran.ok) return nothingChanged(`I couldn't ${verb.toLowerCase()} the ${list(targets.map((room) => room.name))}: ${ran.message}`);

  const added = ran.results.slice(plan.replaced.length).map((entry) => entry.objectId).filter((id): id is string => !!id);
  const after = ctx.snapshot();
  const present = new Set(after.objects.map((object) => object.id));
  if (added.length !== plan.commands.length || !added.every((id) => present.has(id)) || plan.replaced.some((id) => present.has(id))) {
    return result(`The engine accepted the change, but the furniture isn't what I planned. Please check the room (Undo reverses it).`, "error", [{ label: "Undo", say: "undo" }]);
  }
  const names = [...new Set(plan.commands.map((command) => command.asset.assetId.replace(/-/g, " ")))];
  const furnished = [...plan.byRoom].map(([room, indices]) => ({ room, ids: indices.map((index) => added[index]) }));
  return result(
    `${replace ? "Refurnished" : "Furnished"} the ${list(targets.map((room) => room.name))}: ${replace ? `removed ${plural(plan.replaced.length, "piece")}, ` : ""}placed ${plural(added.length, "piece")} (${list(names)}), ${variant > 0 ? "in a new arrangement " : ""}clear of the doors and windows as they are now${plan.skipped > 0 ? `; ${plural(plan.skipped, "piece")} didn't fit` : ""}.`,
    "success",
    [
      { label: "Undo", say: "undo" },
      { label: `Show me the ${targets[0].name}`, say: `Show me the ${targets[0].name}` }
    ],
    { focusIds: [...targets.map((room) => room.id), ...added] },
    { furnished }
  );
}
