// Explicit .ts extension on this value import lets Node run this file
// directly (the backend and the verify suites do). Harmless for Vite.
import { ProjectNotFoundError, ProjectValidationError, parseProjectInput, summarizeProject } from "./ProjectRepository.ts";
import type { ProjectInput, ProjectRecord, ProjectRepository, ProjectSummary } from "./ProjectRepository";

/** The owner of an InMemoryProjectRepository constructed without one - a single local user. */
export const LOCAL_OWNER_ID = "local";

export interface InMemoryProjectRepositoryOptions {
  /** Defaults to the real clock. Tests inject a fixed one. */
  now?: () => Date;
  /** Defaults to a random UUID. Tests inject a counter. */
  newId?: () => string;
  /** Whose projects this repository holds. Defaults to LOCAL_OWNER_ID. */
  ownerId?: string;
  /** The records to keep them in - InMemoryProjectStore shares one map between its users' repositories. */
  records?: Map<string, ProjectRecord>;
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
 * One owner's projects, kept in memory - every test's repository, and the
 * backend's store in local development (see InMemoryProjectStore). They
 * last as long as the process that holds them.
 *
 * It behaves like real storage at its boundary: every write is validated
 * (parseProjectInput) and stored as a copy, every read returns a copy, and
 * another owner's project is indistinguishable from one that doesn't
 * exist - the same rule Row Level Security gives the Supabase repository.
 */
export class InMemoryProjectRepository implements ProjectRepository {
  // Plain fields, not constructor parameter properties - Node runs this
  // file directly, and its TypeScript support only strips types.
  private readonly records: Map<string, ProjectRecord>;
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly ownerId: string;

  constructor(options: InMemoryProjectRepositoryOptions = {}) {
    this.records = options.records ?? new Map();
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? randomProjectId;
    this.ownerId = options.ownerId ?? LOCAL_OWNER_ID;
  }

  async create(input: ProjectInput): Promise<ProjectRecord> {
    const valid = this.validated(input);
    const id = this.newId();
    if (this.records.has(id)) {
      throw new Error(`Project id "${id}" is already in use.`);
    }
    const timestamp = this.now().toISOString();
    const record: ProjectRecord = {
      id,
      ownerId: this.ownerId,
      name: valid.name,
      createdAt: timestamp,
      updatedAt: timestamp,
      document: valid.document
    };
    this.records.set(id, copy(record));
    return copy(record);
  }

  async save(id: string, input: ProjectInput): Promise<ProjectRecord> {
    const existing = this.own(id);
    if (!existing) {
      throw new ProjectNotFoundError(id);
    }
    const valid = this.validated(input);
    const now = this.now().toISOString();
    const record: ProjectRecord = {
      id,
      ownerId: existing.ownerId,
      name: valid.name,
      createdAt: existing.createdAt,
      updatedAt: now < existing.createdAt ? existing.createdAt : now,
      document: valid.document
    };
    this.records.set(id, copy(record));
    return copy(record);
  }

  async get(id: string): Promise<ProjectRecord | null> {
    const record = this.own(id);
    return record ? copy(record) : null;
  }

  async list(): Promise<ProjectSummary[]> {
    return [...this.records.values()]
      .filter((record) => record.ownerId === this.ownerId)
      .map(summarizeProject)
      .sort((a, b) => (a.updatedAt === b.updatedAt ? (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) : a.updatedAt < b.updatedAt ? 1 : -1));
  }

  async delete(id: string): Promise<void> {
    if (!this.own(id)) {
      throw new ProjectNotFoundError(id);
    }
    this.records.delete(id);
  }

  /** The record, if it exists and belongs to this repository's owner. */
  private own(id: string): ProjectRecord | undefined {
    const record = this.records.get(id);
    return record && record.ownerId === this.ownerId ? record : undefined;
  }

  private validated(input: unknown): ProjectInput {
    const parsed = parseProjectInput(input);
    if (!parsed.ok) {
      throw new ProjectValidationError(parsed.error);
    }
    return parsed.input;
  }
}

/**
 * Every user's projects in one in-memory map, handing out a repository
 * scoped to one user at a time - the backend's project store for local
 * development and tests (backend/mockBackend.ts), in place of Supabase.
 */
export class InMemoryProjectStore {
  private readonly records = new Map<string, ProjectRecord>();
  private readonly now: (() => Date) | undefined;
  private readonly newId: (() => string) | undefined;

  constructor(options: { now?: () => Date; newId?: () => string } = {}) {
    this.now = options.now;
    this.newId = options.newId;
  }

  /** The repository holding `user`'s projects - and only theirs. */
  forUser(user: { id: string }): ProjectRepository {
    return new InMemoryProjectRepository({
      records: this.records,
      ownerId: user.id,
      ...(this.now ? { now: this.now } : {}),
      ...(this.newId ? { newId: this.newId } : {})
    });
  }
}
