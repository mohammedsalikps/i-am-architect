import type { CreateElementOptions } from "./createElement";

/**
 * The named rooms the Rooms ribbon offers. A preset is only a starting
 * point: it creates an ordinary "room" element (see catalog.ts) with this
 * name, footprint and color, and everything about it stays editable.
 */
export interface RoomPreset {
  name: string;
  /** Along local X, in meters. */
  length: number;
  /** Along local Z, in meters. */
  width: number;
  color: string;
}

export const ROOM_PRESETS: readonly RoomPreset[] = Object.freeze([
  { name: "Living Room", length: 5, width: 4.5, color: "#6fa8dc" },
  { name: "Kitchen", length: 3.5, width: 3, color: "#e69138" },
  { name: "Master Bedroom", length: 4.2, width: 3.8, color: "#8e7cc3" },
  { name: "Bedroom", length: 3.6, width: 3.2, color: "#b4a7d6" },
  { name: "Bathroom", length: 2.4, width: 2, color: "#76a5af" },
  { name: "Dining Room", length: 3.6, width: 3.2, color: "#f6b26b" }
]);

/** The element.add options for a preset, optionally at a position. */
export function roomPresetOptions(preset: RoomPreset, position?: { x: number; z: number }): CreateElementOptions {
  return {
    kind: "room",
    label: preset.name,
    dimensions: { length: preset.length, width: preset.width },
    color: preset.color,
    ...(position ? { position: { x: position.x, z: position.z } } : {})
  };
}
