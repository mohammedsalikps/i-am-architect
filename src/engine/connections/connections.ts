// Explicit .ts extension on this value import lets Node run this file
// directly (the verify suites and the backend do). Harmless for Vite.
import { getElementKind } from "../elements/catalog.ts";
import type { ElementData, Endpoint } from "../elements/types";

/**
 * Endpoints and connections of linear elements - water pipes, drain pipes,
 * conduits, and cables. A linear element runs along its local X axis: its
 * `start` is the -X end and its `end` the +X end, both at its center
 * height, derived from position, rotation, and `length`. Moving an
 * endpoint recomputes all three, so the element is always a real straight
 * run between its two ends.
 *
 * A connection joins one element's endpoint to another's. It is recorded
 * on both elements (mirrored), the two kinds must connect with each other
 * (the catalog's `connectsWith`: water pipe to water pipe, drain to drain,
 * conduit to conduit, cable to cable), and the two endpoints coincide.
 * CommandExecutor keeps it that way: element.connect snaps an endpoint
 * within CONNECTION_TOLERANCE onto the other, moving a joined endpoint
 * moves every endpoint at that joint, and deleting an element removes its
 * connections from its neighbors. No flow, pressure, or load is modeled.
 */

export const ENDPOINTS: readonly Endpoint[] = ["start", "end"];

/** How close two endpoints must be to be connected (element.connect snaps the rest), in meters. */
export const CONNECTION_TOLERANCE = 0.3;

/** How far apart the two endpoints of a stored connection may be - float noise only, in meters. */
export const JOINT_TOLERANCE = 1e-3;

export interface Point3 {
  x: number;
  y: number;
  z: number;
}

/** The fields endpoint math reads - any element record satisfies it. */
export interface LinearShape {
  position: Point3;
  rotation: number;
  dimensions: Record<string, number>;
}

function round(value: number): number {
  const rounded = Math.round(value * 1e9) / 1e9;
  return rounded === 0 ? 0 : rounded;
}

/** Whether elements of this kind have endpoints that can be connected. */
export function isConnectable(kind: string): boolean {
  const definition = getElementKind(kind);
  return !!definition && definition.linear && definition.connectsWith.length > 0;
}

/** Whether an endpoint of kind `a` can be connected to an endpoint of kind `b`. */
export function kindsConnect(a: string, b: string): boolean {
  return getElementKind(a)?.connectsWith.includes(b) ?? false;
}

/** A linear element's two ends, at its center height. */
export function endpointsOf(element: LinearShape): Record<Endpoint, Point3> {
  const half = (element.dimensions.length ?? 0) / 2;
  const dx = Math.cos(element.rotation) * half;
  const dz = -Math.sin(element.rotation) * half;
  return {
    start: { x: round(element.position.x - dx), y: element.position.y, z: round(element.position.z - dz) },
    end: { x: round(element.position.x + dx), y: element.position.y, z: round(element.position.z + dz) }
  };
}

/** Distance between two points on the horizontal plane. */
export function horizontalDistance(a: { x: number; z: number }, b: { x: number; z: number }): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

/** The center, rotation, and length of a straight run from `start` to `end` at height `y`. */
export function runBetween(start: { x: number; z: number }, end: { x: number; z: number }, y: number): { position: Point3; rotation: number; length: number } {
  const dx = end.x - start.x;
  const dz = end.z - start.z;
  return {
    position: { x: round((start.x + end.x) / 2), y, z: round((start.z + end.z) / 2) },
    rotation: dx === 0 && dz === 0 ? 0 : round(Math.atan2(-dz, dx)),
    length: round(Math.hypot(dx, dz))
  };
}

/** The change that moves one endpoint to `point` (on the horizontal plane) and keeps the other where it is. */
export function moveEndpoint(
  element: LinearShape,
  endpoint: Endpoint,
  point: { x: number; z: number }
): { position: Point3; rotation: number; dimensions: Record<string, number> } {
  const ends = endpointsOf(element);
  const start = endpoint === "start" ? point : ends.start;
  const end = endpoint === "end" ? point : ends.end;
  const run = runBetween(start, end, element.position.y);
  return { position: run.position, rotation: run.rotation, dimensions: { ...element.dimensions, length: run.length } };
}

export interface EndpointRef {
  id: string;
  endpoint: Endpoint;
}

/**
 * Every endpoint joined at the same joint as `seed`, the seed included,
 * following connections transitively (so a tee's three ends all come
 * back). Deterministic: breadth-first, in connection order.
 */
export function jointMembers(elements: ReadonlyMap<string, ElementData>, seed: EndpointRef): EndpointRef[] {
  const found: EndpointRef[] = [seed];
  const seen = new Set([`${seed.id}:${seed.endpoint}`]);
  for (let index = 0; index < found.length; index += 1) {
    const current = found[index];
    for (const connection of elements.get(current.id)?.connections ?? []) {
      if (connection.endpoint !== current.endpoint) {
        continue;
      }
      const key = `${connection.objectId}:${connection.objectEndpoint}`;
      if (!seen.has(key) && elements.has(connection.objectId)) {
        seen.add(key);
        found.push({ id: connection.objectId, endpoint: connection.objectEndpoint });
      }
    }
  }
  return found;
}

/** Ids of every element connected to `id`, directly or through others, `id` included. */
export function networkOf(elements: ReadonlyMap<string, ElementData>, id: string): string[] {
  const found = [id];
  const seen = new Set(found);
  for (let index = 0; index < found.length; index += 1) {
    for (const connection of elements.get(found[index])?.connections ?? []) {
      if (!seen.has(connection.objectId) && elements.has(connection.objectId)) {
        seen.add(connection.objectId);
        found.push(connection.objectId);
      }
    }
  }
  return found;
}

/**
 * Everything wrong with the connections among a whole model's elements -
 * empty when every connection names an existing element of a compatible
 * connectable kind, is recorded on both elements, and joins endpoints that
 * coincide (within JOINT_TOLERANCE). Loading a project checks this, so a
 * saved model can never bring back a broken connection.
 */
export function connectionProblems(elements: readonly ElementData[]): string[] {
  const byId = new Map(elements.map((element) => [element.id, element]));
  const problems: string[] = [];
  for (const element of elements) {
    for (const connection of element.connections ?? []) {
      const where = `${element.id} ${connection.endpoint}`;
      const other = byId.get(connection.objectId);
      if (!other) {
        problems.push(`${where}: connects to "${connection.objectId}", which isn't an element in this model.`);
        continue;
      }
      if (!isConnectable(element.kind) || !kindsConnect(element.kind, other.kind)) {
        problems.push(`${where}: a ${element.kind} can't connect to a ${other.kind} (${other.id}).`);
        continue;
      }
      const mirrored = (other.connections ?? []).some(
        (back) => back.objectId === element.id && back.endpoint === connection.objectEndpoint && back.objectEndpoint === connection.endpoint
      );
      if (!mirrored) {
        problems.push(`${where}: ${other.id} doesn't record the connection back.`);
        continue;
      }
      const a = endpointsOf(element)[connection.endpoint];
      const b = endpointsOf(other)[connection.objectEndpoint];
      if (horizontalDistance(a, b) > JOINT_TOLERANCE || Math.abs(a.y - b.y) > JOINT_TOLERANCE) {
        problems.push(`${where}: its endpoint doesn't meet ${other.id} ${connection.objectEndpoint}.`);
      }
    }
  }
  return problems;
}
