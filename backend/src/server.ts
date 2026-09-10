import { createServer } from "./createServer.ts";
import { OpenAIProvider } from "../../src/engine/ai/providers/OpenAIProvider.ts";
import type { OpenAIFetch } from "../../src/engine/ai/providers/OpenAIProvider.ts";
import { InMemoryProjectRepository } from "../../src/engine/project/InMemoryProjectRepository.ts";

/**
 * Entry point for the AI proxy backend. THIS IS THE ONLY FILE IN THE
 * ENTIRE REPOSITORY (frontend or backend) THAT READS
 * `process.env.OPENAI_API_KEY` - see backend/README.md "Security
 * posture" and src/engine/ai/README.md "Security boundary". Run with:
 *
 *   node --env-file=.env src/server.ts
 *
 * (from inside backend/, after `npm install` and copying .env.example
 * to .env with a real key - see backend/README.md). `--env-file` is a
 * stable Node.js flag (18.20+/20.6+) - no `dotenv` dependency needed,
 * consistent with this project's existing zero-framework approach.
 */

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey || apiKey.trim().length === 0) {
  console.error(
    'Missing OPENAI_API_KEY environment variable. Copy backend/.env.example to backend/.env, fill in a real ' +
      "OpenAI API key, and start this server with: node --env-file=.env src/server.ts"
  );
  process.exit(1);
}

const port = Number(process.env.PORT ?? 8787);
const frontendOrigin = process.env.FRONTEND_ORIGIN ?? "http://localhost:5173";

// Adapts the real global `fetch` to OpenAIProvider's minimal injected
// OpenAIFetch shape - see providers/OpenAIProvider.ts. This one-line
// adapter is the ONLY place in this whole project a real network
// transport is ever handed to OpenAIProvider; every test (frontend and
// backend) passes a mock instead.
const nodeFetch: OpenAIFetch = (url, init) => fetch(url, init);

const provider = new OpenAIProvider({ apiKey, fetch: nodeFetch });

// Projects live in memory until a database is configured - they last as
// long as this process. A database-backed ProjectRepository (and its
// credentials) would be constructed here instead. See
// src/engine/project/README.md.
const projectRepository = new InMemoryProjectRepository();

const server = createServer({ provider, frontendOrigin, projectRepository });

server.listen(port, () => {
  console.log(`AI proxy backend listening on http://localhost:${port}`);
  console.log(`Accepting requests from origin: ${frontendOrigin}`);
  console.log("Projects are stored in memory - they last until this server stops.");
});
