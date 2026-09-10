// Explicit .ts extensions on these value imports let Node run this file
// directly (the verify suites do). Harmless for Vite.
import { keyPointsOf, snapMove, snapPoint, toGrid } from "./snapping.ts";
import { findHostWall, wallAxes } from "../openings/hostOpening.ts";
import { ENDPOINTS, endpointsOf, isConnectable, jointMembers, kindsConnect } from "../connections/connections.ts";
import type { SnapObject, SnapPoint } from "./snapping";
import type { ManipulationSnapper } from "../manipulation/ObjectManipulator";
import type { ElementData } from "../elements/types";

/** A store record, as far as snapping reads it. */
interface SnapRecord {
  id: string;
  type: string;
  kind?: string;
  hostId?: string | null;
  connections?: readonly { objectId: string }[];
  position: { x: number; y: number; z: number };
  rotation: number;
  dimensions: object;
}

export interface SnapSourceStores {
  wallStore: { getAll(): readonly SnapRecord[] };
  pillarStore: { getAll(): readonly SnapRecord[] };
  beamStore: { getAll(): readonly SnapRecord[] };
  slabStore: { getAll(): readonly SnapRecord[] };
  doorStore: { getAll(): readonly SnapRecord[] };
  windowStore: { getAll(): readonly SnapRecord[] };
  elementStore: { getAll(): readonly ElementData[] };
}

function round(value: number): number {
  const rounded = Math.round(value * 1e9) / 1e9;
  return rounded === 0 ? 0 : rounded;
}

function toSnapObject(record: SnapRecord): SnapObject & { hostId?: string | null; connections?: readonly { objectId: string }[] } {
  return {
    id: record.id,
    type: record.type,
    ...(record.kind !== undefined ? { kind: record.kind } : {}),
    ...(record.hostId !== undefined ? { hostId: record.hostId } : {}),
    ...(record.connections !== undefined ? { connections: record.connections } : {}),
    position: { ...record.position },
    rotation: record.rotation,
    dimensions: { ...(record.dimensions as Record<string, number>) }
  };
}

/**
 * Snapping against the live model, for ObjectManipulator (see
 * snapping.ts for the rules). Reads the stores fresh on every call and
 * never writes. While `settings` is off, points pass through unchanged.
 *
 * - A moving object snaps to the other objects' key points, then aligns,
 *   then goes to the grid. What moves with it isn't a target: a wall's own
 *   openings, and the elements joined to it.
 * - A door or window in a wall isn't snapped - its wall constrains it. A
 *   free-standing one near a wall snaps onto that wall's center plane.
 * - A dragged endpoint snaps first to a compatible endpoint (which it is
 *   then connected to - see ObjectManipulator.end()), then to any other
 *   key point, then to the grid. Endpoints already at its joint aren't
 *   targets: they move with it.
 */
export function createStoreSnapper(stores: SnapSourceStores, settings: { isEnabled(): boolean }): ManipulationSnapper {
  const everything = () =>
    [
      ...stores.wallStore.getAll(),
      ...stores.pillarStore.getAll(),
      ...stores.beamStore.getAll(),
      ...stores.slabStore.getAll(),
      ...stores.doorStore.getAll(),
      ...stores.windowStore.getAll(),
      ...stores.elementStore.getAll()
    ].map(toSnapObject);

  return {
    move(objectId, candidate) {
      if (!settings.isEnabled()) {
        return candidate;
      }
      const all = everything();
      const moving = all.find((object) => object.id === objectId);
      if (!moving) {
        return candidate;
      }
      if (moving.type === "door" || moving.type === "window") {
        if (typeof moving.hostId === "string") {
          return candidate;
        }
        const wall = findHostWall(
          all.filter((object) => object.type === "wall") as unknown as (SnapObject & {
            id: string;
            dimensions: { length: number; height: number; thickness: number };
          })[],
          candidate
        );
        if (wall) {
          const { along } = wallAxes(wall.rotation);
          const t = (candidate.x - wall.position.x) * along.x + (candidate.z - wall.position.z) * along.z;
          return { x: round(wall.position.x + along.x * t), y: candidate.y, z: round(wall.position.z + along.z * t) };
        }
      }
      const excluded = new Set([objectId]);
      for (const object of all) {
        if (object.hostId === objectId) {
          excluded.add(object.id);
        }
      }
      for (const connection of moving.connections ?? []) {
        excluded.add(connection.objectId);
      }
      return snapMove(moving, candidate, all.filter((object) => !excluded.has(object.id))).position;
    },

    endpoint(objectId, endpoint, candidate) {
      if (!settings.isEnabled()) {
        return { point: candidate, target: null };
      }
      const elements = stores.elementStore.getAll();
      const moving = elements.find((element) => element.id === objectId);
      if (!moving) {
        return { point: candidate, target: null };
      }
      const byId = new Map(elements.map((element) => [element.id, element]));
      const joined = jointMembers(byId, { id: objectId, endpoint });
      const joinedKeys = new Set(joined.map((member) => `${member.id}:${member.endpoint}`));
      const joinedIds = new Set(joined.map((member) => member.id));

      // 1. A compatible endpoint - it will be connected to.
      const compatible: SnapPoint[] = elements
        .filter((element) => element.id !== objectId && isConnectable(element.kind) && kindsConnect(moving.kind, element.kind))
        .flatMap((element) => {
          const ends = endpointsOf(element);
          return ENDPOINTS.filter((end) => !joinedKeys.has(`${element.id}:${end}`)).map((end) => ({
            x: ends[end].x,
            z: ends[end].z,
            objectId: element.id,
            kind: "endpoint" as const,
            endpoint: end
          }));
        });
      const hit = snapPoint(candidate, compatible);
      if (hit) {
        return {
          point: { x: hit.x, y: candidate.y, z: hit.z },
          target: { objectId: hit.objectId, ...(hit.endpoint ? { endpoint: hit.endpoint } : {}), connectable: true }
        };
      }

      // 2. Any other key point - a fixture's corner, a wall's end.
      const others = everything()
        .filter((object) => object.id !== objectId && !joinedIds.has(object.id))
        .flatMap(keyPointsOf);
      const near = snapPoint(candidate, others);
      if (near) {
        return {
          point: { x: near.x, y: candidate.y, z: near.z },
          target: { objectId: near.objectId, ...(near.endpoint ? { endpoint: near.endpoint } : {}), connectable: false }
        };
      }

      // 3. The grid.
      return { point: { x: toGrid(candidate.x), y: candidate.y, z: toGrid(candidate.z) }, target: null };
    }
  };
}
