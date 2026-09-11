import { createServer } from "./createServer.ts";
import { readServerConfig } from "./config.ts";
import { OpenAIProvider } from "../../src/engine/ai/providers/OpenAIProvider.ts";
import { GeminiProvider } from "../../src/engine/ai/providers/GeminiProvider.ts";
import type { AIProvider } from "../../src/engine/ai/AIProvider.ts";
import { InMemoryProjectStore } from "../../src/engine/project/InMemoryProjectRepository.ts";
import { InMemoryAuthService } from "./auth/InMemoryAuthService.ts";
import { SupabaseAuthService } from "./auth/SupabaseAuthService.ts";
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
const provider: AIProvider =
  config.ai.provider === "gemini"
    ? new GeminiProvider({ apiKey: config.ai.apiKey, fetch: nodeFetch })
    : new OpenAIProvider({ apiKey: config.ai.apiKey, fetch: nodeFetch });

let authService: AuthService;
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
  storageDescription = `Accounts and projects: Supabase (${new URL(config.storage.url).host}).`;
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
  requestLog: (line) => console.log(line)
});

server.listen(config.port, () => {
  console.log(`Backend listening on port ${config.port}${config.production ? " (production)" : ""}`);
  console.log(`Accepting browser requests from: ${config.frontendOrigins.join(", ")}`);
  console.log(storageDescription);
  console.log(`AI provider: ${config.ai.provider}.`);
});

// Hosts stop containers with SIGTERM: finish in-flight requests, then exit.
process.on("SIGTERM", () => {
  server.close(() => process.exit(0));
});
