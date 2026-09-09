/**
 * Construction-engine wall data model. Framework-agnostic on purpose -
 * no Three.js or DOM types here, so this can be reused by any renderer
 * (including City Builder later).
 */

export type WallId = string;

export interface Vector3Data {
  x: number;
  y: number;
  z: number;
}

export interface WallData {
  id: WallId;
  type: "wall";
  /** Center of the wall box, in meters. y is derived from height so the base rests at y=0. */
  position: Vector3Data;
  /** Rotation around the vertical (Y) axis, in radians. Walls are plan-rotated only for now. */
  rotation: number;
  /** Along the wall's local X axis, in meters. */
  length: number;
  /** In meters. */
  height: number;
  /** Along the wall's local Z axis, in meters. */
  thickness: number;
  /** Material identifier - a placeholder string until a real material system exists. */
  material: string;
  /** Hex color string, e.g. "#c9c9c9". */
  color: string;
}
