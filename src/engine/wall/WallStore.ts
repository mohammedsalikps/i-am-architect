import type { WallData, WallId } from "./types";

export type WallStoreListener = (walls: WallData[]) => void;

/**
 * In-memory source of truth for wall data. Rendering (Three.js) and UI
 * both subscribe to this instead of talking to each other directly, so
 * either side can be swapped out without touching wall logic.
 */
export class WallStore {
  private readonly walls = new Map<WallId, WallData>();
  private readonly listeners = new Set<WallStoreListener>();

  add(wall: WallData): void {
    this.walls.set(wall.id, wall);
    this.emit();
  }

  /**
   * Merges `changes` into the existing wall. If `height` changes without
   * an explicit `position`, the wall's base is kept resting on the
   * ground by recomputing position.y - this rule lives here so every
   * caller (UI, future tools) gets consistent behavior for free.
   */
  update(id: WallId, changes: Partial<Omit<WallData, "id" | "type">>): void {
    const existing = this.walls.get(id);
    if (!existing) {
      return;
    }

    const next: WallData = { ...existing, ...changes };

    if (changes.height !== undefined && changes.position === undefined) {
      next.position = { ...next.position, y: changes.height / 2 };
    }

    this.walls.set(id, next);
    this.emit();
  }

  /**
   * Overwrites a wall's data exactly - no partial merge, no derived-field
   * side effects (unlike update()). Used to restore an exact historical
   * snapshot for undo/redo, where the snapshot already has whatever
   * position.y etc. was correct at that point in time.
   */
  set(id: WallId, wall: WallData): void {
    this.walls.set(id, wall);
    this.emit();
  }

  remove(id: WallId): void {
    if (this.walls.delete(id)) {
      this.emit();
    }
  }

  get(id: WallId): WallData | undefined {
    return this.walls.get(id);
  }

  getAll(): WallData[] {
    return Array.from(this.walls.values());
  }

  /** Returns an unsubscribe function. Calls the listener once immediately with the current state. */
  subscribe(listener: WallStoreListener): () => void {
    this.listeners.add(listener);
    listener(this.getAll());
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    const walls = this.getAll();
    for (const listener of this.listeners) {
      listener(walls);
    }
  }
}
