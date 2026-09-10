import type { ObjectType } from "../../objects/types";

/**
 * Output shapes for analyzeConstructionGeometry() - see ../README.md
 * "Construction geometry analysis" for the coordinate conventions.
 *
 * Everything here is plain JSON data: numbers, booleans, strings, and
 * nested literals. No class instances, functions, timestamps, or
 * references back into the snapshot the analysis was built from.
 */

/** A point or extent in world coordinates, in meters. */
export interface GeometryVector {
  x: number;
  y: number;
  z: number;
}

/** An axis-aligned bounding box in world coordinates: the smallest box, with faces parallel to the world axes, that contains the whole object. */
export interface AxisAlignedBox {
  min: GeometryVector;
  max: GeometryVector;
}

/** Which of an object type's dimension fields runs along each of its local (unrotated) axes. */
export interface LocalAxisDimensions {
  x: string;
  y: string;
  z: string;
}

/** Geometric facts about one construction object. */
export interface ObjectGeometry {
  id: string;
  type: ObjectType;
  /** The snapshot's `position` - the center of the object's bounding volume. */
  center: GeometryVector;
  /** The object's own dimension fields, copied from the snapshot, keys sorted. */
  dimensions: Record<string, number>;
  /** Rotation around the vertical (Y) axis, in radians, exactly as the snapshot gives it. */
  rotation: number;
  /** World-space extent of `aabb` along each axis (max - min). */
  size: GeometryVector;
  aabb: AxisAlignedBox;
}

/**
 * Where one object's whole bounding box lies relative to another's, on
 * each world axis. "Completely": every point of the first box is on that
 * side - a box that merely touches the other's face counts, one that
 * overlaps it by any amount doesn't. Several can be true at once (e.g.
 * leftOf and inFrontOf), and all six are false when the boxes overlap.
 */
export interface DirectionalRelation {
  /** Entirely at smaller X. */
  leftOf: boolean;
  /** Entirely at larger X. */
  rightOf: boolean;
  /** Entirely at larger Z (toward the Front view's camera). */
  inFrontOf: boolean;
  /** Entirely at smaller Z (away from the Front view's camera). */
  behind: boolean;
  /** Entirely at larger Y. */
  above: boolean;
  /** Entirely at smaller Y. */
  below: boolean;
}

/**
 * Spatial facts about one pair of objects. Each pair appears once, with
 * `a` before `b` in object-id order; the facts about `b` relative to `a`
 * are the mirror image (leftOf <-> rightOf, and so on).
 */
export interface ObjectPairRelationship {
  /** Id of the first object in the pair. */
  a: string;
  /** Id of the second object in the pair. */
  b: string;
  /** b's center minus a's center, per axis. */
  centerDelta: GeometryVector;
  /** Straight-line distance between the two centers. */
  centerDistance: number;
  /** Distance between the centers in the horizontal X/Z plane, ignoring height. */
  horizontalDistance: number;
  /** Absolute difference between the centers' Y values. */
  verticalDistance: number;
  /**
   * Whether the boxes' projections onto each axis share some length (a
   * face merely touching the other doesn't count). `aabb` is true only
   * when all three axes overlap - i.e. the boxes share volume.
   */
  overlap: { x: boolean; y: boolean; z: boolean; aabb: boolean };
  /** Clear space between the boxes along each axis; 0 when they overlap or touch on that axis. */
  gap: GeometryVector;
  aRelativeToB: DirectionalRelation;
}

/** Same shape as every object validator's errors (validateWall.ts, ...). */
export interface GeometryError {
  field: string;
  message: string;
}

/** An object whose geometry can't be derived - excluded from `objects` and `relationships`. */
export interface InvalidObjectGeometry {
  id: string;
  type: ObjectType;
  errors: GeometryError[];
}

export interface ConstructionGeometryAnalysis {
  /** Every object with valid geometry, sorted by id. */
  objects: ObjectGeometry[];
  /** One entry per pair of `objects`, ordered by the pair's ids. */
  relationships: ObjectPairRelationship[];
  /** Objects whose geometry couldn't be derived, sorted by id. Always empty for a snapshot built from the real stores, which reject such objects. */
  invalidObjects: InvalidObjectGeometry[];
}
