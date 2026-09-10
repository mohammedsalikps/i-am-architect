import type { ElementData } from "./types";

/**
 * Rooms: named spaces - a room element (kind "room") is a floor area and
 * a ceiling height, placed and rotated like any element. These helpers
 * make a house readable as a building: a room's area, and which objects
 * stand in it.
 *
 * Membership is computed, not stored: an object belongs to a room when
 * its center lies within the room's footprint and height. Nothing goes
 * stale when objects move, and no ids need to be kept in step. (Explicit
 * grouping is what assemblies are for.)
 */

export function isRoom(element: { kind?: string }): boolean {
  return element.kind === "room";
}

/** The room's floor area, in square meters. */
export function roomArea(room: ElementData): number {
  return Math.round(room.dimensions.length * room.dimensions.width * 100) / 100;
}

/**
 * Whether a point lies inside the room: within its rotated footprint and,
 * when the point has a height, between its floor and ceiling. Uses the
 * engine's rotation convention (local X is world (cos t, 0, -sin t),
 * local Z is (sin t, 0, cos t)).
 */
export function isInsideRoom(room: ElementData, point: { x: number; y?: number; z: number }): boolean {
  const dx = point.x - room.position.x;
  const dz = point.z - room.position.z;
  const cos = Math.cos(room.rotation);
  const sin = Math.sin(room.rotation);
  const localX = dx * cos - dz * sin;
  const localZ = dx * sin + dz * cos;
  const epsilon = 1e-9;
  if (Math.abs(localX) > room.dimensions.length / 2 + epsilon || Math.abs(localZ) > room.dimensions.width / 2 + epsilon) {
    return false;
  }
  if (point.y === undefined) {
    return true;
  }
  const floor = room.position.y - room.dimensions.height / 2;
  return point.y >= floor - epsilon && point.y <= floor + room.dimensions.height + epsilon;
}

/** Ids of the objects standing in the room - every object whose center is inside it, other rooms excluded. */
export function objectsInRoom(
  room: ElementData,
  objects: readonly { id: string; kind?: string; position: { x: number; y: number; z: number } }[]
): string[] {
  return objects.filter((object) => object.id !== room.id && !isRoom(object) && isInsideRoom(room, object.position)).map((object) => object.id);
}
