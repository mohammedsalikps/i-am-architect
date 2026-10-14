import { createServer } from "./createServer.ts";
import { readServerConfig, supabaseUrlWarnings } from "./config.ts";
import { OpenAIProvider } from "../../src/engine/ai/providers/OpenAIProvider.ts";
import { GeminiProvider } from "../../src/engine/ai/providers/GeminiProvider.ts";
import { DEFAULT_ANTHROPIC_EFFORT, DEFAULT_ANTHROPIC_MODEL } from "../../src/engine/ai/providers/anthropicSettings.ts";
import type { AnthropicFetch } from "../../src/engine/ai/providers/AnthropicProvider.ts";
import type { AIProvider } from "../../src/engine/ai/AIProvider.ts";
import { InMemoryProjectStore } from "../../src/engine/project/InMemoryProjectRepository.ts";
import { InMemoryAuthService } from "./auth/InMemoryAuthService.ts";
import { SupabaseAuthService } from "./auth/SupabaseAuthService.ts";
import { checkAuthProvider } from "./supabase/authProviderCheck.ts";
import type { AuthProviderReport } from "./supabase/authProviderCheck.ts";
import type { AuthService } from "./auth/AuthService.ts";
import { SupabaseProjectStore } from "./projects/SupabaseProjectRepository.ts";
import type { ProjectStore } from "./projects/ProjectStore.ts";
import type { SupabaseFetch } from "./supabase/supabaseHttp.ts";

/**
 * Entry point for the backend. THIS IS THE ONLY FILE IN THE ENTIRE
 * REPOSITORY (frontend or backend) THAT READS `process.env` - it hands it
 * to readServerConfig() (config.ts), which picks out AI_PROVIDER and its
 * key (OPENAI_API_KEY or GEMINI_API_KEY), the account-storage settings,
 * and the allowed frontend origins. See backend/README.md "Security
 * posture" and DEPLOYMENT.md. Run with:
 *
 *   node --env-file=.env src/server.ts          (local, from backend/)
 *   node backend/src/server.ts                  (a host, env set by the host - see the Dockerfile)
 *
 * `--env-file` is a stable Node.js flag (18.20+/20.6+) - no `dotenv`
 * dependency needed. Node 22.18+ runs these TypeScript files directly.
 */

const result = readServerConfig(process.env);
if (!result.ok) {
  console.error(result.error);
  process.exit(1);
}
const config = result.config;

// Adapts the real global `fetch` to the minimal injected fetch shape both
// OpenAIProvider and GeminiProvider expect (structurally identical - see
// each file's own *Fetch type). This one-line adapter is the ONLY place
// in this whole project a real network transport is ever handed to
// either provider; every test (frontend and backend) passes a mock
// instead.
const nodeFetch = (url: string, init: { method: "POST"; headers: Record<string, string>; body: string }) => fetch(url, init);

// AI_PROVIDER (config.ts) decides which one gets constructed - only its
// own key was read from the environment; see readServerConfig().
// Claude goes through the official Anthropic SDK, which takes the same
// kind of injected fetch (its own wider signature) - the key reaches it
// only here, from ANTHROPIC_API_KEY, and never leaves the server. The
// provider (and so the SDK package) is loaded ONLY when AI_PROVIDER is
// "anthropic": a Gemini or OpenAI deployment never needs it installed.
let provider: AIProvider;
if (config.ai.provider === "anthropic") {
  const { AnthropicProvider } = await import("../../src/engine/ai/providers/AnthropicProvider.ts");
  const anthropicFetch: AnthropicFetch = (input, init) => fetch(input, init);
  provider = new AnthropicProvider({
    apiKey: config.ai.apiKey,
    fetch: anthropicFetch,
    model: config.ai.model,
    effort: config.ai.effort,
    // One JSON line per answered Claude request - which model served it and
    // Anthropic's request id (to find it in the Claude Console), never the
    // user's instruction, the project or the answer.
    onMessage: (summary) => console.log(JSON.stringify({ time: new Date().toISOString(), event: "ai.anthropic", ...summary }))
  });
} else {
  provider =
    config.ai.provider === "gemini"
      ? new GeminiProvider({ apiKey: config.ai.apiKey, fetch: nodeFetch })
      : new OpenAIProvider({ apiKey: config.ai.apiKey, fetch: nodeFetch });
}
// Names only, never a key: which model a provider runs is what an operator needs to see.
const providerDescription =
  config.ai.provider === "anthropic"
    ? `anthropic (${config.ai.model ?? DEFAULT_ANTHROPIC_MODEL}, effort ${config.ai.effort ?? DEFAULT_ANTHROPIC_EFFORT})`
    : config.ai.provider;

let authService: AuthService;
let authProviderCheck: (() => Promise<AuthProviderReport>) | undefined;
let projectStore: ProjectStore;
let storageDescription: string;
if (config.storage.mode === "supabase") {
  // The same kind of one-line adapter, and the only place a real
  // transport reaches the Supabase adapters. The anon key only - Row Level
  // Security, driven by each user's own token, does the rest.
  const supabaseFetch: SupabaseFetch = (url, init) => fetch(url, init);
  const supabase = { url: config.storage.url, anonKey: config.storage.anonKey, fetch: supabaseFetch };
  authService = new SupabaseAuthService(supabase);
  projectStore = new SupabaseProjectStore(supabase);
  // GET /health/auth: Supabase Auth's own health endpoint only - no token
  // probes from a public route (`npm run check:supabase` runs those locally).
  authProviderCheck = () => checkAuthProvider(supabase, { tokenProbes: false });
  storageDescription = `Accounts and projects: Supabase (${new URL(config.storage.url).host}).`;
  // A SUPABASE_URL that validates but doesn't look like a project URL is
  // the first thing to rule out when sign-in fails - say so at startup.
  for (const warning of supabaseUrlWarnings(config.storage.url)) {
    console.warn(`Warning: ${warning}`);
  }
} else {
  authService = new InMemoryAuthService();
  projectStore = new InMemoryProjectStore();
  storageDescription = "Accounts and projects are kept in memory (LOCAL_AUTH=memory) - they last until this server stops.";
}

const server = createServer({
  provider,
  frontendOrigin: config.frontendOrigins,
  authService,
  projectStore,
  // One JSON line per request - route, status, timing, signed-in or not. Never tokens, emails or bodies.
  requestLog: (line) => console.log(line),
  authProviderCheck,
  // Render sets RENDER_GIT_COMMIT to the deployed commit; /health reports it (X-Release) so a release can be verified.
  release: process.env.RENDER_GIT_COMMIT
});

server.listen(config.port, () => {
  console.log(`Backend listening on port ${config.port}${config.production ? " (production)" : ""}`);
  console.log(`Accepting browser requests from: ${config.frontendOrigins.join(", ")}`);
  console.log(storageDescription);
  console.log(`AI provider: ${providerDescription}.`);
  if (process.env.RENDER_GIT_COMMIT) console.log(`Release: ${process.env.RENDER_GIT_COMMIT.slice(0, 12)}.`);
});

// Hosts stop containers with SIGTERM: finish in-flight requests, then exit.
process.on("SIGTERM", () => {
  server.close(() => process.exit(0));
});
