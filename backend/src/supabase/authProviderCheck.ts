import { SupabaseUnavailableError, describeUpstream, supabaseRequest } from "./supabaseHttp.ts";
import type { SupabaseConfig, UpstreamShape } from "./supabaseHttp.ts";

/**
 * Is the configured SUPABASE_URL + SUPABASE_ANON_KEY answering like a
 * Supabase Auth server? Separates "this backend is up" (GET /health) from
 * "the sign-in service behind it works" - without signing anyone in.
 *
 * - "health": GET /auth/v1/health. Supabase Auth answers 200 with a JSON
 *   object; a web page, or anything else, is not that.
 * - With `tokenProbes`, two requests carrying deliberately invalid tokens,
 *   which Supabase Auth must REFUSE: GET /auth/v1/user (expected 401/403)
 *   and a refresh-token grant (expected 400/401). These prove only that
 *   refusals come back as refusals - which is what this backend maps to
 *   "session expired" - never that a real sign-in works.
 *
 * Every detail is categorical (status, media type, body kind, redirect,
 * whether the URL looks like a project URL - see describeUpstream()): no
 * URL, key, token or response body is ever included.
 */

export type AuthProviderVerdict = "ok" | "unreachable" | "unexpected-answer";

export interface AuthProviderProbe {
  name: "health" | "invalid access token" | "invalid refresh token";
  outcome: "expected" | "unexpected" | "unreachable";
  /** What came back, in categories - or why nothing did. */
  detail: string;
  status: number | null;
}

export interface AuthProviderReport {
  verdict: AuthProviderVerdict;
  probes: AuthProviderProbe[];
}

/** Placeholder tokens that no Supabase project can accept - they exist only to be refused. */
export const DIAGNOSTIC_ACCESS_TOKEN = "eavara-diagnostic-invalid-access-token";
export const DIAGNOSTIC_REFRESH_TOKEN = "eavara-diagnostic-invalid-refresh-token";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function probe(
  config: SupabaseConfig,
  name: AuthProviderProbe["name"],
  request: () => Promise<{ status: number; payload: unknown; shape: UpstreamShape }>,
  expected: (status: number, payload: unknown, shape: UpstreamShape) => boolean
): Promise<AuthProviderProbe> {
  try {
    const { status, payload, shape } = await request();
    return { name, outcome: expected(status, payload, shape) ? "expected" : "unexpected", detail: describeUpstream(config, shape), status };
  } catch (error) {
    const reason = error instanceof SupabaseUnavailableError ? "no response (network, DNS or timeout)" : "the request failed before any response";
    return { name, outcome: "unreachable", detail: reason, status: null };
  }
}

export async function checkAuthProvider(config: SupabaseConfig, options: { tokenProbes: boolean }): Promise<AuthProviderReport> {
  const probes: AuthProviderProbe[] = [
    await probe(
      config,
      "health",
      () => supabaseRequest(config, "GET", "/auth/v1/health"),
      // A JSON object at all - field names vary between Supabase Auth versions, a web page never is one.
      (status, payload) => status === 200 && isPlainObject(payload)
    )
  ];
  if (options.tokenProbes) {
    probes.push(
      await probe(
        config,
        "invalid access token",
        () => supabaseRequest(config, "GET", "/auth/v1/user", { accessToken: DIAGNOSTIC_ACCESS_TOKEN }),
        (status) => status === 401 || status === 403
      ),
      await probe(
        config,
        "invalid refresh token",
        () => supabaseRequest(config, "POST", "/auth/v1/token?grant_type=refresh_token", { body: { refresh_token: DIAGNOSTIC_REFRESH_TOKEN } }),
        (status) => status === 400 || status === 401
      )
    );
  }
  const verdict: AuthProviderVerdict = probes.some((entry) => entry.outcome === "unreachable")
    ? "unreachable"
    : probes.every((entry) => entry.outcome === "expected")
      ? "ok"
      : "unexpected-answer";
  return { verdict, probes };
}

/** A one-line hint for an unexpected or missing answer - what it usually means, never a certainty. */
export function hintFor(entry: AuthProviderProbe): string | null {
  if (entry.outcome === "expected") return null;
  if (entry.outcome === "unreachable") {
    return "Nothing answered: check SUPABASE_URL's host is right and reachable from this machine.";
  }
  const status = entry.status ?? 0;
  if (status === 200 && /body not JSON|text\/html/.test(entry.detail)) {
    return "A web page answered, not Supabase Auth: SUPABASE_URL most likely isn't the Project URL (Supabase → Project Settings → API).";
  }
  if (status === 200) {
    return "Something answered 200 where Supabase Auth would refuse or describe itself: SUPABASE_URL may not point at a Supabase Auth API.";
  }
  if (status === 401 || status === 403) {
    return entry.name === "health"
      ? "The health check itself was refused: SUPABASE_ANON_KEY may not belong to the project SUPABASE_URL names."
      : null;
  }
  if (status === 404) {
    return "Nothing at that path: SUPABASE_URL may have a path, or point at a different service.";
  }
  if (status >= 500) {
    return "The service answered with a server error: check the project's status in the Supabase dashboard.";
  }
  return null;
}
