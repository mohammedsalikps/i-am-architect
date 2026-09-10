// Explicit .ts extensions on these value imports let Node run this file
// directly (the verify suites do). Harmless for Vite.
import { loadProject, serializeProject } from "./projectPersistence.ts";
import { ProjectNotFoundError } from "./ProjectRepository.ts";
import type { PersistableProject } from "./projectPersistence";
import type { ProjectRecord, ProjectRepository, ProjectSummary } from "./ProjectRepository";
import type { ProjectMetaStore } from "./ProjectMetaStore";

export type ProjectPersistenceStatus = "idle" | "saving" | "saved" | "opening" | "opened" | "error";

export interface ProjectPersistenceState {
  status: ProjectPersistenceStatus;
  /** A one-line outcome for the UI - null while idle. */
  message: string | null;
}

export type ProjectPersistenceListener = (state: ProjectPersistenceState) => void;

export interface ProjectPersistenceOptions {
  repository: ProjectRepository;
  /** The live project - a ProjectContext satisfies this. */
  project: PersistableProject & { projectMeta: ProjectMetaStore };
}

const IDLE: ProjectPersistenceState = { status: "idle", message: null };

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * DOM-free Save/Open workflow - the same pattern as AiPromptController:
 * one state machine the top bar renders, with the actual work delegated to
 * the injected repository and to serializeProject()/loadProject(). It
 * never touches a store except through loadProject(), and never records
 * history: saving only reads the model.
 *
 * Only one save or open runs at a time. A second request while one is in
 * flight is refused (returns false) rather than queued.
 */
export class ProjectPersistenceController {
  private state: ProjectPersistenceState = IDLE;
  private readonly listeners = new Set<ProjectPersistenceListener>();
  private readonly repository: ProjectRepository;
  private readonly project: PersistableProject & { projectMeta: ProjectMetaStore };

  constructor(options: ProjectPersistenceOptions) {
    this.repository = options.repository;
    this.project = options.project;
  }

  getState(): ProjectPersistenceState {
    return this.state;
  }

  /** Returns an unsubscribe function. Calls the listener once immediately with the current state. */
  subscribe(listener: ProjectPersistenceListener): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  isBusy(): boolean {
    return this.state.status === "saving" || this.state.status === "opening";
  }

  /**
   * Saves the current model under the current name: a new project the
   * first time, the same project after that. If the stored copy has
   * disappeared (the backend's in-memory store was restarted), it is
   * saved as a new project instead, and the message says so.
   */
  async save(): Promise<boolean> {
    if (this.isBusy()) {
      return false;
    }
    const meta = this.project.projectMeta.get();
    this.setState({ status: "saving", message: `Saving "${meta.name}"…` });

    const input = { name: meta.name, document: serializeProject(this.project) };
    try {
      let record: ProjectRecord;
      let note = "";
      if (meta.id === null) {
        record = await this.repository.create(input);
      } else {
        try {
          record = await this.repository.save(meta.id, input);
        } catch (error) {
          if (!(error instanceof ProjectNotFoundError)) {
            throw error;
          }
          record = await this.repository.create(input);
          note = " The earlier copy was no longer stored, so it was saved as a new project.";
        }
      }
      // Keep a name typed while the save was in flight.
      const current = this.project.projectMeta.get();
      this.project.projectMeta.adopt({ ...record, name: current.name === meta.name ? record.name : current.name });
      this.setState({ status: "saved", message: `Saved "${record.name}".${note}` });
      return true;
    } catch (error) {
      this.setState({ status: "error", message: `Save failed: ${describeError(error)}` });
      return false;
    }
  }

  /** The saved projects, for the project chooser. Throws if the repository can't be reached. */
  listProjects(): Promise<ProjectSummary[]> {
    return this.repository.list();
  }

  /**
   * Opens a saved project into the workspace, replacing the current model
   * (see loadProject()). If the project can't be fetched or its document
   * is invalid, the current model is left exactly as it was.
   */
  async open(id: string): Promise<boolean> {
    if (this.isBusy()) {
      return false;
    }
    this.setState({ status: "opening", message: "Opening project…" });

    let record: ProjectRecord | null;
    try {
      record = await this.repository.get(id);
    } catch (error) {
      this.setState({ status: "error", message: `Could not open the project: ${describeError(error)}` });
      return false;
    }
    if (!record) {
      this.setState({ status: "error", message: "That project is no longer stored." });
      return false;
    }

    const result = loadProject(this.project, record.document);
    if (!result.ok) {
      this.setState({
        status: "error",
        message: `Could not open "${record.name}": ${result.error} The current project was not changed.`
      });
      return false;
    }

    this.project.projectMeta.adopt(record);
    this.setState({ status: "opened", message: `Opened "${record.name}".` });
    return true;
  }

  /** Forgets the last save/open outcome - after New Project. */
  reset(): void {
    this.setState(IDLE);
  }

  private setState(next: ProjectPersistenceState): void {
    this.state = next;
    for (const listener of this.listeners) {
      listener(next);
    }
  }
}
