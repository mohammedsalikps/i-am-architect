export type VisibilityListener = (hidden: ReadonlySet<string>) => void;

/**
 * Which construction objects are hidden in the viewport right now - a
 * purely client-side, session-only concern. Deliberately NOT part of
 * ProjectContext/the saved project document: hiding an object never
 * deletes or mutates it (never a store write, never a command, never
 * touches AICommandPipeline or persistence) - it only ever toggles a
 * Three.js mesh's own `.visible` flag, in whichever *Layer owns that
 * mesh (see SceneManager.ts, which is the only place this class is
 * constructed and threaded to every layer). A reload/reopen always
 * starts with everything visible; this store's state does not survive
 * one (a documented, intentional limitation - see UI_MILESTONE notes).
 *
 * "Isolate" hides everything except a given set of ids, remembering
 * exactly the hidden-state that was true the moment isolation started -
 * not "everything else", so exiting isolation restores whatever was
 * already hidden before, unchanged. Isolation nests safely: a second
 * isolate() call while already isolating narrows further, and any
 * exitIsolation() returns all the way to the pre-isolation state.
 */
export class VisibilityStore {
  private readonly hiddenIds = new Set<string>();
  private readonly listeners = new Set<VisibilityListener>();
  private isolationSnapshot: Set<string> | null = null;

  isHidden(id: string): boolean {
    return this.hiddenIds.has(id);
  }

  setHidden(id: string, hidden: boolean): void {
    const before = this.hiddenIds.has(id);
    if (hidden === before) {
      return;
    }
    if (hidden) {
      this.hiddenIds.add(id);
    } else {
      this.hiddenIds.delete(id);
    }
    this.emit();
  }

  toggle(id: string): void {
    this.setHidden(id, !this.hiddenIds.has(id));
  }

  /** Every id currently hidden - a fresh Set, safe for a caller to keep. */
  getHidden(): ReadonlySet<string> {
    return new Set(this.hiddenIds);
  }

  isIsolating(): boolean {
    return this.isolationSnapshot !== null;
  }

  /**
   * Hides every id in `allIds` that is not in `keepVisible`. The
   * hidden-state at the moment this is called is remembered (only on the
   * first call of an isolation - a second, narrower isolate() while
   * already isolating does not overwrite that memory), so
   * exitIsolation() always returns to how things were before isolating
   * started, not to "everything visible".
   */
  isolate(keepVisible: Iterable<string>, allIds: Iterable<string>): void {
    if (this.isolationSnapshot === null) {
      this.isolationSnapshot = new Set(this.hiddenIds);
    }
    const keep = new Set(keepVisible);
    this.hiddenIds.clear();
    for (const id of allIds) {
      if (!keep.has(id)) {
        this.hiddenIds.add(id);
      }
    }
    this.emit();
  }

  /** Restores whatever was hidden before the current isolation started. A no-op when not isolating. */
  exitIsolation(): void {
    if (this.isolationSnapshot === null) {
      return;
    }
    this.hiddenIds.clear();
    for (const id of this.isolationSnapshot) {
      this.hiddenIds.add(id);
    }
    this.isolationSnapshot = null;
    this.emit();
  }

  /** Fires immediately with the current state, like every other store's subscribe(). */
  subscribe(listener: VisibilityListener): () => void {
    this.listeners.add(listener);
    listener(this.getHidden());
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    const snapshot = this.getHidden();
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }
}
