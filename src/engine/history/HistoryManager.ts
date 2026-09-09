/**
 * Generic undo/redo history. Deliberately knows nothing about walls (or
 * any other object type) - it only stores Commands. Domain-specific
 * adapters (e.g. wallHistory.ts) turn a domain mutation into a Command
 * and hand it to this class, which is how new object types (pillars,
 * beams, slabs, doors, ...) plug in later without changing this file.
 */
export interface Command {
  undo(): void;
  redo(): void;
}

export type HistoryListener = () => void;

export class HistoryManager {
  private undoStack: Command[] = [];
  private redoStack: Command[] = [];
  private replaying = false;
  private readonly listeners = new Set<HistoryListener>();

  /**
   * Records a command that has already been performed once (the caller
   * does the actual mutation, then hands this the undo/redo pair). A
   * new recorded command always clears the redo stack. No-ops while a
   * replay (undo/redo) is in progress, so replaying never re-records.
   */
  record(command: Command): void {
    if (this.replaying) {
      return;
    }
    this.undoStack.push(command);
    this.redoStack = [];
    this.emit();
  }

  undo(): void {
    const command = this.undoStack.pop();
    if (!command) {
      return;
    }
    this.replaying = true;
    try {
      command.undo();
    } finally {
      this.replaying = false;
    }
    this.redoStack.push(command);
    this.emit();
  }

  redo(): void {
    const command = this.redoStack.pop();
    if (!command) {
      return;
    }
    this.replaying = true;
    try {
      command.redo();
    } finally {
      this.replaying = false;
    }
    this.undoStack.push(command);
    this.emit();
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  clearHistory(): void {
    this.undoStack = [];
    this.redoStack = [];
    this.emit();
  }

  /** Returns an unsubscribe function. Calls the listener once immediately with the current state. */
  subscribe(listener: HistoryListener): () => void {
    this.listeners.add(listener);
    listener();
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}
