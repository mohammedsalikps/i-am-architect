// Explicit .ts extension on this value import (the others are type-only)
// lets Node run this module directly - see geometry/verify.ts and
// e2e/verify.ts. Harmless for Vite.
import { compareIds } from "../types.ts";
import type { AIContextObject, AIProjectSnapshot } from "../types";
import type {
  AxisAlignedBox,
  ConstructionGeometryAnalysis,
  GeometryError,
  GeometryVector,
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

function axesFor(type: string): Readonly<LocalAxisDimensions> | undefined {
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
  const axes = axesFor(object.type);

  if (!axes) {
    errors.push({ field: "type", message: `Geometry isn't defined for object type "${object.type}".` });
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
    const axes = axesFor(object.type);
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

  return { objects, relationships, invalidObjects };
}
