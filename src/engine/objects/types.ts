/**
 * Shared construction-object foundation. Every buildable thing in the
 * workspace (walls today; pillars, beams, slabs, doors, windows,
 * roofing, furniture, landscaping, etc. later) is modeled as a
 * ConstructionObjectBase<TType, TDimensions> - a common envelope
 * (id/type/position/rotation/material/color/assemblyId) around a
 * type-specific `dimensions` shape.
 *
 * No Three.js or DOM imports here, or anywhere under src/engine/ - see
 * objects/README.md for which layer owns data, history, and rendering.
 */

export type ObjectId = string;

export interface Vector3Data {
  x: number;
  y: number;
  z: number;
}

/**
 * Every construction object type this app plans to support. "wall" and
 * "pillar" are implemented; the rest are reserved extension points so
 * adding a new type only needs to touch this union once.
 */
export type ObjectType =
  | "wall"
  | "pillar"
  | "beam"
  | "slab"
  | "door"
  | "window"
  | "roof"
  | "furniture"
  | "landscaping";

/**
 * Common shape shared by every construction object, regardless of type.
 * `TDimensions` is intentionally left to each object type to define - a
 * wall's length/height/thickness has nothing in common with a future
 * door's or pillar's size fields. See src/engine/wall/types.ts for a
 * concrete example of instantiating this generic.
 */
export interface ConstructionObjectBase<
  TType extends ObjectType = ObjectType,
  TDimensions = Record<string, number>
> {
  id: ObjectId;
  type: TType;
  /** Center of the object's bounding volume, in meters. */
  position: Vector3Data;
  /** Rotation around the vertical (Y) axis, in radians. */
  rotation: number;
  /** Type-specific size fields (e.g. a wall's length/height/thickness). */
  dimensions: TDimensions;
  /** Material identifier - a placeholder string until a real material system exists. */
  material: string;
  /** Hex color string, e.g. "#c9c9c9". */
  color: string;
  /** Id of the assembly this object belongs to, or null if ungrouped. Reserved - assemblies aren't implemented yet. */
  assemblyId: string | null;
}
