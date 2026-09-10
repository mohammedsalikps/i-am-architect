/**
 * The center height that keeps an object's base where it is when its
 * vertical size - a height, or a slab's thickness - changes from
 * `oldSize` to `newSize`. Every *Store.update() uses it when a size
 * change arrives without an explicit position.
 *
 * An object resting on the ground (base at y = 0) stays on the ground,
 * which is exactly the old "y = size / 2" rule. One raised off the
 * ground - a window on its sill, a wall standing on a slab - keeps its
 * base at the same height instead of dropping to the ground.
 *
 * Rounded to 9 decimals, the precision the geometry analysis uses, so
 * repeated edits don't accumulate floating-point noise.
 */
export function keepBaseY(centerY: number, oldSize: number, newSize: number): number {
  return Math.round((centerY - oldSize / 2 + newSize / 2) * 1e9) / 1e9;
}
