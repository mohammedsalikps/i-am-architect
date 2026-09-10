// Explicit .ts extension on this value import lets Node run this file
// directly (the backend and the verify suites do). Harmless for Vite.
import { ProjectNotFoundError, ProjectValidationError, parseProjectInput, summarizeProject } from "./ProjectRepository.ts";
import type { ProjectInput, ProjectRecord, ProjectRepository, ProjectSummary } from "./ProjectRepository";

export interface InMemoryProjectRepositoryOptions {
  /** Defaults to the real clock. Tests inject a fixed one. */
  now?: () => Date;
  /** Defaults to a random UUID. Tests inject a counter. */
  newId?: () => string;
}

function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function randomProjectId(): string {
  const cryptoApi = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (cryptoApi?.randomUUID) {
    return cryptoApi.randomUUID();
  }
  return `project-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * A ProjectRepository kept in memory - the backend's project store until
 * a database is configured, and the repository every test uses. Projects
 * last as long as the process that holds them.
 *
 * It behaves like real storage at its boundary: every write is validated
 * (parseProjectInput) and stored as a copy, and every read returns a
 * copy, so no caller can reach into a stored project.
 */
export class InMemoryProjectRepository implements ProjectRepository {
  // Plain fields, not constructor parameter properties - Node runs this
  // file directly, and its TypeScript support only strips types.
  private readonly records = new Map<string, ProjectRecord>();
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(options: InMemoryProjectRepositoryOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? randomProjectId;
  }

  async create(input: ProjectInput): Promise<ProjectRecord> {
    const valid = this.validated(input);
    const id = this.newId();
    if (this.records.has(id)) {
      throw new Error(`Project id "${id}" is already in use.`);
    }
    const timestamp = this.now().toISOString();
    const record: ProjectRecord = { id, name: valid.name, createdAt: timestamp, updatedAt: timestamp, document: valid.document };
    this.records.set(id, copy(record));
    return copy(record);
  }

  async save(id: string, input: ProjectInput): Promise<ProjectRecord> {
    const existing = this.records.get(id);
    if (!existing) {
      throw new ProjectNotFoundError(id);
    }
    const valid = this.validated(input);
    const now = this.now().toISOString();
    const record: ProjectRecord = {
      id,
      name: valid.name,
      createdAt: existing.createdAt,
      updatedAt: now < existing.createdAt ? existing.createdAt : now,
      document: valid.document
    };
    this.records.set(id, copy(record));
    return copy(record);
  }

  async get(id: string): Promise<ProjectRecord | null> {
    const record = this.records.get(id);
    return record ? copy(record) : null;
  }

  async list(): Promise<ProjectSummary[]> {
    return [...this.records.values()]
      .map(summarizeProject)
      .sort((a, b) => (a.updatedAt === b.updatedAt ? (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) : a.updatedAt < b.updatedAt ? 1 : -1));
  }

  private validated(input: unknown): ProjectInput {
    const parsed = parseProjectInput(input);
    if (!parsed.ok) {
      throw new ProjectValidationError(parsed.error);
    }
    return parsed.input;
  }
}
