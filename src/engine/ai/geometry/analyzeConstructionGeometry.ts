// Explicit .ts extensions on these value imports (the others are
// type-only) let Node run this module directly - see geometry/verify.ts
// and e2e/verify.ts. Harmless for Vite. The element catalog is pure data:
// it says which dimension spans each local axis of every element kind.
import { compareIds } from "../types.ts";
import { getElementKind } from "../../elements/catalog.ts";
import type { AIContextObject, AIProjectSnapshot } from "../types";
import type {
  AxisAlignedBox,
  ConnectionRelationship,
  ConstructionGeometryAnalysis,
  GeometryError,
  GeometryVector,
  HostRelationship,
  InvalidObjectGeometry,
  LocalAxisDimensions,
  ObjectGeometry,
  ObjectPairRelationship
} from "./types";

/**
 * Which dimension field runs along each local axis, per object type -
 * taken from the argument order each mesh builder passes to
 * THREE.BoxGeometry(width = local X, height = local Y, depth = local Z)
 * in src/scene/<type>/build<Type>Mesh.ts. geometry/verify.ts reads those
 * builders' source and fails if this table ever drifts from them.
 */
export const LOCAL_AXIS_DIMENSIONS: Readonly<Record<string, Readonly<LocalAxisDimensions>>> = Object.freeze({
  wall: Object.freeze({ x: "length", y: "height", z: "thickness" }),
  pillar: Object.freeze({ x: "width", y: "height", z: "depth" }),
  beam: Object.freeze({ x: "length", y: "height", z: "width" }),
  slab: Object.freeze({ x: "length", y: "thickness", z: "width" }),
  door: Object.freeze({ x: "width", y: "height", z: "thickness" }),
  window: Object.freeze({ x: "width", y: "height", z: "thickness" })
});

/**
 * Every derived number is rounded to this many decimal places (a
 * nanometre). Without it, rotating a 0.2 m thick wall by exactly 90
 * degrees gives an X extent of 0.20000000000000024 - cos(pi/2) isn't
 * exactly 0 in floating point - so two boxes that should touch could
 * test as overlapping by a hair, and the same wall at 90 and 450 degrees
 * could produce different boxes. Rounding first makes every comparison
 * below exact and repeatable.
 */
export const GEOMETRY_DECIMALS = 9;

const SCALE = 10 ** GEOMETRY_DECIMALS;

const AXES = ["x", "y", "z"] as const;

function quantize(value: number): number {
  const rounded = Math.round(value * SCALE) / SCALE;
  return rounded === 0 ? 0 : rounded; // folds -0 into 0
}

function isPositiveFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Which dimension spans each local axis of an object: the verified table
 * above for the six original types, the element catalog for an element
 * (by its kind). Undefined for anything else.
 */
export function localAxesFor(type: string, kind?: string): Readonly<LocalAxisDimensions> | undefined {
  if (type === "element") {
    return kind === undefined ? undefined : getElementKind(kind)?.axes;
  }
  return Object.prototype.hasOwnProperty.call(LOCAL_AXIS_DIMENSIONS, type) ? LOCAL_AXIS_DIMENSIONS[type] : undefined;
}

/**
 * The same rules each object validator enforces (finite position and
 * rotation, every dimension a finite number greater than 0), with the
 * same field names and wording - so an object is only ever described
 * here if its store would have accepted it.
 */
function validateGeometry(object: AIContextObject): GeometryError[] {
  const errors: GeometryError[] = [];
  const axes = localAxesFor(object.type, object.kind);

  if (!axes) {
    errors.push(
      object.type === "element"
        ? { field: "kind", message: `Geometry isn't defined for element kind "${object.kind}".` }
        : { field: "type", message: `Geometry isn't defined for object type "${object.type}".` }
    );
  }

  for (const axis of AXES) {
    if (!Number.isFinite(object.position?.[axis])) {
      errors.push({ field: `position.${axis}`, message: `Position ${axis.toUpperCase()} must be a finite number.` });
    }
  }

  if (!Number.isFinite(object.rotation)) {
    errors.push({ field: "rotation", message: "Rotation Y must be a finite number." });
  }

  if (axes) {
    for (const axis of AXES) {
      const key = axes[axis];
      if (!isPositiveFinite(object.dimensions?.[key])) {
        errors.push({ field: `dimensions.${key}`, message: `${capitalize(key)} must be a finite number greater than 0.` });
      }
    }
  }

  return errors;
}

/**
 * The object's box, rotated by `rotation` around its center's vertical
 * axis, then boxed again along the world axes. Rotating by t turns the
 * local X axis to world (cos t, 0, -sin t) and local Z to (sin t, 0,
 * cos t) - Three.js's rotation.y, which every mesh builder applies - so
 * the world half-extents are |cos t|*hx + |sin t|*hz on X and
 * |sin t|*hx + |cos t|*hz on Z. Y is unaffected by a Y rotation.
 */
function describe(object: AIContextObject, axes: Readonly<LocalAxisDimensions>): ObjectGeometry {
  const halfX = object.dimensions[axes.x] / 2;
  const halfY = object.dimensions[axes.y] / 2;
  const halfZ = object.dimensions[axes.z] / 2;
  const cos = Math.abs(Math.cos(object.rotation));
  const sin = Math.abs(Math.sin(object.rotation));
  const extent: GeometryVector = { x: cos * halfX + sin * halfZ, y: halfY, z: sin * halfX + cos * halfZ };

  const { x, y, z } = object.position;
  const aabb: AxisAlignedBox = {
    min: { x: quantize(x - extent.x), y: quantize(y - extent.y), z: quantize(z - extent.z) },
    max: { x: quantize(x + extent.x), y: quantize(y + extent.y), z: quantize(z + extent.z) }
  };

  const dimensions: Record<string, number> = {};
  for (const key of Object.keys(object.dimensions).sort()) {
    const value = object.dimensions[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      dimensions[key] = value;
    }
  }

  return {
    id: object.id,
    type: object.type,
    center: { x: quantize(x), y: quantize(y), z: quantize(z) },
    dimensions,
    rotation: object.rotation,
    size: {
      x: quantize(aabb.max.x - aabb.min.x),
      y: quantize(aabb.max.y - aabb.min.y),
      z: quantize(aabb.max.z - aabb.min.z)
    },
    aabb
  };
}

/** Whether two closed intervals share some length - touching end to end doesn't count. */
function intervalsOverlap(a: AxisAlignedBox, b: AxisAlignedBox, axis: "x" | "y" | "z"): boolean {
  return a.min[axis] < b.max[axis] && b.min[axis] < a.max[axis];
}

function intervalGap(a: AxisAlignedBox, b: AxisAlignedBox, axis: "x" | "y" | "z"): number {
  return quantize(Math.max(0, b.min[axis] - a.max[axis], a.min[axis] - b.max[axis]));
}

function relate(a: ObjectGeometry, b: ObjectGeometry): ObjectPairRelationship {
  const centerDelta: GeometryVector = {
    x: quantize(b.center.x - a.center.x),
    y: quantize(b.center.y - a.center.y),
    z: quantize(b.center.z - a.center.z)
  };
  const overlapX = intervalsOverlap(a.aabb, b.aabb, "x");
  const overlapY = intervalsOverlap(a.aabb, b.aabb, "y");
  const overlapZ = intervalsOverlap(a.aabb, b.aabb, "z");

  return {
    a: a.id,
    b: b.id,
    centerDelta,
    centerDistance: quantize(Math.hypot(centerDelta.x, centerDelta.y, centerDelta.z)),
    horizontalDistance: quantize(Math.hypot(centerDelta.x, centerDelta.z)),
    verticalDistance: quantize(Math.abs(centerDelta.y)),
    overlap: { x: overlapX, y: overlapY, z: overlapZ, aabb: overlapX && overlapY && overlapZ },
    gap: { x: intervalGap(a.aabb, b.aabb, "x"), y: intervalGap(a.aabb, b.aabb, "y"), z: intervalGap(a.aabb, b.aabb, "z") },
    aRelativeToB: {
      leftOf: a.aabb.max.x <= b.aabb.min.x,
      rightOf: a.aabb.min.x >= b.aabb.max.x,
      inFrontOf: a.aabb.min.z >= b.aabb.max.z,
      behind: a.aabb.max.z <= b.aabb.min.z,
      above: a.aabb.min.y >= b.aabb.max.y,
      below: a.aabb.max.y <= b.aabb.min.y
    }
  };
}

/**
 * Derives a deterministic geometric description of a project from its
 * AIProjectSnapshot: one bounding box per object, and one set of spatial
 * facts per pair of objects. Pure - reads only the snapshot it's given,
 * never writes to it, and returns freshly built JSON-safe data. See
 * ../README.md "Construction geometry analysis" for the conventions.
 *
 * An object whose geometry can't be derived (unknown type, non-finite
 * position or rotation, a missing, zero, or negative dimension) is
 * reported in `invalidObjects` with validator-style errors instead of
 * producing a meaningless box, and left out of `objects` and
 * `relationships`. The real stores already reject such objects, so this
 * only matters for hand-built or externally supplied snapshots.
 *
 * Relationships cover every pair, so they grow with n(n-1)/2; a later
 * step that sends this to a provider may need to select from them.
 */
export function analyzeConstructionGeometry(snapshot: AIProjectSnapshot): ConstructionGeometryAnalysis {
  const sorted = [...snapshot.objects].sort((a, b) => compareIds(a.id, b.id) || compareIds(a.type, b.type));

  const objects: ObjectGeometry[] = [];
  const invalidObjects: InvalidObjectGeometry[] = [];
  for (const object of sorted) {
    const errors = validateGeometry(object);
    const axes = localAxesFor(object.type, object.kind);
    if (errors.length > 0 || !axes) {
      invalidObjects.push({ id: object.id, type: object.type, errors });
    } else {
      objects.push(describe(object, axes));
    }
  }

  const relationships: ObjectPairRelationship[] = [];
  for (let first = 0; first < objects.length; first += 1) {
    for (let second = first + 1; second < objects.length; second += 1) {
      relationships.push(relate(objects[first], objects[second]));
    }
  }

  return { objects, relationships, invalidObjects, hosts: analyzeHosts(sorted), connections: analyzeConnections(sorted) };
}

/** Slack for float noise in the relationship checks, in meters. */
const FIT_TOLERANCE = 1e-6;
/** How far apart two connected endpoints may be, in meters (the engine's JOINT_TOLERANCE). */
const JOINT_TOLERANCE = 1e-3;

function sameDirection(a: number, b: number): boolean {
  const turn = 2 * Math.PI;
  const difference = (((a - b) % turn) + turn) % turn;
  return difference < 1e-6 || turn - difference < 1e-6;
}

/**
 * Each hosted door and window, checked against its wall from positions
 * alone: it must sit centered in the wall's thickness, turned with it,
 * within its length and height, and must not overlap another opening in
 * the same wall. Linear in the number of openings (plus each wall's own
 * openings pairwise - a handful).
 */
function analyzeHosts(objects: readonly AIContextObject[]): HostRelationship[] {
  const byId = new Map(objects.map((object) => [object.id, object]));
  const placed: { opening: AIContextObject; wall: AIContextObject; offset: number; sill: number; entry: HostRelationship }[] = [];
  const hosts: HostRelationship[] = [];

  for (const opening of objects) {
    if ((opening.type !== "door" && opening.type !== "window") || typeof opening.hostId !== "string") {
      continue;
    }
    const wall = byId.get(opening.hostId);
    if (!wall || wall.type !== "wall") {
      hosts.push({
        opening: opening.id,
        wall: opening.hostId,
        offset: null,
        sill: null,
        valid: false,
        problems: [wall ? `${opening.hostId} is a ${wall.type}, not a wall.` : `${opening.hostId} isn't in the model.`]
      });
      continue;
    }
    const cos = Math.cos(wall.rotation);
    const sin = Math.sin(wall.rotation);
    const dx = opening.position.x - wall.position.x;
    const dz = opening.position.z - wall.position.z;
    const offset = quantize(dx * cos - dz * sin);
    const plane = quantize(dx * sin + dz * cos);
    const width = opening.dimensions.width ?? 0;
    const height = opening.dimensions.height ?? 0;
    const length = wall.dimensions.length ?? 0;
    const wallHeight = wall.dimensions.height ?? 0;
    const sill = quantize(opening.position.y - height / 2 - (wall.position.y - wallHeight / 2));
    const problems: string[] = [];
    if (Math.abs(plane) > FIT_TOLERANCE) {
      problems.push(`${opening.id} isn't centered in ${wall.id}'s thickness.`);
    }
    if (!sameDirection(opening.rotation, wall.rotation)) {
      problems.push(`${opening.id} isn't turned with ${wall.id}.`);
    }
    if (width > length + FIT_TOLERANCE || Math.abs(offset) > Math.max(0, (length - width) / 2) + FIT_TOLERANCE) {
      problems.push(`${opening.id} runs past the end of ${wall.id}.`);
    }
    if (sill < -FIT_TOLERANCE || sill + height > wallHeight + FIT_TOLERANCE) {
      problems.push(`${opening.id} doesn't fit ${wall.id}'s height.`);
    }
    const entry: HostRelationship = { opening: opening.id, wall: wall.id, offset, sill, valid: false, problems };
    placed.push({ opening, wall, offset, sill, entry });
    hosts.push(entry);
  }

  for (const item of placed) {
    for (const other of placed) {
      if (other === item || other.wall.id !== item.wall.id) {
        continue;
      }
      const alongOverlap =
        Math.abs(item.offset - other.offset) < ((item.opening.dimensions.width ?? 0) + (other.opening.dimensions.width ?? 0)) / 2 - FIT_TOLERANCE;
      const heightOverlap =
        item.sill < other.sill + (other.opening.dimensions.height ?? 0) - FIT_TOLERANCE &&
        other.sill < item.sill + (item.opening.dimensions.height ?? 0) - FIT_TOLERANCE;
      if (alongOverlap && heightOverlap) {
        item.entry.problems.push(`${item.opening.id} overlaps ${other.opening.id} in ${item.wall.id}.`);
      }
    }
  }
  for (const entry of hosts) {
    entry.valid = entry.problems.length === 0;
  }
  return hosts;
}

function endpointOf(object: AIContextObject, endpoint: "start" | "end"): GeometryVector {
  const half = (object.dimensions.length ?? 0) / 2;
  const sign = endpoint === "start" ? -1 : 1;
  return {
    x: object.position.x + sign * Math.cos(object.rotation) * half,
    y: object.position.y,
    z: object.position.z - sign * Math.sin(object.rotation) * half
  };
}

/**
 * Every endpoint connection, reported once per pair (from the side whose
 * id and endpoint sort first, or from the only side that records it):
 * the other element must exist, be of a kind this one connects with, list
 * the connection back, and have its endpoint where this one's is.
 */
function analyzeConnections(objects: readonly AIContextObject[]): ConnectionRelationship[] {
  const byId = new Map(objects.map((object) => [object.id, object]));
  const found: ConnectionRelationship[] = [];
  for (const object of objects) {
    for (const connection of object.connections ?? []) {
      const other = byId.get(connection.objectId);
      const mirrored = !!other?.connections?.some(
        (back) => back.objectId === object.id && back.endpoint === connection.objectEndpoint && back.objectEndpoint === connection.endpoint
      );
      const thisSideFirst =
        compareIds(object.id, connection.objectId) < 0 ||
        (object.id === connection.objectId && connection.endpoint <= connection.objectEndpoint);
      if (mirrored && !thisSideFirst) {
        continue;
      }
      const problems: string[] = [];
      let gap: number | null = null;
      if (!other) {
        problems.push(`${connection.objectId} isn't in the model.`);
      } else {
        const kindConnects =
          object.type === "element" && other.type === "element" && !!object.kind && !!other.kind &&
          (getElementKind(object.kind)?.connectsWith.includes(other.kind) ?? false);
        if (!kindConnects) {
          problems.push(`A ${object.kind ?? object.type} can't connect to a ${other.kind ?? other.type}.`);
        }
        if (!mirrored) {
          problems.push(`${other.id} doesn't record the connection back.`);
        }
        const a = endpointOf(object, connection.endpoint);
        const b = endpointOf(other, connection.objectEndpoint);
        gap = quantize(Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z));
        if (gap > JOINT_TOLERANCE) {
          problems.push(`The endpoints are ${gap} m apart.`);
        }
      }
      found.push({
        a: object.id,
        aEndpoint: connection.endpoint,
        b: connection.objectId,
        bEndpoint: connection.objectEndpoint,
        gap,
        valid: problems.length === 0,
        problems
      });
    }
  }
  return found.sort(
    (x, y) =>
      compareIds(x.a, y.a) || x.aEndpoint.localeCompare(y.aEndpoint) || compareIds(x.b, y.b) || x.bEndpoint.localeCompare(y.bEndpoint)
  );
}
