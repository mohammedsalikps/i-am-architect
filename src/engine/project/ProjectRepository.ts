// Explicit .ts extension on this value import lets Node run this file
// directly (the backend and the verify suites do). Harmless for Vite.
import { parseProjectDocument, parseProjectName } from "./projectDocument.ts";
import type { ProjectDocument } from "./projectDocument";

/**
 * Where projects are stored - an interface, so nothing else in the app
 * depends on a particular storage. Implementations:
 *
 * - HttpProjectRepository - the browser's client for the backend's
 *   /api/projects routes (it holds no storage credential of any kind).
 * - InMemoryProjectRepository - one user's projects in memory: every
 *   test's store, and the backend's store in local development.
 * - SupabaseProjectRepository (backend/src/projects/) - one user's
 *   projects in Supabase PostgreSQL, accessed with that user's own token
 *   so Row Level Security enforces ownership.
 *
 * Every repository is scoped to ONE owner: it only ever creates, lists,
 * reads, saves, and deletes that owner's projects. Another owner's project
 * behaves exactly like a project that doesn't exist (null / not found) -
 * it isn't even revealed to exist. See project/README.md.
 *
 * Every operation is async, because real storage is.
 */

export interface ProjectInput {
  name: string;
  document: ProjectDocument;
}

/** One stored project. Timestamps are ISO 8601 strings. */
export interface ProjectRecord {
  id: string;
  /** The user who owns it - the only one who can read, save, or delete it. */
  ownerId: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  document: ProjectDocument;
}

/** What a project list shows - a record without its document. */
export interface ProjectSummary {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  objectCount: number;
  assemblyCount: number;
}

export interface ProjectRepository {
  /** Stores a new project for this repository's owner and returns it with its new id and timestamps. */
  create(input: ProjectInput): Promise<ProjectRecord>;
  /** Replaces a stored project's name and document. Throws ProjectNotFoundError if the owner has no such project. */
  save(id: string, input: ProjectInput): Promise<ProjectRecord>;
  /** The owner's stored project, or null if they have none with that id. */
  get(id: string): Promise<ProjectRecord | null>;
  /** Every one of the owner's stored projects, most recently updated first. */
  list(): Promise<ProjectSummary[]>;
  /** Deletes one of the owner's projects. Throws ProjectNotFoundError if they have no such project. */
  delete(id: string): Promise<void>;
}

export class ProjectNotFoundError extends Error {
  readonly projectId: string;

  constructor(projectId: string) {
    super(`No saved project with id "${projectId}".`);
    this.name = "ProjectNotFoundError";
    this.projectId = projectId;
  }
}

/** The name or document was rejected - see parseProjectDocument(). */
export class ProjectValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectValidationError";
  }
}

/** The request wasn't signed in, or the session has expired - sign in (again) and retry. */
export class ProjectAuthError extends Error {
  constructor(message = "Sign in to save and open projects.") {
    super(message);
    this.name = "ProjectAuthError";
  }
}

export type ParsedProjectInput = { ok: true; input: ProjectInput } | { ok: false; error: string };

/** Validates an untrusted `{ name, document }` - a request body, or a caller's input. */
export function parseProjectInput(value: unknown): ParsedProjectInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, error: 'Expected an object with a "name" and a "document".' };
  }
  const raw = value as Record<string, unknown>;
  const name = parseProjectName(raw.name);
  if (!name.ok) {
    return { ok: false, error: name.error };
  }
  const document = parseProjectDocument(raw.document);
  if (!document.ok) {
    return { ok: false, error: `Invalid project document: ${document.error}` };
  }
  return { ok: true, input: { name: name.name, document: document.document } };
}

export function summarizeProject(record: ProjectRecord): ProjectSummary {
  return {
    id: record.id,
    name: record.name,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    objectCount: record.document.objects.length,
    assemblyCount: record.document.assemblies.length
  };
}
