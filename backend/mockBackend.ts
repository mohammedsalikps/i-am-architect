import { createServer } from "./src/createServer.ts";
import { MockAIProvider } from "../src/engine/ai/MockAIProvider.ts";

/**
 * A keyless stand-in for the real AI proxy backend, for frontend
 * development and browser testing without an OpenAI account.
 *
 * This is NOT a reimplementation of the server: it starts the very same
 * `createServer()` the production entry point does (src/server.ts), with
 * the same routing, CORS, request validation, and status codes. The only
 * difference is which AIProvider sits behind it - the deterministic,
 * keyword-matching MockAIProvider instead of OpenAIProvider - so no
 * OPENAI_API_KEY is needed and no OpenAI request is ever made.
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
 * src/engine/ai/housePlan.ts). Anything else comes back with the
 * provider's "could not map" notes, which is a useful way to exercise
 * the command bar's notes and error states.
 */

const port = Number(process.env.PORT ?? 8787);
const frontendOrigin = process.env.FRONTEND_ORIGIN ?? "http://localhost:5173";

const server = createServer({ provider: new MockAIProvider(), frontendOrigin });

server.listen(port, () => {
  console.log(`MOCK AI proxy backend listening on http://localhost:${port}`);
  console.log(`Accepting requests from origin: ${frontendOrigin}`);
  console.log("No OpenAI key is used and no OpenAI request is made - responses are deterministic keyword matches.");
});
