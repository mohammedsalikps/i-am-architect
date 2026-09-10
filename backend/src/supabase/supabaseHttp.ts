/**
 * The HTTP plumbing SupabaseAuthService and SupabaseProjectRepository
 * share. It holds the project URL and the anon (public) key - never a
 * service-role key (config.ts refuses to start with one). Every data
 * request also carries the signed-in user's own access token, so Supabase's
 * Row Level Security decides what that user may read and write.
 *
 * The transport is injected, like every other outbound call in this
 * project: server.ts passes Node's fetch, and the tests pass mocks - so no
 * test ever reaches a real Supabase project.
 */

export interface SupabaseHttpResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export type SupabaseFetch = (
  url: string,
  init: {
    method: "GET" | "POST" | "PATCH" | "DELETE";
    headers: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  }
) => Promise<SupabaseHttpResponse>;

export interface SupabaseConfig {
  /** The project URL, e.g. https://abcdefgh.supabase.co */
  url: string;
  /** The project's anon (public) key. */
  anonKey: string;
  fetch: SupabaseFetch;
  /** Milliseconds before a request is abandoned. Defaults to 15000. */
  timeoutMs?: number;
}

/** Supabase couldn't be reached at all - no response, or none in time. */
export class SupabaseUnavailableError extends Error {
  constructor(reason: string) {
    super(`Could not reach Supabase: ${reason}`);
    this.name = "SupabaseUnavailableError";
  }
}

const DEFAULT_TIMEOUT_MS = 15_000;

export interface SupabaseRequestOptions {
  /** The signed-in user's access token, sent as "Authorization: Bearer ...". */
  accessToken?: string;
  body?: unknown;
  /** PostgREST's Prefer header, e.g. "return=representation". */
  prefer?: string;
}

/** Sends one request and returns its status and parsed JSON body (null when there is none). Throws SupabaseUnavailableError when there is no response. */
export async function supabaseRequest(
  config: SupabaseConfig,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  options: SupabaseRequestOptions = {}
): Promise<{ status: number; payload: unknown }> {
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const headers: Record<string, string> = { apikey: config.anonKey, Accept: "application/json" };
  if (options.accessToken) {
    headers.Authorization = `Bearer ${options.accessToken}`;
  }
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  if (options.prefer) {
    headers.Prefer = options.prefer;
  }

  let response: SupabaseHttpResponse;
  try {
    response = await config.fetch(`${config.url.replace(/\/+$/, "")}${path}`, {
      method,
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      signal: controller.signal
    });
  } catch (error) {
    throw new SupabaseUnavailableError(
      controller.signal.aborted ? `no response within ${timeoutMs}ms` : error instanceof Error ? error.message : String(error)
    );
  } finally {
    clearTimeout(timer);
  }

  let payload: unknown = null;
  if (response.status !== 204) {
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
  }
  return { status: response.status, payload };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The human-readable message in a Supabase error body (Auth uses msg / error_description, PostgREST uses message), or null. */
export function supabaseMessage(payload: unknown): string | null {
  if (!isPlainObject(payload)) {
    return null;
  }
  for (const key of ["msg", "error_description", "message", "error"]) {
    const value = payload[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return null;
}

/** Supabase Auth's machine-readable error code ("invalid_credentials", "user_already_exists"...), or "". */
export function supabaseErrorCode(payload: unknown): string {
  return isPlainObject(payload) && typeof payload.error_code === "string" ? payload.error_code : "";
}
