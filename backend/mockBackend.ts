import { createServer } from "./src/createServer.ts";
import { parseFrontendOrigins } from "./src/config.ts";
import { InMemoryAuthService } from "./src/auth/InMemoryAuthService.ts";
import { MockAIProvider } from "../src/engine/ai/MockAIProvider.ts";
import { InMemoryProjectStore } from "../src/engine/project/InMemoryProjectRepository.ts";

/**
 * A keyless stand-in for the real backend, for frontend development and
 * browser testing without an OpenAI account or a Supabase project.
 *
 * This is NOT a reimplementation of the server: it starts the very same
 * `createServer()` the production entry point does (src/server.ts), with
 * the same routing, CORS, request validation, authentication checks, and
 * status codes. The differences are only in what sits behind it:
 *
 * - the deterministic, keyword-matching MockAIProvider instead of
 *   OpenAIProvider - so no OPENAI_API_KEY is needed and no OpenAI request
 *   is ever made;
 * - accounts and projects in memory (InMemoryAuthService,
 *   InMemoryProjectStore) instead of Supabase - the same thing the real
 *   server does with LOCAL_AUTH=memory. There are no built-in accounts:
 *   create one with "Create account" in the app. Everything is gone when
 *   this process stops.
 *
 * Run it with:
 *   npm run mock
 *
 * Then point the frontend at it the usual way (it already defaults to
 * http://localhost:8787 - see the root .env.example's
 * VITE_AI_BACKEND_URL). Instructions naming a wall, pillar, beam, slab,
 * door, or window will build real objects in the app, and an instruction
 * to build a house ("Build a simple 2-bedroom house on a 10m × 8m
 * footprint.") gets the complete house plan (see
 * src/engine/ai/housePlan.ts).
 */

const port = Number(process.env.PORT ?? 8787);
const origins = parseFrontendOrigins(process.env.FRONTEND_ORIGIN);
if (!origins.ok) {
  console.error(origins.error);
  process.exit(1);
}

const server = createServer({
  provider: new MockAIProvider(),
  frontendOrigin: origins.origins,
  authService: new InMemoryAuthService(),
  projectStore: new InMemoryProjectStore(),
  requestLog: (line) => console.log(line)
});

server.listen(port, () => {
  console.log(`MOCK backend listening on http://localhost:${port}`);
  console.log(`Accepting browser requests from: ${origins.origins.join(", ")}`);
  console.log("No OpenAI key is used and no OpenAI request is made - responses are deterministic keyword matches.");
  console.log("Accounts and projects are kept in memory - they last until this server stops.");
});
