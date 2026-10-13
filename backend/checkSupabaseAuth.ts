/**
 * Checks a SUPABASE_URL + SUPABASE_ANON_KEY pair against the real project
 * they name, from this machine - the same settings the hosted backend uses
 * (Render → the backend service → Environment), copied into a local,
 * gitignored env file. Run from backend/:
 *
 *   npm run check:supabase                       (reads backend/.env)
 *   node --env-file=<file> checkSupabaseAuth.ts  (any other env file)
 *
 * It never signs anyone in, never needs a password, and never prints the
 * URL, the key, a token or a response body - only categories (status,
 * media type, body kind, redirect, whether the URL looks like a project
 * URL) and what they usually mean. See supabase/authProviderCheck.ts.
 *
 * Exit code 0 when Supabase Auth answers as expected, 1 otherwise.
 */
import { isPrivilegedSupabaseKey, supabaseUrlProblem, supabaseUrlWarnings } from "./src/config.ts";
import { checkAuthProvider, hintFor } from "./src/supabase/authProviderCheck.ts";
import type { SupabaseFetch } from "./src/supabase/supabaseHttp.ts";

const url = process.env.SUPABASE_URL?.trim();
const anonKey = process.env.SUPABASE_ANON_KEY?.trim();

function keyFormat(key: string): string {
  if (key.startsWith("sb_publishable_")) return "a publishable key (sb_publishable_...)";
  if (key.split(".").length === 3) return "a JWT-format key";
  return "an unrecognised format - expected the anon / publishable key";
}

async function main(): Promise<number> {
  if (!url || !anonKey) {
    console.log("Set both SUPABASE_URL and SUPABASE_ANON_KEY in the env file this reads (their values are never printed).");
    return 1;
  }
  const problem = supabaseUrlProblem(url);
  console.log(`SUPABASE_URL: ${problem ?? "a valid URL"}`);
  for (const warning of supabaseUrlWarnings(url)) console.log(`  warning: ${warning}`);
  if (isPrivilegedSupabaseKey(anonKey)) {
    console.log("SUPABASE_ANON_KEY: a service-role / secret key - the backend refuses to start with it. Use the anon / publishable key.");
    return 1;
  }
  console.log(`SUPABASE_ANON_KEY: present, ${keyFormat(anonKey)}`);
  if (problem) return 1;

  const fetchImpl: SupabaseFetch = (target, init) => fetch(target, init);
  const report = await checkAuthProvider({ url, anonKey, fetch: fetchImpl }, { tokenProbes: true });
  console.log("");
  for (const probe of report.probes) {
    console.log(`${probe.name}: ${probe.outcome} - ${probe.detail}`);
    const hint = hintFor(probe);
    if (hint) console.log(`  -> ${hint}`);
  }
  console.log("");
  if (report.verdict === "ok") {
    console.log("Verdict: Supabase Auth answers as expected - its health check answers with JSON, and it refuses invalid tokens the way the backend maps to \"session expired\".");
    console.log("This does NOT prove a real sign-in works: sign in with a real test account to check that.");
    return 0;
  }
  if (report.verdict === "unreachable") {
    console.log("Verdict: Supabase Auth could not be reached with these settings - the backend will report the sign-in service as unreachable (502).");
    return 1;
  }
  // What the backend itself would then say - derived from what the token
  // probes got, since that's exactly what SupabaseAuthService maps.
  const statusOf = (name: string) => report.probes.find((probe) => probe.name === name)?.status ?? null;
  // Exactly what SupabaseAuthService turns each answer into (200 unusable → "malformed", 5xx → unavailable, other 4xx → expired).
  const outcome = (status: number | null, malformed: string) =>
    status === 200 ? `502 "The sign-in service sent a malformed ${malformed}."` : status !== null && status >= 500 ? "502 sign-in service unavailable" : '401 "Your session expired"';
  console.log("Verdict: something answered, but not the way Supabase Auth does. The backend would answer:");
  console.log(`  a session check (any AI or project request): ${outcome(statusOf("invalid access token"), "user")}`);
  console.log(`  a refresh or sign-in:                        ${outcome(statusOf("invalid refresh token"), "session")}`);
  return 1;
}

process.exitCode = await main();
