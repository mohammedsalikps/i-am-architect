# Backend

A small, dependency-free Node backend between the browser and everything
that needs a secret. It:

- signs users up, in and out (`/api/auth/*`), through Supabase Auth - or an
  in-memory stand-in for local development;
- stores each signed-in user's projects (`/api/projects`) in Supabase
  PostgreSQL - or in memory - where each user reaches only their own;
- relays AI command-interpretation requests (`/api/ai/interpret`) from a
  signed-in user to the existing `OpenAIProvider`, keeping
  `OPENAI_API_KEY` server-side. It does **not** execute anything - see
  "Architecture".

This is a separate, independently-installed service (its own
`package.json`/`node_modules`/`tsconfig.json`) - it is not part of the Vite
frontend build and does not affect `npm run build`/`npm run verify` at the
repo root.

## Architecture

```
Browser (holds only the user's own session tokens)
   │  Authorization: Bearer <access token>
   ▼
createServer()  ── checks the token with the AuthService on EVERY request ──┐
   │                                                                          │
   ├─ /api/auth/*       → AuthService                                         │
   │                        SupabaseAuthService → Supabase Auth (anon key)   │
   │                        InMemoryAuthService → memory                     │
   ├─ /api/projects     → ProjectStore.forUser(user, token)                  │
   │                        SupabaseProjectStore → PostgREST, anon key + the │
   │                                               user's token → Row Level  │
   │                                               Security                  │
   │                        InMemoryProjectStore → memory, filtered by owner │
   └─ /api/ai/interpret → parseAIProjectContext() → OpenAIProvider (OPENAI_API_KEY)
                          relays { commands, notes } - no execution
```

`CommandExecutor` is never imported here, and neither is
`AICommandPipeline` - this server has no concept of "executing" a command.
Structural and domain validation of AI output still happen client-side,
inside `AICommandPipeline.run()`, which is what calls
`CommandExecutor.execute()`. **`CommandExecutor` remains the only mutation
path.**

Everything is injected: `createServer()` takes the AI provider, the
`AuthService` and the `ProjectStore`, and every outbound transport (to
OpenAI, to Supabase) is an injected `fetch`. `server.ts` wires the real
ones; the tests wire test doubles, so no test can reach a real service.

## Security posture

- **Secrets are read in one place.** `src/server.ts` is the only file that
  reads `process.env`; it hands it to `readServerConfig()`
  (`src/config.ts`). Nothing in the frontend reads a secret, and no secret
  is ever sent to the browser or echoed in an error message.
- **No service-role key.** The backend uses the Supabase project's anon
  (publishable) key only. It refuses to start if `SUPABASE_ANON_KEY` holds
  a service-role or secret key. Data requests carry the signed-in user's
  own token, so Row Level Security decides what they can touch - the
  backend never has a key that bypasses it.
- **Identity comes from the token, checked on every request.** The server
  never trusts a user id from a request body. A missing, malformed,
  non-Bearer, expired or revoked token gets `401 { error, code:
  "unauthorized" }` (with `WWW-Authenticate: Bearer`) before any storage
  or AI call.
- **Ownership is enforced by the database.** The `projects` table's
  policies allow a user to select, insert, update and delete only rows
  whose `user_id` is their own (`auth.uid()`); the anon role has no access
  at all. A trigger stamps timestamps and prevents moving a project to
  another user. In memory, `InMemoryProjectRepository` applies the same
  rule. Another user's project answers exactly like a missing one (`404`).
- **The AI endpoint requires a signed-in user**, so an anonymous caller
  can't spend the OpenAI quota.
- **Tokens stay out of logs and caches.** Failures are logged by name and
  message only - never headers or bodies - and every response carries
  `Cache-Control: no-store`.
- **Client-supplied geometry is never trusted.** The provider only sees
  geometry this server derived itself from the snapshot it has just
  validated and sanitized (`parseAIProjectContext()`).
- CORS is restricted to one configurable origin (`FRONTEND_ORIGIN`). That
  is not authentication; the token check is.
- Request bodies are capped at 1 MB (16 KB for auth routes) - `413`
  beyond that.

## Running it

```bash
cd backend
npm install
cp .env.example .env
# edit .env: set OPENAI_API_KEY, and choose account storage (below)
npm start        # or: npm run dev (restarts on file changes)
```

The server refuses to start until account storage is chosen - it never
assumes Supabase is configured:

- **Supabase:** set `SUPABASE_URL` and `SUPABASE_ANON_KEY` (see "Supabase
  setup").
- **Memory:** set `LOCAL_AUTH=memory`. Accounts and projects last until the
  server stops - for local development only.

`--env-file` is a stable Node.js flag (18.20+/20.6+) - no `dotenv`
dependency needed.

## Supabase setup

1. Create a Supabase project. In **Authentication → Providers**, keep
   **Email** enabled. With **Confirm email** on, a new account must click
   the emailed link before signing in (the app says so); with it off, sign
   up signs straight in.
2. Create the `projects` table, its policies and trigger: run
   `supabase/migrations/20260910000000_create_projects.sql` in the SQL
   editor (or `supabase db push` from this directory with the Supabase
   CLI). It is safe to run again.
3. From **Project Settings → API**, copy the project URL and the **anon /
   publishable** key into `.env` as `SUPABASE_URL` and
   `SUPABASE_ANON_KEY`. Do **not** use the service-role / secret key.

The table:

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | primary key, `gen_random_uuid()` |
| `user_id` | `uuid` | `references auth.users on delete cascade`, default `auth.uid()` |
| `name` | `text` | 1-120 characters |
| `document` | `jsonb` | the `ProjectDocument` - checked to be `{ version, objects[], assemblies[] }`, at most 5 MB |
| `object_count`, `assembly_count` | `integer` | generated from the document, for the project list |
| `created_at`, `updated_at` | `timestamptz` | stamped by the database |

## Running it without keys (mock mode)

```bash
cd backend
npm install
npm run mock     # no .env, no API key, no Supabase needed
```

`mockBackend.ts` starts the **same** `createServer()` - same routing, CORS,
validation, authentication checks and status codes - with the
deterministic keyword-matching `MockAIProvider` in place of
`OpenAIProvider`, and accounts and projects in memory. No OpenAI or Supabase
request is ever made. There are no built-in accounts: use **Sign in →
Create an account** in the app. The app defaults to
`http://localhost:8787` (see the root `.env.example`'s
`VITE_AI_BACKEND_URL`), so `npm run mock` plus `npm run dev` at the root
gives a fully working app with zero API cost.

An instruction to build a new house - for example "Build a simple 2-bedroom
house on a 10m × 8m footprint." - returns the complete, deterministic house
plan from `src/engine/ai/housePlan.ts`.

## Endpoints

Every `/api/projects` and `/api/ai/interpret` request needs
`Authorization: Bearer <access token>`.

### Accounts: `/api/auth`

| Method and path | Body | Success | Refusals |
|---|---|---|---|
| `POST /api/auth/signup` | `{ email, password }` | `201 { session }`, or `202 { confirmationRequired: true, email }` when the email must be confirmed first | `400` invalid email or password (8-72 characters), `409` already registered |
| `POST /api/auth/signin` | `{ email, password }` | `200 { session }` | `401 "Wrong email or password."` (the same for an unknown email), `401` email not confirmed |
| `POST /api/auth/refresh` | `{ refreshToken }` | `200 { session }` | `401` the refresh token is no longer valid |
| `POST /api/auth/signout` | - (Bearer) | `204` | `401` no token |
| `GET /api/auth/session` | - (Bearer) | `200 { user: { id, email } }` | `401` |

A session is `{ accessToken, refreshToken, expiresAt (ms), user: { id,
email } }`. `429` means rate limited, `502` that the identity provider
couldn't be reached. Without an `AuthService`, these routes answer `501`.

### Projects: `/api/projects`

| Method and path | Body | Success |
|---|---|---|
| `GET /api/projects` | - | `200 { "projects": [{ id, name, createdAt, updatedAt, objectCount, assemblyCount }] }` - the user's own, most recently updated first |
| `POST /api/projects` | `{ "name": "...", "document": ProjectDocument }` | `201 { "project": { id, ownerId, name, createdAt, updatedAt, document } }` |
| `GET /api/projects/:id` | - | `200 { "project": ... }`, or `404` |
| `PUT /api/projects/:id` | `{ "name": "...", "document": ProjectDocument }` | `200 { "project": ... }`, or `404` |
| `DELETE /api/projects/:id` | - | `204`, or `404` |

Every body is validated with the shared `parseProjectInput()` before it is
stored: the name must be non-empty (at most 120 characters), and the
document must pass `parseProjectDocument()` - a rejected body gets `400 {
"error": "..." }` naming the problem. Signed out or expired: `401`.
Someone else's project: `404`, like a missing one. A storage failure:
`500 { "error": "Project storage failed." }` with no internal details.
Without a `ProjectStore`, these routes answer `501`.

### `POST /api/ai/interpret`

Request body `{ instruction, projectContext, availableObjectTypes? }` -
`projectContext` must match `AIProjectSnapshot` (see
`src/engine/ai/types.ts`); a client `geometry` section is ignored and
replaced by server-derived geometry.

| Status | When | Body |
|---|---|---|
| `200` | The provider returned a response | `{ "commands": [...], "notes"?: "..." }` - exactly what the provider returned, unvalidated |
| `400` | Malformed/incomplete request body | `{ "error": "..." }` |
| `401` | Not signed in | `{ "error": "Sign in to use the AI assistant.", "code": "unauthorized" }` |
| `413` | Request body over 1 MB | `{ "error": "Request body too large." }` |
| `502` | The provider call failed | `{ "error": "..." }` - `OpenAIProvider`'s own key-free messages |

### `GET /health` and `OPTIONS *`

`/health` returns `200 { "status": "ok" }`. `OPTIONS` is the CORS
preflight - `204`; it allows `GET, POST, PUT, DELETE` and the
`Content-Type` and `Authorization` headers.

## Testing

```bash
cd backend
npm install
npm run verify
```

Three suites, all deterministic, all credential-free, none reaching past
loopback:

- `verify.ts` - routing, request validation, the AI proxy (a stub
  provider, or a real `OpenAIProvider` with a mocked transport), and the
  project routes through the real `HttpProjectRepository`.
- `auth.verify.ts` - sign up, sign in, sign out, session restore, token
  refresh and expiry through the real browser classes; 401s on every
  route; ownership between users; the AI endpoint's sign-in requirement;
  token-free logs; the Supabase adapters against a mocked transport and an
  in-process fake Supabase (Auth + PostgREST with the migration's Row
  Level Security rule); and the server configuration.
- `persistence.verify.ts` - the complete house saved and reopened through
  the real server, compared, then edited by hand and by AI with undo and
  redo, and saved again (runs with `--experimental-transform-types`).

No test talks to a real Supabase project. A credentialed integration test
against a real (non-production) project would be a separate, opt-in suite -
see "Not included yet".

These suites are **not** part of the root project's `npm run verify` -
they need this directory's own `npm install`.

## Not included yet

- **Social login, MFA, password reset, organisations, teams, roles, SSO,
  billing.**
- **Rate limiting of its own.** Supabase Auth rate-limits sign-in; the
  in-memory service does not.
- **Local JWT verification.** Each request's token is checked with
  Supabase Auth (`/auth/v1/user`) - one extra round trip; verifying JWTs
  locally against the project's signing keys would remove it.
- **A credentialed integration suite** against a real, non-production
  Supabase project.
- **Deployment configuration.** Hosting this process (process manager,
  HTTPS termination, secrets storage) is a separate concern.
