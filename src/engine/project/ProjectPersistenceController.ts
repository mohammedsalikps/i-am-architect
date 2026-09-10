// Explicit .ts extensions on these value imports let Node run this file
// directly (the verify suites do). Harmless for Vite.
import { loadProject, serializeProject } from "./projectPersistence.ts";
import { ProjectAuthError, ProjectNotFoundError } from "./ProjectRepository.ts";
import type { PersistableProject } from "./projectPersistence";
import type { ProjectRecord, ProjectRepository, ProjectSummary } from "./ProjectRepository";
import type { ProjectMetaStore } from "./ProjectMetaStore";

export type ProjectPersistenceStatus =
  | "idle"
  | "creating"
  | "created"
  | "saving"
  | "saved"
  | "opening"
  | "opened"
  | "deleting"
  | "deleted"
  | "error";

export interface ProjectPersistenceState {
  status: ProjectPersistenceStatus;
  /** A one-line outcome for the UI - null while idle. */
  message: string | null;
  /** True when the last operation failed because the user isn't signed in (or their session expired). */
  authRequired: boolean;
}

export type ProjectPersistenceListener = (state: ProjectPersistenceState) => void;

export interface ProjectPersistenceOptions {
  repository: ProjectRepository;
  /** The live project - a ProjectContext satisfies this. */
  project: PersistableProject & { projectMeta: ProjectMetaStore };
}

const IDLE: ProjectPersistenceState = { status: "idle", message: null, authRequired: false };
const BUSY: readonly ProjectPersistenceStatus[] = ["creating", "saving", "opening", "deleting"];

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * DOM-free project workflow - Create, Save, Open, Delete - the same
 * pattern as AiPromptController: one state machine the top bar renders,
 * with the actual work delegated to the injected repository and to
 * serializeProject()/loadProject(). It never touches a store except
 * through loadProject(), and never records history: saving only reads the
 * model.
 *
 * Only one operation runs at a time. A second request while one is in
 * flight is refused (returns false) rather than queued - so a double
 * click never saves twice.
 *
 * A failure because the user isn't signed in (ProjectAuthError) sets
 * `authRequired`, so the UI can ask them to sign in.
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
    return BUSY.includes(this.state.status);
  }

  /**
   * Gives the current model a stored project identity: a new project,
   * owned by the signed-in user, holding the model as it is now (for New
   * Project, an empty one) under the current name. Other stored projects
   * are never touched.
   */
  async createProject(): Promise<boolean> {
    if (this.isBusy()) {
      return false;
    }
    const meta = this.project.projectMeta.get();
    this.setState({ status: "creating", message: `Creating "${meta.name}"…`, authRequired: false });
    try {
      const record = await this.repository.create({ name: meta.name, document: serializeProject(this.project) });
      this.adopt(record, meta.name);
      this.setState({ status: "created", message: `Created "${record.name}".`, authRequired: false });
      return true;
    } catch (error) {
      this.fail("Could not create the project", error);
      return false;
    }
  }

  /**
   * Saves the current model under the current name: a new project the
   * first time, the same project after that. If the stored copy has
   * disappeared (deleted elsewhere, or a restarted in-memory server), it
   * is saved as a new project instead, and the message says so. The whole
   * document is validated by the repository before it is stored.
   */
  async save(): Promise<boolean> {
    if (this.isBusy()) {
      return false;
    }
    const meta = this.project.projectMeta.get();
    this.setState({ status: "saving", message: `Saving "${meta.name}"…`, authRequired: false });

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
      this.adopt(record, meta.name);
      this.setState({ status: "saved", message: `Saved "${record.name}".${note}`, authRequired: false });
      return true;
    } catch (error) {
      this.fail("Save failed", error);
      return false;
    }
  }

  /** The saved projects, for the project chooser. Throws if the repository can't be reached (or the user isn't signed in). */
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
    this.setState({ status: "opening", message: "Opening project…", authRequired: false });

    let record: ProjectRecord | null;
    try {
      record = await this.repository.get(id);
    } catch (error) {
      this.fail("Could not open the project", error);
      return false;
    }
    if (!record) {
      this.setState({ status: "error", message: "That project is no longer stored.", authRequired: false });
      return false;
    }

    const result = loadProject(this.project, record.document);
    if (!result.ok) {
      this.setState({
        status: "error",
        message: `Could not open "${record.name}": ${result.error} The current project was not changed.`,
        authRequired: false
      });
      return false;
    }

    this.project.projectMeta.adopt(record);
    this.setState({ status: "opened", message: `Opened "${record.name}".`, authRequired: false });
    return true;
  }

  /**
   * Deletes one stored project. The model in the workspace is never
   * touched; if it was that project, it simply becomes unsaved (the next
   * Save stores it as a new project).
   */
  async deleteProject(id: string, name: string): Promise<boolean> {
    if (this.isBusy()) {
      return false;
    }
    this.setState({ status: "deleting", message: `Deleting "${name}"…`, authRequired: false });
    try {
      await this.repository.delete(id);
    } catch (error) {
      if (!(error instanceof ProjectNotFoundError)) {
        this.fail("Could not delete the project", error);
        return false;
      }
    }
    if (this.project.projectMeta.get().id === id) {
      this.project.projectMeta.detach();
    }
    this.setState({ status: "deleted", message: `Deleted "${name}".`, authRequired: false });
    return true;
  }

  /** Forgets the last outcome - after New Project, or signing out. */
  reset(): void {
    this.setState(IDLE);
  }

  /** Takes on the stored record's identity, keeping a name typed while the request was in flight. */
  private adopt(record: ProjectRecord, nameWhenSent: string): void {
    const current = this.project.projectMeta.get();
    this.project.projectMeta.adopt({ ...record, name: current.name === nameWhenSent ? record.name : current.name });
  }

  private fail(prefix: string, error: unknown): void {
    this.setState({ status: "error", message: `${prefix}: ${describeError(error)}`, authRequired: error instanceof ProjectAuthError });
  }

  private setState(next: ProjectPersistenceState): void {
    this.state = next;
    for (const listener of this.listeners) {
      listener(next);
    }
  }
}
