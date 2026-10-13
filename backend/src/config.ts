/**
 * Reads the server's configuration from an environment - process.env in
 * server.ts, a plain object in the tests. Nothing here is ever sent to a
 * browser, and no secret from it is ever echoed back in an error message.
 *
 * AI_PROVIDER chooses which real AIProvider server.ts constructs -
 * "openai" (the default, unchanged from before AI_PROVIDER existed),
 * "gemini", or "anthropic" (Claude). Only the chosen provider's own key is
 * required: OPENAI_API_KEY for "openai", GEMINI_API_KEY for "gemini",
 * ANTHROPIC_API_KEY for "anthropic" - the others are never read. Claude
 * also takes optional ANTHROPIC_MODEL and ANTHROPIC_EFFORT. See
 * src/engine/ai/providers/OpenAIProvider.ts, GeminiProvider.ts and
 * AnthropicProvider.ts.
 *
 * Accounts and projects are kept in ONE of two places:
 *
 * - Supabase: SUPABASE_URL + SUPABASE_ANON_KEY (the project's anon /
 *   publishable key). A service-role or secret key is refused outright -
 *   this server relies on Row Level Security, and never needs a key that
 *   bypasses it.
 * - Memory: LOCAL_AUTH=memory, for local development only. Accounts and
 *   projects last until the server stops, so it is refused when
 *   NODE_ENV=production.
 *
 * Neither is assumed: with no choice made, the server refuses to start and
 * says how to choose.
 *
 * FRONTEND_ORIGIN lists the browser origins allowed to call the server -
 * comma-separated, exact origins (the deployed frontend, and
 * http://localhost:5173 for development). Wildcards are refused, and a
 * non-local origin must use https.
 */

import { describeProjectUrl } from "./supabase/supabaseHttp.ts";
// The SDK-free settings module - config never loads the Anthropic SDK.
import { ANTHROPIC_EFFORTS } from "../../src/engine/ai/providers/anthropicSettings.ts";
import type { AnthropicEffort } from "../../src/engine/ai/providers/anthropicSettings.ts";

export type StorageConfig ={ mode: "supabase"; url: string; anonKey: string } | { mode: "memory" };

/**
 * Which real AIProvider to construct, and its own (only) API key -
 * server.ts passes this straight to `new OpenAIProvider({ apiKey, fetch })`
 * or `new GeminiProvider({ apiKey, fetch })`. Never both fields at once:
 * the unused provider's key is never read from the environment at all,
 * so it need not even be set.
 */
export type AIProviderConfig =
  | { provider: "openai"; apiKey: string }
  | { provider: "gemini"; apiKey: string }
  /** Claude, through the Anthropic SDK. `model` (ANTHROPIC_MODEL) and `effort` (ANTHROPIC_EFFORT) are optional - AnthropicProvider defaults them. */
  | { provider: "anthropic"; apiKey: string; model?: string; effort?: AnthropicEffort };

export interface ServerConfig {
  ai: AIProviderConfig;
  port: number;
  /** The exact browser origins allowed to call this server (CORS). */
  frontendOrigins: string[];
  storage: StorageConfig;
  /** NODE_ENV=production. */
  production: boolean;
}

export type ServerConfigResult = { ok: true; config: ServerConfig } | { ok: false; error: string };

const DEFAULT_PORT = 8787;
export const DEFAULT_FRONTEND_ORIGIN = "http://localhost:5173";
const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * True for a key that bypasses Row Level Security: the "sb_secret_..."
 * format, or a legacy JWT key whose role claim is "service_role".
 */
export function isPrivilegedSupabaseKey(key: string): boolean {
  if (key.startsWith("sb_secret_")) {
    return true;
  }
  const parts = key.split(".");
  if (parts.length !== 3) {
    return false;
  }
  try {
    const claims: unknown = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return isPlainObject(claims) && claims.role === "service_role";
  } catch {
    return false;
  }
}

/**
 * The exact origins in a FRONTEND_ORIGIN value ("https://app.example.com,
 * http://localhost:5173"), or why it isn't a valid list. Blank means the
 * local Vite dev server.
 */
export function parseFrontendOrigins(value: string | undefined): { ok: true; origins: string[] } | { ok: false; error: string } {
  const entries = (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (entries.length === 0) {
    return { ok: true, origins: [DEFAULT_FRONTEND_ORIGIN] };
  }
  const origins: string[] = [];
  for (const entry of entries) {
    if (entry.includes("*")) {
      return { ok: false, error: "FRONTEND_ORIGIN must list exact origins - wildcards are refused." };
    }
    let url: URL;
    try {
      url = new URL(entry);
    } catch {
      return { ok: false, error: `FRONTEND_ORIGIN entry "${entry}" is not a valid origin - use scheme://host[:port].` };
    }
    if (url.origin.toLowerCase() !== entry.replace(/\/$/, "").toLowerCase()) {
      return { ok: false, error: `FRONTEND_ORIGIN entry "${entry}" is not an origin - use scheme://host[:port], with no path.` };
    }
    if (url.protocol !== "https:" && !(url.protocol === "http:" && LOCAL_HOSTNAMES.has(url.hostname))) {
      return { ok: false, error: `FRONTEND_ORIGIN entry "${entry}" must use https:// (http:// is allowed only for localhost).` };
    }
    if (!origins.includes(url.origin)) {
      origins.push(url.origin);
    }
  }
  return { ok: true, origins };
}

/**
 * Warnings - never refusals - for a SUPABASE_URL that passes validation
 * but doesn't look like a project's API base URL (Supabase dashboard →
 * Project Settings → API → Project URL, "https://<ref>.supabase.co"):
 * this server appends /auth/v1/... and /rest/v1/... itself, so any path
 * sends every request somewhere else. Custom domains are legitimate, hence
 * a warning. (A dashboard link, or a *.supabase.co URL with a path, is
 * refused outright by supabaseUrlProblem below.) The messages never
 * include the value.
 */
export function supabaseUrlWarnings(value: string): string[] {
  const { supabaseHost, hasPath } = describeProjectUrl(value);
  const warnings: string[] = [];
  if (!supabaseHost) {
    warnings.push(
      "SUPABASE_URL's host is not a *.supabase.co project host. That is fine for a custom domain; otherwise use the Project URL from Supabase → Project Settings → API."
    );
  }
  if (hasPath) {
    warnings.push(
      "SUPABASE_URL has a path, query or fragment. Use the bare Project URL (https://<ref>.supabase.co) - this server adds /auth/v1/... itself, so a path sends every sign-in request elsewhere."
    );
  }
  return warnings;
}

export function supabaseUrlProblem(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "SUPABASE_URL is not a valid URL - use the project URL from the Supabase dashboard (https://<project>.supabase.co).";
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    return "SUPABASE_URL must use https:// (http:// is allowed only for a local Supabase on localhost).";
  }
  // Refusals, not warnings: no Supabase API lives on these, so the server
  // could only ever fail. The dashboard (supabase.com/dashboard/project/...,
  // app.supabase.com/project/...) answers every request - sign-in and
  // refresh included - with HTTP 200 and a web page, which reached users
  // as "The sign-in service sent a malformed session."
  const host = url.hostname.toLowerCase();
  if (host === "supabase.com" || host.endsWith(".supabase.com")) {
    return (
      "SUPABASE_URL is a Supabase dashboard or website link, not the project's API URL - the dashboard answers sign-in " +
      "with a web page. Use Supabase → Project Settings → API → Project URL: https://<ref>.supabase.co, where <ref> is " +
      "the id after /project/ in the dashboard link."
    );
  }
  const { supabaseHost, hasPath } = describeProjectUrl(value);
  if (supabaseHost && !local && hasPath) {
    return (
      "SUPABASE_URL must be the bare Project URL, https://<ref>.supabase.co, with no path, query or fragment - this " +
      "server adds /auth/v1/... and /rest/v1/... itself."
    );
  }
  return null;
}

/**
 * AI_PROVIDER, defaulting to "openai" when unset - the behavior every
 * config that predates AI_PROVIDER (nothing but OPENAI_API_KEY) still
 * gets unchanged. Only the chosen provider's key is validated below.
 */
function readAIProviderConfig(env: Record<string, string | undefined>): { ok: true; ai: AIProviderConfig } | { ok: false; error: string } {
  const raw = env.AI_PROVIDER?.trim().toLowerCase();
  const provider = raw || "openai";
  if (provider !== "openai" && provider !== "gemini" && provider !== "anthropic") {
    return { ok: false, error: 'AI_PROVIDER must be "openai", "gemini" or "anthropic".' };
  }

  if (provider === "anthropic") {
    const apiKey = env.ANTHROPIC_API_KEY?.trim();
    if (!apiKey) {
      return {
        ok: false,
        error:
          "Missing ANTHROPIC_API_KEY environment variable (AI_PROVIDER=anthropic). Copy backend/.env.example to " +
          "backend/.env, fill in an Anthropic API key from the Claude Console (Settings -> API keys), and start this " +
          "server with: node --env-file=.env src/server.ts"
      };
    }
    if (apiKey.startsWith("sk-ant-admin")) {
      return { ok: false, error: "ANTHROPIC_API_KEY holds an Admin API key, which can't call the Messages API. Use a regular API key." };
    }
    const model = env.ANTHROPIC_MODEL?.trim();
    if (model && !/^claude-[a-z0-9][a-z0-9.-]*$/.test(model)) {
      return { ok: false, error: 'ANTHROPIC_MODEL must be a Claude model id such as "claude-sonnet-5-5" - or leave it unset for the default.' };
    }
    const effort = env.ANTHROPIC_EFFORT?.trim().toLowerCase();
    if (effort && !ANTHROPIC_EFFORTS.includes(effort as AnthropicEffort)) {
      return { ok: false, error: `ANTHROPIC_EFFORT must be one of ${ANTHROPIC_EFFORTS.join(", ")} - or leave it unset for the default.` };
    }
    return {
      ok: true,
      ai: { provider: "anthropic", apiKey, ...(model ? { model } : {}), ...(effort ? { effort: effort as AnthropicEffort } : {}) }
    };
  }

  if (provider === "gemini") {
    const apiKey = env.GEMINI_API_KEY?.trim();
    if (!apiKey) {
      return {
        ok: false,
        error:
          "Missing GEMINI_API_KEY environment variable (AI_PROVIDER=gemini). Copy backend/.env.example to " +
          "backend/.env, fill in a real Gemini API key from https://aistudio.google.com/apikey, and start this " +
          "server with: node --env-file=.env src/server.ts"
      };
    }
    return { ok: true, ai: { provider: "gemini", apiKey } };
  }

  const apiKey = env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    return {
      ok: false,
      error:
        "Missing OPENAI_API_KEY environment variable. Copy backend/.env.example to backend/.env, fill in a real " +
        "OpenAI API key, and start this server with: node --env-file=.env src/server.ts - or set " +
        "AI_PROVIDER=gemini and GEMINI_API_KEY instead."
    };
  }
  return { ok: true, ai: { provider: "openai", apiKey } };
}

export function readServerConfig(env: Record<string, string | undefined>): ServerConfigResult {
  const aiResult = readAIProviderConfig(env);
  if (!aiResult.ok) {
    return { ok: false, error: aiResult.error };
  }

  const rawPort = env.PORT?.trim();
  const port = rawPort ? Number(rawPort) : DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { ok: false, error: "PORT must be a whole number from 1 to 65535." };
  }

  const origins = parseFrontendOrigins(env.FRONTEND_ORIGIN);
  if (!origins.ok) {
    return { ok: false, error: origins.error };
  }
  const production = env.NODE_ENV?.trim() === "production";
  const base = { ai: aiResult.ai, port, frontendOrigins: origins.origins, production };

  const url = env.SUPABASE_URL?.trim();
  const anonKey = env.SUPABASE_ANON_KEY?.trim();
  if (url || anonKey) {
    if (!url || !anonKey) {
      return { ok: false, error: "Set both SUPABASE_URL and SUPABASE_ANON_KEY (see backend/.env.example), or neither." };
    }
    const problem = supabaseUrlProblem(url);
    if (problem) {
      return { ok: false, error: problem };
    }
    if (isPrivilegedSupabaseKey(anonKey)) {
      return {
        ok: false,
        error:
          "SUPABASE_ANON_KEY holds a service-role (secret) key. Use the project's anon / publishable key instead - " +
          "this server relies on Row Level Security and never needs a key that bypasses it."
      };
    }
    return { ok: true, config: { ...base, storage: { mode: "supabase", url, anonKey } } };
  }

  if (env.LOCAL_AUTH?.trim() === "memory") {
    if (production) {
      return {
        ok: false,
        error:
          "LOCAL_AUTH=memory keeps accounts and projects in memory - it is for local development and is refused when " +
          "NODE_ENV=production. Configure SUPABASE_URL and SUPABASE_ANON_KEY instead."
      };
    }
    return { ok: true, config: { ...base, storage: { mode: "memory" } } };
  }

  return {
    ok: false,
    error:
      "No account storage is configured. Set SUPABASE_URL and SUPABASE_ANON_KEY to use Supabase (see backend/README.md), " +
      "or set LOCAL_AUTH=memory for local development with in-memory accounts and projects that last until the server stops."
  };
}
