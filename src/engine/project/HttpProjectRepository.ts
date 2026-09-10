// Explicit .ts extension on this value import lets Node run this file
// directly (the verify suites do). Harmless for Vite.
import { ProjectAuthError, ProjectNotFoundError, ProjectValidationError } from "./ProjectRepository.ts";
import type { ProjectInput, ProjectRecord, ProjectRepository, ProjectSummary } from "./ProjectRepository";
import type { ProjectDocument } from "./projectDocument";

/**
 * The browser's ProjectRepository: a thin client for the backend's
 * /api/projects routes (see backend/src/createServer.ts). It holds no
 * credential of any kind - storage, and any storage secret, lives behind
 * the backend. Like BackendAIProvider, it never reads an environment
 * variable or a global `fetch`: both the base URL and the transport are
 * injected. In the app, the transport is the signed-in user's
 * AuthController.authorize(fetch) - which adds their session token - so
 * the server knows whose projects these are; tests supply mocks.
 *
 * It only checks the envelope of what the server sends. A loaded
 * document is validated in full by loadProject() before it can touch the
 * model, whichever repository it came from.
 */

export interface ProjectHttpResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export type ProjectFetch = (
  url: string,
  init: { method: "GET" | "POST" | "PUT" | "DELETE"; headers: Record<string, string>; body?: string; signal?: AbortSignal }
) => Promise<ProjectHttpResponse>;

export interface HttpProjectRepositoryOptions {
  /** The backend's base URL, e.g. "http://localhost:8787". Required - there is no default. */
  baseUrl: string;
  /** Injected transport - never defaulted to a global fetch. */
  fetch: ProjectFetch;
  /** Milliseconds before a request is abandoned. Defaults to 15000. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const PROJECTS_PATH = "/api/projects";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorText(payload: unknown): string {
  return isPlainObject(payload) && typeof payload.error === "string" ? payload.error : "no details";
}

function parseRecord(value: unknown): ProjectRecord {
  if (
    !isPlainObject(value) ||
    typeof value.id !== "string" ||
    typeof value.ownerId !== "string" ||
    typeof value.name !== "string" ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string" ||
    !isPlainObject(value.document)
  ) {
    throw new Error("The project server sent a malformed project.");
  }
  return {
    id: value.id,
    ownerId: value.ownerId,
    name: value.name,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    document: value.document as unknown as ProjectDocument
  };
}

function parseSummary(value: unknown): ProjectSummary {
  if (
    !isPlainObject(value) ||
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string" ||
    typeof value.objectCount !== "number" ||
    typeof value.assemblyCount !== "number"
  ) {
    throw new Error("The project server sent a malformed project list.");
  }
  return {
    id: value.id,
    name: value.name,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    objectCount: value.objectCount,
    assemblyCount: value.assemblyCount
  };
}

export class HttpProjectRepository implements ProjectRepository {
  // Plain fields, not constructor parameter properties - see
  // InMemoryProjectRepository.ts.
  private readonly baseUrl: string;
  private readonly fetchImpl: ProjectFetch;
  private readonly timeoutMs: number;

  constructor(options: HttpProjectRepositoryOptions) {
    if (!options || typeof options.baseUrl !== "string" || options.baseUrl.trim().length === 0) {
      throw new Error('HttpProjectRepository requires a non-empty "baseUrl".');
    }
    if (typeof options.fetch !== "function") {
      throw new Error('HttpProjectRepository requires an injected "fetch" transport - it never falls back to a global fetch.');
    }
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = options.fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async create(input: ProjectInput): Promise<ProjectRecord> {
    const { status, payload } = await this.request("POST", PROJECTS_PATH, input);
    if (status === 201 || status === 200) {
      return parseRecord(isPlainObject(payload) ? payload.project : undefined);
    }
    if (status === 400) {
      throw new ProjectValidationError(errorText(payload));
    }
    throw this.failure(status, payload);
  }

  async save(id: string, input: ProjectInput): Promise<ProjectRecord> {
    const { status, payload } = await this.request("PUT", `${PROJECTS_PATH}/${encodeURIComponent(id)}`, input);
    if (status === 200) {
      return parseRecord(isPlainObject(payload) ? payload.project : undefined);
    }
    if (status === 404) {
      throw new ProjectNotFoundError(id);
    }
    if (status === 400) {
      throw new ProjectValidationError(errorText(payload));
    }
    throw this.failure(status, payload);
  }

  async get(id: string): Promise<ProjectRecord | null> {
    const { status, payload } = await this.request("GET", `${PROJECTS_PATH}/${encodeURIComponent(id)}`);
    if (status === 200) {
      return parseRecord(isPlainObject(payload) ? payload.project : undefined);
    }
    if (status === 404) {
      return null;
    }
    throw this.failure(status, payload);
  }

  async list(): Promise<ProjectSummary[]> {
    const { status, payload } = await this.request("GET", PROJECTS_PATH);
    if (status !== 200) {
      throw this.failure(status, payload);
    }
    if (!isPlainObject(payload) || !Array.isArray(payload.projects)) {
      throw new Error("The project server sent a malformed project list.");
    }
    return payload.projects.map(parseSummary);
  }

  async delete(id: string): Promise<void> {
    const { status, payload } = await this.request("DELETE", `${PROJECTS_PATH}/${encodeURIComponent(id)}`);
    if (status === 204 || status === 200) {
      return;
    }
    if (status === 404) {
      throw new ProjectNotFoundError(id);
    }
    throw this.failure(status, payload);
  }

  /** Not signed in / session expired -> ProjectAuthError; anything else -> an error naming the status. */
  private failure(status: number, payload: unknown): Error {
    if (status === 401 || status === 403) {
      return new ProjectAuthError(isPlainObject(payload) && typeof payload.error === "string" ? payload.error : undefined);
    }
    return new Error(`The project server responded with status ${status}: ${errorText(payload)}`);
  }

  private async request(method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown): Promise<{ status: number; payload: unknown }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: ProjectHttpResponse;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: body === undefined ? {} : { "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(`The project server did not respond within ${this.timeoutMs}ms.`);
      }
      throw new Error(`Could not reach the project server: ${describeError(error)}`);
    } finally {
      clearTimeout(timer);
    }

    let payload: unknown = null;
    if (response.status !== 204) {
      try {
        payload = await response.json();
      } catch {
        if (response.ok) {
          throw new Error("The project server sent a response that is not JSON.");
        }
      }
    }
    return { status: response.status, payload };
  }
}
