# AI proxy backend

A small, dependency-free Node backend whose only job is to keep
`OPENAI_API_KEY` off the client. It accepts a construction instruction
and a read-only project snapshot from the frontend, calls the existing,
unmodified `OpenAIProvider` (`src/engine/ai/providers/OpenAIProvider.ts`)
server-side, and returns the structured commands it produced. It does
**not** execute anything - see "Architecture" below.

This is a separate, independently-installed service (its own
`package.json`/`node_modules`/`tsconfig.json`) - it is not part of the
Vite frontend build and does not affect `npm run build`/`npm run
verify` at the repo root.

## Why this exists

`src/engine/ai/README.md`'s "Security boundary" section explains why
`OpenAIProvider` was never wired into any browser-reachable code: this
project's frontend is a pure client-side Vite SPA, and there is no way
to keep an API key secret in code that ships to a browser. This backend
is exactly the "trusted, server-side process" that section said a real
deployment would need.

## Architecture

```
Frontend (future)                  This backend                    OpenAI
─────────────────                  ─────────────                   ──────
                     POST /api/ai/interpret
{instruction,          ──────────▶   reads OPENAI_API_KEY
 projectContext,                     (only here, only server-side)
 availableObjectTypes}               │
                                      ▼
                                parseAIProjectContext(projectContext)
                                      │  (sanitize the snapshot, drop the
                                      │   client's geometry, derive
                                      │   geometry from the sanitized
                                      │   snapshot - src/engine/ai/)
                                      ▼
                                new OpenAIProvider({apiKey, fetch})
                                      │  (existing, unmodified logic -
                                      │   see src/engine/ai/providers/)
                                      ▼
                                provider.interpret(request)  ───────▶  Chat Completions API
                                      │                       ◀───────  structured JSON
                     ◀──────────      │
{commands, notes}                relays the response
                                  exactly as returned -
                                  no re-validation, no
                                  reshaping, no execution
```

`CommandExecutor` is never imported here, and neither is
`AICommandPipeline` - this server has no concept of "executing" a
command at all. Structural validation (is this a real command shape,
object type, action?) and domain validation (invalid dimensions, etc.)
both still happen exactly where they always have: client-side, inside
`AICommandPipeline.run()`, which is what actually calls
`CommandExecutor.execute()`. This backend is a transparent relay for
one step - `AIProvider.interpret()` - with the API key kept out of the
client. **`CommandExecutor` remains the only mutation path** because
nothing new was inserted between a provider and it; this server sits
entirely *before* that pipeline, not inside it.

This milestone does not add a frontend consumer of this endpoint (no
`BackendAIProvider`, no AI chat UI) - see "Not included yet" below.

## Security posture

- `OPENAI_API_KEY` is read in exactly one place: `src/server.ts`, at
  startup, via `process.env.OPENAI_API_KEY`. The server refuses to
  start (prints a clear message, exits with a non-zero code) if it's
  missing or blank. Nothing else in this backend - or anywhere in the
  frontend - reads this variable.
- CORS is restricted to a single configurable origin
  (`FRONTEND_ORIGIN`, default `http://localhost:5173`) rather than `*`
  - only that origin's browser code can call this endpoint from a page.
- Request bodies are capped at 1MB (`413` beyond that) - basic,
  dependency-free protection against an unbounded body, independent of
  the point below. The frontend's request includes every pairwise
  geometry relationship, about 360 bytes each. A project of about 75
  objects therefore exceeds this cap (see `src/engine/ai/README.md`
  "Geometry in the AI context").
- **Client-supplied geometry is never trusted.** The provider only ever
  sees geometry this server derived itself, from the snapshot it has just
  validated and sanitized (`parseAIProjectContext()` in
  `src/engine/ai/aiProjectContext.ts`). `verify.ts` sends fabricated
  geometry and checks that the real `OpenAIProvider`'s request carries
  the server-derived values instead.
- **This endpoint has no authentication of its own in this milestone.**
  Anything that can reach it (on whatever network it's deployed to) can
  make it call OpenAI and spend the configured account's quota. That is
  an accepted, explicitly-scoped-out tradeoff for this milestone (confirmed
  with the requester before implementation) - **a real deployment beyond
  local development MUST add its own access control** (an API key/shared
  secret header checked before calling the provider, a session/auth
  check, a gateway in front of it, etc.) before being reachable from
  anywhere untrusted. `CreateServerOptions`/`handleRequest` in
  `src/createServer.ts` is exactly where such a check would go - one
  early rejection before `options.provider.interpret(...)` is ever
  called.

## Running it

```bash
cd backend
npm install
cp .env.example .env
# edit .env and set a real OPENAI_API_KEY
npm start        # or: npm run dev (restarts on file changes)
```

`--env-file` is a stable Node.js flag (18.20+/20.6+) - no `dotenv`
dependency needed, consistent with the root project's own
zero-unnecessary-dependency approach.

## Running it without an OpenAI key (mock mode)

```bash
cd backend
npm install
npm run mock     # no .env, no API key needed
```

`mockBackend.ts` starts the **same** `createServer()` this server's real
entry point uses - same routing, CORS, validation, and status codes -
with the deterministic keyword-matching `MockAIProvider` in place of
`OpenAIProvider`. No OpenAI request is ever made. This is what the
frontend's browser smoke testing runs against: the app already defaults
to `http://localhost:8787` (see the root `.env.example`'s
`VITE_AI_BACKEND_URL`), so `npm run mock` plus `npm run dev` at the root
gives a fully working AI command bar with zero API cost.

Instructions naming a wall, pillar, beam, slab, door, or window build
real objects; anything else returns the provider's "could not map"
notes, which exercises the command bar's notes and error states.

An instruction to build a new house - for example "Build a simple
2-bedroom house on a 10m × 8m footprint." - returns the complete,
deterministic house plan from `src/engine/ai/housePlan.ts`: a slab,
four perimeter walls, four corner pillars, a door, and two windows,
placed clear of whatever the project already contains. The browser
applies it as one undoable step (see `src/engine/ai/README.md`).

## Endpoint

### `POST /api/ai/interpret`

Request body:

```json
{
  "instruction": "Create a wall and add a pillar",
  "projectContext": {
    "wallCount": 1, "pillarCount": 0, "beamCount": 0, "slabCount": 0,
    "doorCount": 0, "windowCount": 0, "assemblyCount": 1,
    "selectedObjectId": null,
    "objects": [
      {
        "id": "wall-1", "type": "wall",
        "position": { "x": 0, "y": 1.35, "z": 0 }, "rotation": 0,
        "dimensions": { "height": 2.7, "length": 4, "thickness": 0.2 },
        "material": "generic", "color": "#c9c9c9",
        "assemblyIds": ["assembly-1"]
      }
    ],
    "assemblies": [
      { "id": "assembly-1", "name": "Ground Floor", "description": null, "objectIds": ["wall-1"] }
    ]
  },
  "availableObjectTypes": ["wall", "pillar", "beam", "slab", "door", "window"]
}
```

`availableObjectTypes` is optional - it defaults to
`AI_SUPPORTED_OBJECT_TYPES` (the same default `AICommandPipeline.run()`
itself uses) when omitted. `projectContext` must match
`AIProjectSnapshot`'s shape exactly (see `src/engine/ai/types.ts`).

The frontend also sends a `geometry` section inside `projectContext`
(see `src/engine/ai/README.md` "Geometry in the AI context"). The
server never reads it. It is dropped along with any other field the
snapshot doesn't define, and replaced by geometry the server derives
from the sanitized snapshot with the same `analyzeConstructionGeometry()`
the frontend runs. A missing, malformed, or fabricated `geometry` is
therefore never an error and never reaches the provider.

Responses:

| Status | When | Body |
|---|---|---|
| `200` | The provider returned a response | `{ "commands": [...], "notes"?: "..." }` - exactly what `OpenAIProvider.interpret()` returned, unvalidated |
| `400` | Malformed/incomplete request body | `{ "error": "..." }` |
| `413` | Request body over 1MB | `{ "error": "Request body too large." }` |
| `502` | The provider call failed (bad key, OpenAI error, malformed OpenAI response, etc.) | `{ "error": "..." }` - the same clear, key-free messages `OpenAIProvider` already produces |
| `500` | An unexpected bug in this server | `{ "error": "Internal server error." }` |

### Projects: `/api/projects`

Project storage for the frontend's Save and Open… (see
`src/engine/project/README.md`). Projects are kept in an
`InMemoryProjectRepository` - by both `npm start` and `npm run mock` -
so they last as long as the server process. `createServer()` takes the
repository as its `projectRepository` option; without one, these routes
answer `501`.

| Method and path | Body | Success |
|---|---|---|
| `GET /api/projects` | - | `200 { "projects": [{ id, name, createdAt, updatedAt, objectCount, assemblyCount }] }`, most recently updated first |
| `POST /api/projects` | `{ "name": "...", "document": ProjectDocument }` | `201 { "project": { id, name, createdAt, updatedAt, document } }` |
| `GET /api/projects/:id` | - | `200 { "project": ... }`, or `404` |
| `PUT /api/projects/:id` | `{ "name": "...", "document": ProjectDocument }` | `200 { "project": ... }`, or `404` |

Every body is validated with the shared `parseProjectInput()` before it
is stored: the name must be non-empty (at most 120 characters), and the
document must pass `parseProjectDocument()`. A rejected body gets `400 {
"error": "..." }` naming the problem. A storage failure gets `500 {
"error": "Project storage failed." }` with no internal details. There
is no authentication yet - see "Security posture".

### `GET /health`

Returns `200 { "status": "ok" }` - a liveness check, no provider call.

### `OPTIONS *`

CORS preflight - `204`, no body.

## Testing

```bash
cd backend
npm install
npm run verify
```

`verify.ts` follows this project's established "no test framework,
plain assertion helpers, run directly by Node" convention. Every check
binds the real server to an ephemeral local port and talks to it over
`127.0.0.1` with Node's built-in `fetch` - a real HTTP round-trip
through this server's actual code, not a mock of Node's `http`
primitives, but never anything beyond loopback. Whether a real OpenAI
call could ever happen is controlled by what `AIProvider` each check
injects:

- Most checks use a hand-rolled, HTTP-free `AIProvider` stand-in - it
  has no code path that could reach any network.
- A handful construct a **real `OpenAIProvider`** (proving this backend
  genuinely reuses the existing, tested OpenAI-calling logic end to end)
  but always with a hand-rolled mock `fetch`, exactly like
  `src/engine/ai/providers/verify.ts` - never the real global `fetch`,
  never a real API key. Those checks additionally assert the mock was
  called exactly once, as positive proof no extra (or real) request
  happened.

This backend's tests are **not** wired into the root project's `npm run
verify` - they need their own `npm install` first (a separate
`node_modules`), which someone who has only ever run the root project's
`npm install` won't have. Run them explicitly as shown above.

## Not included yet

- **No frontend consumer.** No code under `src/` or `src/ui/` calls
  this endpoint. A future milestone would add a thin
  `src/engine/ai/providers/BackendAIProvider.ts` (implements the
  existing `AIProvider` interface, `fetch`es this endpoint) and only
  *that* class would ever be constructed with a URL - never a key.
- **No AI chat UI.** Unchanged from every prior AI milestone.
- **No authentication on this endpoint.** See "Security posture" above.
- **No deployment configuration.** This is a local/dev-runnable Node
  process; hosting it (process manager, HTTPS termination, secrets
  storage for `OPENAI_API_KEY`, the access control above) is a separate,
  later concern.
