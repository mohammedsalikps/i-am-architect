export type SelectionListener = (selectedId: string | null) => void;

/**
 * Tracks the single currently-selected object id. Deliberately generic
 * (not wall-specific) so other object types can share it later.
 */
export class SelectionStore {
  private selectedId: string | null = null;
  private readonly listeners = new Set<SelectionListener>();

  select(id: string): void {
    if (this.selectedId === id) {
      return;
    }
    this.selectedId = id;
    this.emit();
  }

  clear(): void {
    if (this.selectedId === null) {
      return;
    }
    this.selectedId = null;
    this.emit();
  }

  get(): string | null {
    return this.selectedId;
  }

  /** Returns an unsubscribe function. Calls the listener once immediately with the current state. */
  subscribe(listener: SelectionListener): () => void {
    this.listeners.add(listener);
    listener(this.selectedId);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener(this.selectedId);
    }
  }
}
