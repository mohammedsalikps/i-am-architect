/**
 * Dimension text for the labels drawn in the 3D view - one rounding rule
 * everywhere: metres to 2 decimals (1 cm), trailing zeros dropped, the way
 * the Architect says them ("4.5 m", "4.73 m"). The model keeps its full
 * precision; this is display only. Pure and testable.
 */

export function formatLength(metres: number): string {
  return `${Number(metres.toFixed(2))} m`;
}

/** "Kitchen 4.5 × 5 m" - a room's floor, length (east-west) by width (north-south). */
export function roomDimensionText(name: string | undefined, length: number, width: number): string {
  const size = `${Number(length.toFixed(2))} × ${Number(width.toFixed(2))} m`;
  return name ? `${name} ${size}` : size;
}

/** "4.73 m" - a wall's length along its centre line. */
export function wallDimensionText(length: number): string {
  return formatLength(length);
}

/** "30 m" / "40 m" - a plot edge. */
export function plotEdgeText(length: number): string {
  return formatLength(length);
}

/**
 * What the dimension labels currently show, in words - for screen readers
 * and checks. `covered`: rooms and walls under a visible roof, which aren't
 * labelled until the roof is hidden.
 */
export function dimensionSummary(rooms: number, walls: number, covered: { rooms: number; walls: number } = { rooms: 0, walls: 0 }): string {
  const part = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? "" : "s"}`;
  const under = covered.rooms + covered.walls > 0 ? ` ${part(covered.rooms, "room")} and ${part(covered.walls, "wall")} are under the roof - hide the roof to label them.` : "";
  if (rooms === 0 && walls === 0) return under ? `No dimensions shown.${under}` : "No dimensions to show.";
  return `Dimensions shown: ${part(rooms, "room")}, ${part(walls, "wall")}.${under}`;
}
