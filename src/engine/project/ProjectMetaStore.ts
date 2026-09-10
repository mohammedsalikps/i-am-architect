// Explicit .ts extension on this value import lets Node run this file
// directly. Harmless for Vite.
import { parseProjectName } from "./projectDocument.ts";

export const DEFAULT_PROJECT_NAME = "Untitled Project";

/** Which saved project the model in the stores belongs to, if any, and its name. */
export interface ProjectMeta {
  /** The saved project's id, or null until the project is first saved. */
  id: string | null;
  name: string;
  /** ISO timestamps from the last save or open; null for a project that was never saved. */
  createdAt: string | null;
  updatedAt: string | null;
}

export type ProjectMetaListener = (meta: ProjectMeta) => void;

const UNSAVED: ProjectMeta = { id: null, name: DEFAULT_PROJECT_NAME, createdAt: null, updatedAt: null };

/**
 * The current project's identity. It is not part of the construction
 * model and not undoable: renaming, saving, or opening a project never
 * records history. Same subscribe() convention as every other store.
 */
export class ProjectMetaStore {
  private meta: ProjectMeta = { ...UNSAVED };
  private readonly listeners = new Set<ProjectMetaListener>();

  get(): ProjectMeta {
    return { ...this.meta };
  }

  /** Renames the project. A blank or over-long name is refused (returns false) and the name stays as it was. */
  rename(name: string): boolean {
    const parsed = parseProjectName(name);
    if (!parsed.ok) {
      return false;
    }
    if (parsed.name !== this.meta.name) {
      this.set({ ...this.meta, name: parsed.name });
    }
    return true;
  }

  /** Takes on a stored project's identity - after it was saved, or opened. */
  adopt(record: { id: string; name: string; createdAt: string; updatedAt: string }): void {
    this.set({ id: record.id, name: record.name, createdAt: record.createdAt, updatedAt: record.updatedAt });
  }

  /** Forgets the stored project this model belonged to (it was deleted), keeping the name - the model is now unsaved. */
  detach(): void {
    this.set({ ...this.meta, id: null, createdAt: null, updatedAt: null });
  }

  /** Back to a new, never-saved "Untitled Project" - see clearProject(). */
  reset(): void {
    this.set({ ...UNSAVED });
  }

  /** Returns an unsubscribe function. Calls the listener once immediately with the current state. */
  subscribe(listener: ProjectMetaListener): () => void {
    this.listeners.add(listener);
    listener(this.get());
    return () => this.listeners.delete(listener);
  }

  private set(next: ProjectMeta): void {
    this.meta = next;
    for (const listener of this.listeners) {
      listener(this.get());
    }
  }
}
