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
  /** Commands collected since beginGroup(), or null when no group is open. */
  private group: Command[] | null = null;
  private readonly listeners = new Set<HistoryListener>();

  /**
   * Records a command that has already been performed once (the caller
   * does the actual mutation, then hands this the undo/redo pair). A
   * new recorded command always clears the redo stack. No-ops while a
   * replay (undo/redo) is in progress, so replaying never re-records.
   * While a group is open (see beginGroup), the command is collected
   * into that group instead.
   */
  record(command: Command): void {
    if (this.replaying) {
      return;
    }
    if (this.group) {
      this.group.push(command);
      return;
    }
    this.undoStack.push(command);
    this.redoStack = [];
    this.emit();
  }

  /**
   * Starts collecting recorded commands into ONE history entry instead of
   * one each - for a gesture, such as a mouse drag, that makes many small
   * edits the user thinks of as a single action. Close it with endGroup()
   * (keep the result) or cancelGroup() (throw it away). Groups don't nest.
   */
  beginGroup(): void {
    if (this.group) {
      throw new Error("A history group is already open - call endGroup() or cancelGroup() first.");
    }
    this.group = [];
  }

  /**
   * Closes the open group and records everything it collected as one
   * entry: undo runs each collected undo, newest first; redo runs each
   * redo, oldest first - exactly the state before and after the whole
   * group. An empty group records nothing.
   */
  endGroup(): void {
    const commands = this.group;
    this.group = null;
    if (!commands || commands.length === 0) {
      return;
    }
    this.record(
      commands.length === 1
        ? commands[0]
        : {
            undo: () => {
              for (let index = commands.length - 1; index >= 0; index -= 1) {
                commands[index].undo();
              }
            },
            redo: () => {
              for (const command of commands) {
                command.redo();
              }
            }
          }
    );
  }

  /**
   * Closes the open group without recording it: undoes everything it
   * collected (newest first), so the model is back where the group
   * began, and leaves the undo/redo stacks exactly as they were.
   */
  cancelGroup(): void {
    const commands = this.group;
    this.group = null;
    if (!commands || commands.length === 0) {
      return;
    }
    this.replaying = true;
    try {
      for (let index = commands.length - 1; index >= 0; index -= 1) {
        commands[index].undo();
      }
    } finally {
      this.replaying = false;
    }
  }

  isGrouping(): boolean {
    return this.group !== null;
  }

  /** Does nothing while a group is open - a half-finished gesture isn't an entry yet. */
  undo(): void {
    if (this.group) {
      return;
    }
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

  /** Does nothing while a group is open, like undo(). */
  redo(): void {
    if (this.group) {
      return;
    }
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
