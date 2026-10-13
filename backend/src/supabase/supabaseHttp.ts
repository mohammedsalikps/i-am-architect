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
  /** Present on a real fetch Response - read only for diagnostics (see describeUpstream). */
  headers?: { get(name: string): string | null };
  /** Present on a real fetch Response: true when a redirect was followed to get it. */
  redirected?: boolean;
}

/**
 * What an answer looked like, in categories only - never its URL, headers'
 * values beyond the media type, or body content. Enough to tell "a
 * Supabase Auth JSON error" from "an HTML page from something else".
 */
export interface UpstreamShape {
  status: number;
  /** The media type alone ("application/json", "text/html"), or null when there was none. */
  mediaType: string | null;
  body: "json-object" | "json-other" | "not-json";
  redirected: boolean;
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

/** Sends one request and returns its status, parsed JSON body (null when there is none) and shape. Throws SupabaseUnavailableError when there is no response. */
export async function supabaseRequest(
  config: SupabaseConfig,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  options: SupabaseRequestOptions = {}
): Promise<{ status: number; payload: unknown; shape: UpstreamShape }> {
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
  let parsed = false;
  if (response.status !== 204) {
    try {
      payload = await response.json();
      parsed = true;
    } catch {
      payload = null;
    }
  }
  const mediaType = response.headers?.get("content-type")?.split(";")[0].trim().toLowerCase() || null;
  const shape: UpstreamShape = {
    status: response.status,
    mediaType,
    body: !parsed ? "not-json" : isPlainObject(payload) ? "json-object" : "json-other",
    redirected: response.redirected === true
  };
  return { status: response.status, payload, shape };
}

/**
 * Whether a configured project URL looks like a Supabase project's API
 * base: a *.supabase.co (or .in) host - or localhost, for a local
 * Supabase - and no path (this code appends /auth/v1/..., /rest/v1/...
 * itself). Custom domains are legitimate, so this only informs, never
 * refuses. Categories only - never the URL.
 */
export function describeProjectUrl(url: string): { supabaseHost: boolean; hasPath: boolean } {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    return {
      supabaseHost: /\.supabase\.(co|in)$/.test(host) || host === "localhost" || host === "127.0.0.1",
      hasPath: parsed.pathname.replace(/\/+$/, "") !== "" || parsed.search !== "" || parsed.hash !== ""
    };
  } catch {
    return { supabaseHost: false, hasPath: false };
  }
}

/** One log line's worth of what an unusable answer was - e.g. "HTTP 200, text/html, body not JSON, not redirected; SUPABASE_URL host is not a project host (*.supabase.co or localhost), no path". */
export function describeUpstream(config: Pick<SupabaseConfig, "url">, shape: UpstreamShape): string {
  const url = describeProjectUrl(config.url);
  const body = shape.body === "json-object" ? "JSON object" : shape.body === "json-other" ? "JSON, not an object" : "body not JSON";
  return (
    `HTTP ${shape.status}, ${shape.mediaType ?? "no content-type"}, ${body}, ${shape.redirected ? "after a redirect" : "not redirected"}; ` +
    `SUPABASE_URL host ${url.supabaseHost ? "is" : "is not"} a project host (*.supabase.co or localhost), ${url.hasPath ? "HAS a path" : "no path"}`
  );
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
