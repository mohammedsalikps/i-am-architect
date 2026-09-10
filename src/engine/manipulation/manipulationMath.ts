// Explicit .ts extension on this value import lets Node run this module
// directly - see manipulation/verify.ts. Harmless for Vite.
import { localAxesFor } from "../ai/geometry/analyzeConstructionGeometry.ts";
import { getElementKind } from "../elements/catalog.ts";

/**
 * Pure math for mouse manipulation: turns where the pointer grabbed and
 * where it is now - points on a drag plane, in world meters - into the
 * property values a gesture asks for. No Three.js, DOM, stores, or
 * commands here: ObjectManipulator.ts sends the result through
 * CommandExecutor, and src/scene/manipulation/ does the raycasting.
 *
 * Coordinates are the app's own: world X/Y/Z in meters, +Y up, rotation
 * in radians around Y exactly as the mesh builders apply it (Three.js
 * rotation.y turns local +X to world (cos t, 0, -sin t)).
 *
 * Every gesture is measured from where it started and changes values in
 * whole increments (MOVE_STEP, RESIZE_STEP, ROTATE_STEP). So grabbing an
 * object never makes it jump, an off-grid value keeps its precision, and
 * the same pointer path always gives the same result.
 */

export type ManipulationAxis = "x" | "y" | "z";
export type HandleSide = 1 | -1;

export interface Point3 {
  x: number;
  y: number;
  z: number;
}

/** Moves change X and Z in 0.1 m increments. */
export const MOVE_STEP = 0.1;
/** Resizes change a dimension in 0.1 m increments. */
export const RESIZE_STEP = 0.1;
/** Rotations change in 1 degree increments. */
export const ROTATE_STEP = Math.PI / 180;

/** How far outside an object's face its resize handle sits, in meters. */
export const HANDLE_OFFSET = 0.35;
/** How far above the object's base the side handles sit, so a grounded object's handles clear the ground. */
export const HANDLE_LIFT = 0.15;
/** How far the rotation ring sits beyond the object's corners, in meters - clear of the side handles. */
export const ROTATE_RING_MARGIN = 0.8;

const PRECISION = 1e9;

/** Rounds to 9 decimal places (a nanometre) so float noise like 0.1 + 0.2 = 0.30000000000000004 never reaches the store. */
export function roundValue(value: number): number {
  const rounded = Math.round(value * PRECISION) / PRECISION;
  return rounded === 0 ? 0 : rounded; // folds -0 into 0
}

/** `value` rounded to the nearest whole multiple of `step`. */
export function snapToStep(value: number, step: number): number {
  return roundValue(Math.round(value / step) * step);
}

/** The world direction of an object's local axis, for its rotation around Y. */
export function localAxis(rotation: number, axis: ManipulationAxis): Point3 {
  switch (axis) {
    case "x":
      return { x: Math.cos(rotation), y: 0, z: -Math.sin(rotation) };
    case "z":
      return { x: Math.sin(rotation), y: 0, z: Math.cos(rotation) };
    case "y":
      return { x: 0, y: 1, z: 0 };
  }
}

/**
 * Which of an object's dimensions runs along a local axis - the verified
 * mesh-builder mapping for the six original types, the element catalog
 * for an element (pass its `kind`). Never a guess.
 */
export function dimensionForAxis(type: string, axis: ManipulationAxis, kind?: string): string | undefined {
  return localAxesFor(type, kind)?.[axis];
}

/**
 * Move on the horizontal X/Z plane: the object's center follows the
 * pointer's X/Z travel since the grab, in MOVE_STEP increments. Y is
 * never changed - the object keeps its current height.
 */
export function computeMove(start: Point3, grab: Point3, current: Point3, step: number = MOVE_STEP): Point3 {
  return {
    x: roundValue(start.x + snapToStep(current.x - grab.x, step)),
    y: start.y,
    z: roundValue(start.z + snapToStep(current.z - grab.z, step))
  };
}

export interface ResizeTarget {
  axis: ManipulationAxis;
  /** Which face is being dragged: +1 the face on the local axis's positive side, -1 the other one. */
  side: HandleSide;
  /** The dimension that runs along `axis` - see dimensionForAxis(). */
  dimension: string;
}

export interface ResizeResult {
  dimensions: Record<string, number>;
  position: Point3;
}

/**
 * Resize by dragging one face: the opposite face stays where it is, the
 * dimension along the handle's axis changes by the pointer's travel along
 * that axis (RESIZE_STEP increments), and the center moves by half the
 * change so it stays centered. For the vertical axis only the top face
 * has a handle, so the bottom stays put.
 *
 * The result may be zero or negative when the pointer crosses the
 * opposite face - it is returned as-is, and the store's validator rejects
 * it. Nothing here clamps or bypasses validation.
 */
export function computeResize(
  object: { position: Point3; rotation: number; dimensions: Record<string, number> },
  target: ResizeTarget,
  grab: Point3,
  current: Point3,
  step: number = RESIZE_STEP
): ResizeResult {
  const axis = localAxis(object.rotation, target.axis);
  const travel =
    ((current.x - grab.x) * axis.x + (current.y - grab.y) * axis.y + (current.z - grab.z) * axis.z) * target.side;
  const size = object.dimensions[target.dimension];
  const newSize = roundValue(size + snapToStep(travel, step));
  const shift = ((newSize - size) / 2) * target.side;

  return {
    dimensions: { [target.dimension]: newSize },
    position: {
      x: roundValue(object.position.x + axis.x * shift),
      y: roundValue(object.position.y + axis.y * shift),
      z: roundValue(object.position.z + axis.z * shift)
    }
  };
}

/** Angle, in the app's rotation convention, of the horizontal direction from `center` to `point` - or null when they coincide. */
function headingTo(center: Point3, point: Point3): number | null {
  const dx = point.x - center.x;
  const dz = point.z - center.z;
  if (Math.hypot(dx, dz) < 1e-9) {
    return null;
  }
  return Math.atan2(-dz, dx);
}

/**
 * Rotate around the object's vertical axis: the rotation changes by the
 * angle the pointer swept around the object's center since the grab
 * (ROTATE_STEP increments). The sweep is taken the short way round, so
 * crossing +/-180 degrees doesn't flip it. A pointer exactly over the
 * center leaves the rotation unchanged.
 */
export function computeRotation(
  object: { position: Point3; rotation: number },
  grab: Point3,
  current: Point3,
  step: number = ROTATE_STEP
): number {
  const from = headingTo(object.position, grab);
  const to = headingTo(object.position, current);
  if (from === null || to === null) {
    return object.rotation;
  }
  let sweep = to - from;
  while (sweep > Math.PI) sweep -= 2 * Math.PI;
  while (sweep <= -Math.PI) sweep += 2 * Math.PI;
  return roundValue(object.rotation + snapToStep(sweep, step));
}

export interface ResizeHandleLayout extends ResizeTarget {
  /** Where the handle sits, relative to the object's center, in its rotated local frame. */
  position: Point3;
}

export interface EndpointHandleLayout {
  endpoint: "start" | "end";
  /** Where the handle sits, relative to the object's center, in its rotated local frame. */
  position: Point3;
}

export interface HandleLayout {
  resize: ResizeHandleLayout[];
  /** A ring in the object's base plane, around its center - null for a door or window in a wall, which turns with the wall. */
  rotate: { radius: number; y: number } | null;
  /** A linear element's two endpoint handles (they replace its lengthwise resize handles); empty for everything else. */
  endpoints: EndpointHandleLayout[];
}

/**
 * Where an object's manipulation handles go: one resize handle just
 * outside each face along local X and Z, placed on the object's base
 * plane (its footprint) so the faces themselves stay free for grabbing
 * the body to move it; one on top for the vertical dimension; and a
 * rotation ring around the base, outside the side handles. Every resize
 * handle is tied to a dimension the object really has (see
 * dimensionForAxis) - returns null for a type or shape it can't place
 * handles on. An element passes its `kind`.
 *
 * A linear element (pipe, conduit, cable) gets a handle ON each endpoint
 * instead of its two lengthwise handles: dragging one moves that end and
 * keeps the other. A door or window in a wall (`hostId`) gets no rotation
 * ring - it turns with its wall.
 */
export function layoutHandles(object: {
  type: string;
  kind?: string;
  hostId?: string | null;
  dimensions: Record<string, number>;
}): HandleLayout | null {
  const x = dimensionForAxis(object.type, "x", object.kind);
  const y = dimensionForAxis(object.type, "y", object.kind);
  const z = dimensionForAxis(object.type, "z", object.kind);
  if (!x || !y || !z) {
    return null;
  }
  const halfX = object.dimensions[x] / 2;
  const halfY = object.dimensions[y] / 2;
  const halfZ = object.dimensions[z] / 2;
  if (![halfX, halfY, halfZ].every((half) => Number.isFinite(half) && half > 0)) {
    return null;
  }

  const base = roundValue(-halfY + HANDLE_LIFT);
  const linear = object.type === "element" && !!object.kind && !!getElementKind(object.kind)?.linear;
  const hosted = (object.type === "door" || object.type === "window") && typeof object.hostId === "string";
  const lengthwise: ResizeHandleLayout[] = [
    { axis: "x", side: 1, dimension: x, position: { x: halfX + HANDLE_OFFSET, y: base, z: 0 } },
    { axis: "x", side: -1, dimension: x, position: { x: -(halfX + HANDLE_OFFSET), y: base, z: 0 } }
  ];
  return {
    resize: [
      ...(linear ? [] : lengthwise),
      { axis: "z", side: 1, dimension: z, position: { x: 0, y: base, z: halfZ + HANDLE_OFFSET } },
      { axis: "z", side: -1, dimension: z, position: { x: 0, y: base, z: -(halfZ + HANDLE_OFFSET) } },
      { axis: "y", side: 1, dimension: y, position: { x: 0, y: halfY + HANDLE_OFFSET, z: 0 } }
    ],
    rotate: hosted ? null : { radius: roundValue(Math.hypot(halfX, halfZ) + ROTATE_RING_MARGIN), y: -halfY },
    endpoints: linear
      ? [
          { endpoint: "start", position: { x: -halfX, y: 0, z: 0 } },
          { endpoint: "end", position: { x: halfX, y: 0, z: 0 } }
        ]
      : []
  };
}
