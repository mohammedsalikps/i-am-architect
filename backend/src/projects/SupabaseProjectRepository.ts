import {
  ProjectAuthError,
  ProjectNotFoundError,
  ProjectValidationError,
  parseProjectInput
} from "../../../src/engine/project/ProjectRepository.ts";
import type { ProjectInput, ProjectRecord, ProjectRepository, ProjectSummary } from "../../../src/engine/project/ProjectRepository.ts";
import type { ProjectDocument } from "../../../src/engine/project/projectDocument.ts";
import { supabaseMessage, supabaseRequest } from "../supabase/supabaseHttp.ts";
import type { SupabaseConfig } from "../supabase/supabaseHttp.ts";
import type { AuthUser } from "../auth/AuthService.ts";
import type { ProjectStore } from "./ProjectStore.ts";

const TABLE = "/rest/v1/projects";
const RECORD_COLUMNS = "id,user_id,name,created_at,updated_at,document";
const SUMMARY_COLUMNS = "id,name,created_at,updated_at,object_count,assembly_count";
/** Supabase project ids are UUIDs - anything else can't be a stored project, and is never sent to the database. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SupabaseProjectRepositoryOptions extends SupabaseConfig {
  /** The signed-in user - already checked against Supabase Auth by the server. */
  userId: string;
  /** That user's own access token. Every request carries it, so Row Level Security applies to every query. */
  accessToken: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isoTimestamp(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString();
}

function toRecord(row: unknown): ProjectRecord {
  if (
    !isPlainObject(row) ||
    typeof row.id !== "string" ||
    typeof row.user_id !== "string" ||
    typeof row.name !== "string" ||
    typeof row.created_at !== "string" ||
    typeof row.updated_at !== "string" ||
    !isPlainObject(row.document)
  ) {
    throw new Error("Supabase sent a malformed project row.");
  }
  return {
    id: row.id,
    ownerId: row.user_id,
    name: row.name,
    createdAt: isoTimestamp(row.created_at),
    updatedAt: isoTimestamp(row.updated_at),
    // Checked in full by loadProject() in the browser before it touches the model.
    document: row.document as unknown as ProjectDocument
  };
}

function toSummary(row: unknown): ProjectSummary {
  if (
    !isPlainObject(row) ||
    typeof row.id !== "string" ||
    typeof row.name !== "string" ||
    typeof row.created_at !== "string" ||
    typeof row.updated_at !== "string" ||
    typeof row.object_count !== "number" ||
    typeof row.assembly_count !== "number"
  ) {
    throw new Error("Supabase sent a malformed project list.");
  }
  return {
    id: row.id,
    name: row.name,
    createdAt: isoTimestamp(row.created_at),
    updatedAt: isoTimestamp(row.updated_at),
    objectCount: row.object_count,
    assemblyCount: row.assembly_count
  };
}

function rows(payload: unknown): unknown[] {
  if (!Array.isArray(payload)) {
    throw new Error("Supabase sent a malformed response.");
  }
  return payload;
}

function validated(input: unknown): ProjectInput {
  const parsed = parseProjectInput(input);
  if (!parsed.ok) {
    throw new ProjectValidationError(parsed.error);
  }
  return parsed.input;
}

function failure(status: number, payload: unknown): Error {
  if (status === 401) {
    return new ProjectAuthError("Your session expired - sign in again.");
  }
  if (status === 400) {
    return new ProjectValidationError(`The database rejected this project: ${supabaseMessage(payload) ?? "no details"}`);
  }
  // 403 means the table's grants or policies don't match the migration -
  // a server misconfiguration, logged by createServer and reported to the
  // browser only as "Project storage failed."
  return new Error(`Supabase responded with status ${status}: ${supabaseMessage(payload) ?? "no details"}`);
}

/**
 * One signed-in user's projects in Supabase PostgreSQL, through PostgREST
 * (/rest/v1/projects - see supabase/migrations/). Every request carries the
 * anon key AND the user's own access token, so the database runs it as that
 * user: Row Level Security (auth.uid() = user_id) decides which rows exist
 * for them. Another user's project simply isn't there - get() finds
 * nothing, save() and delete() find nothing to change - exactly the
 * behavior InMemoryProjectRepository gives by filtering on owner.
 *
 * The database also stamps created_at/updated_at (a trigger) and refuses
 * to move a project to another user.
 */
export class SupabaseProjectRepository implements ProjectRepository {
  private readonly config: SupabaseConfig;
  private readonly userId: string;
  private readonly accessToken: string;

  constructor(options: SupabaseProjectRepositoryOptions) {
    const { userId, accessToken, ...config } = options;
    this.config = config;
    this.userId = userId;
    this.accessToken = accessToken;
  }

  async create(input: ProjectInput): Promise<ProjectRecord> {
    const valid = validated(input);
    const { status, payload } = await this.send("POST", `${TABLE}?select=${RECORD_COLUMNS}`, {
      user_id: this.userId,
      name: valid.name,
      document: valid.document
    });
    if (status !== 201 && status !== 200) {
      throw failure(status, payload);
    }
    const [row] = rows(payload);
    if (row === undefined) {
      throw new Error("Supabase did not return the new project.");
    }
    return toRecord(row);
  }

  async save(id: string, input: ProjectInput): Promise<ProjectRecord> {
    const valid = validated(input);
    if (!UUID.test(id)) {
      throw new ProjectNotFoundError(id);
    }
    const { status, payload } = await this.send("PATCH", `${TABLE}?id=eq.${id}&select=${RECORD_COLUMNS}`, {
      name: valid.name,
      document: valid.document
    });
    if (status !== 200) {
      throw failure(status, payload);
    }
    const [row] = rows(payload);
    if (row === undefined) {
      throw new ProjectNotFoundError(id);
    }
    return toRecord(row);
  }

  async get(id: string): Promise<ProjectRecord | null> {
    if (!UUID.test(id)) {
      return null;
    }
    const { status, payload } = await this.send("GET", `${TABLE}?id=eq.${id}&select=${RECORD_COLUMNS}`);
    if (status !== 200) {
      throw failure(status, payload);
    }
    const [row] = rows(payload);
    return row === undefined ? null : toRecord(row);
  }

  async list(): Promise<ProjectSummary[]> {
    const { status, payload } = await this.send("GET", `${TABLE}?select=${SUMMARY_COLUMNS}&order=updated_at.desc,name.asc`);
    if (status !== 200) {
      throw failure(status, payload);
    }
    return rows(payload).map(toSummary);
  }

  async delete(id: string): Promise<void> {
    if (!UUID.test(id)) {
      throw new ProjectNotFoundError(id);
    }
    const { status, payload } = await this.send("DELETE", `${TABLE}?id=eq.${id}&select=id`);
    if (status !== 200) {
      throw failure(status, payload);
    }
    if (rows(payload).length === 0) {
      throw new ProjectNotFoundError(id);
    }
  }

  private send(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body?: unknown) {
    return supabaseRequest(this.config, method, path, {
      accessToken: this.accessToken,
      ...(body === undefined ? {} : { body }),
      ...(method === "GET" ? {} : { prefer: "return=representation" })
    });
  }
}

/** The backend's project store when Supabase is configured - one SupabaseProjectRepository per signed-in request. */
export class SupabaseProjectStore implements ProjectStore {
  private readonly config: SupabaseConfig;

  constructor(config: SupabaseConfig) {
    this.config = config;
  }

  forUser(user: AuthUser, accessToken: string): ProjectRepository {
    return new SupabaseProjectRepository({ ...this.config, userId: user.id, accessToken });
  }
}
