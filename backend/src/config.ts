/**
 * Reads the server's configuration from an environment - process.env in
 * server.ts, a plain object in the tests. Nothing here is ever sent to a
 * browser, and no secret from it is ever echoed back in an error message.
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

export type StorageConfig = { mode: "supabase"; url: string; anonKey: string } | { mode: "memory" };

export interface ServerConfig {
  openAIApiKey: string;
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

function supabaseUrlProblem(value: string): string | null {
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
  return null;
}

export function readServerConfig(env: Record<string, string | undefined>): ServerConfigResult {
  const openAIApiKey = env.OPENAI_API_KEY?.trim();
  if (!openAIApiKey) {
    return {
      ok: false,
      error:
        "Missing OPENAI_API_KEY environment variable. Copy backend/.env.example to backend/.env, fill in a real " +
        "OpenAI API key, and start this server with: node --env-file=.env src/server.ts"
    };
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
  const base = { openAIApiKey, port, frontendOrigins: origins.origins, production };

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
