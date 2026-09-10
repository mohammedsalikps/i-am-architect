# Deployment

How to run i am Architect outside localhost: a real Supabase project for
accounts and projects, the backend on an HTTPS host, the frontend on
Vercel. No credential appears anywhere in this repository - every value
below is something you paste into a dashboard, a gitignored `.env` file,
or a host's secret store.

```
Browser ──HTTPS──▶ Frontend (Vercel, static files)
   │
   └──HTTPS, Bearer <user token>──▶ Backend (Fly.io, Node container) ──▶ Supabase (Auth + PostgreSQL, RLS)
                                          └──▶ OpenAI (OPENAI_API_KEY, server-side only)
```

The browser holds only the signed-in user's own session tokens and the
backend's URL. The Supabase keys and the OpenAI key live on the backend
host only.

## Environments

| | Local (mock) | Local (real) | Staging | Production |
|---|---|---|---|---|
| Backend | `npm run mock` | `npm start` in `backend/` | Fly.io app, e.g. `iarchitect-backend-staging` | a separate Fly.io app |
| Accounts & projects | in memory | a **staging** Supabase project | the **staging** Supabase project | a separate **production** Supabase project |
| AI | MockAIProvider (no key) | OpenAI | OpenAI | OpenAI |
| Frontend | `npm run dev` | `npm run dev` | Vercel (preview or its own project) | Vercel production |

Keep staging and production fully separate: separate Supabase projects,
separate backend apps, separate secrets. The real-infrastructure tests only
ever run against staging, and refuse to run unless you confirm that.

## 1. Create the Supabase project (staging)

1. At https://supabase.com, create a project named e.g. `iarchitect-staging`.
   Pick a strong database password and store it in your password manager -
   the app never needs it.
2. **Authentication → Providers → Email**: enabled.
3. **Authentication → Sign In / Providers → Email → Confirm email**:
   - production: keep **on** (new accounts confirm by email);
   - staging: either keep it on and create test accounts in the dashboard
     with **Auto Confirm User** (step 5), or turn it off for staging only.
     Never weaken the production project.
4. **Authentication → URL Configuration → Site URL**: the deployed frontend
   URL (e.g. `https://iarchitect-staging.vercel.app`), so confirmation
   emails link back to the app.
5. **Authentication → Users → Add user → Create new user**, with **Auto
   Confirm User**, twice: test users A and B for the real-infrastructure
   tests. Use addresses you control and passwords used nowhere else.

### Run the migration

In **SQL Editor → New query**, run each file in
`backend/supabase/migrations/` in filename order - paste the whole file,
run it, then the next:

1. `20260910000000_create_projects.sql` - the table, trigger, RLS policies
   and grants;
2. `20260911000000_projects_document_check.sql` - replaces the document
   constraint so a document missing `version`, `objects` or `assemblies`
   is refused (the first version let a missing key through, because a CHECK
   that evaluates to NULL passes).

(Or, with the Supabase CLI: `supabase link --project-ref <ref>` then
`supabase db push` from `backend/`, which applies them in order.) Both are
idempotent - running one again changes nothing.

### Verify the database

Run `backend/supabase/verify_projects.sql` (read-only) in the SQL editor.
Expected:

1. `projects` with `rls_enabled = true`;
2. columns `id, user_id, name, document, object_count, assembly_count,
   created_at, updated_at` (the two counts generated);
3. four policies - `Users read/create/update/delete their own projects` -
   for `{authenticated}`, on `auth.uid() = user_id`;
4. constraints: primary key, `user_id` → `auth.users`, `projects_name_check`,
   `projects_document_check`;
5. trigger `projects_stamp`;
6. grants: `authenticated` has `DELETE, INSERT, SELECT, UPDATE`; `anon` has
   none;
7. no rows (no stored project breaks the document envelope);
8. `projects_document_check` with `tightened = true`.

If the SQL editor answers a migration with a generic dashboard error such as
"Backend error! Retry your query", don't assume it failed: that message comes
from the dashboard, not from PostgreSQL (a real failure shows a PostgreSQL
error code). Run `verify_projects.sql` and read checks 4 and 8 - they show
whether the migration is live. Both migrations are safe to run again anyway.

### Rows that break the document envelope

`20260911000000_projects_document_check.sql` refuses to tighten the
constraint while any stored project breaks the envelope (a JSON object with a
numeric `version`, an `objects` array and an `assemblies` array). It changes
and deletes nothing, and names up to 20 such rows; check 7 of
`verify_projects.sql` lists them all. The app itself never writes such a
document (the backend validates every save), so a row like that was written
directly through the database. Handle each row by what it is:

- **Integration-test data** - its `name` starts with `[integration ` AND its
  `user_id` is one of the two integration test users (Authentication →
  Users). Only then may it be deleted:
  ```sql
  delete from public.projects
  where id = '<the row id>'
    and name like '[integration %'
    and user_id in ('<test user A id>', '<test user B id>');
  ```
- **Anything else is real user data - never delete it.** If only the
  envelope is incomplete, restore the missing key without touching the rest
  of the document, for example a missing version:
  ```sql
  update public.projects
  set document = jsonb_set(document, '{version}', '1'::jsonb)
  where id = '<the row id>' and document -> 'version' is null;
  ```
  (`'{objects}', '[]'` and `'{assemblies}', '[]'` for the others - an empty
  list only if the document genuinely has none). If the document is not
  recoverable, export it (`select document from public.projects where id =
  ...`) and resolve it with its owner before changing anything.

Then run the migration again.

### Keys

**Project Settings → API**: copy the **Project URL** and the **anon /
publishable** key. Never copy the service-role / secret key anywhere - the
backend refuses to start with one.

## 2. Configure and test locally against staging

```bash
cd backend
cp .env.example .env          # OPENAI_API_KEY, SUPABASE_URL, SUPABASE_ANON_KEY
npm start
```

In another terminal, at the repo root: `npm run dev`, and open
http://localhost:5173.

### Real infrastructure tests

```bash
cd backend
cp .env.integration.example .env.integration   # staging URL + anon key, project ref, "yes", users A and B
npm run test:integration
```

`test:integration` runs the real backend code locally against the real
staging project: real sign-in, refresh and sign-out; the anon key alone
reaching nothing; the complete house saved, listed, reopened and compared,
edited and saved again, then deleted; user B unable to list, open, modify
or delete user A's project - through the backend **and** directly through
PostgREST with B's own token; and the database's own rules (owner and
`created_at` immutable, invalid documents refused). It only creates and
deletes projects owned by the two test users, named `[integration …]`.

These tests are **not** part of `npm run verify` - that stays deterministic
and credential-free, so CI never depends on anyone's Supabase account.

## 3. Deploy the backend (Fly.io)

The backend is a persistent Node service (`backend/src/server.ts`), so it
runs as a container rather than as serverless functions. `Dockerfile` (repo
root - the backend imports the shared engine in `src/engine/`) builds it
with Node 24, which runs the TypeScript directly: no build step, no runtime
dependencies, no secret in the image. `fly.toml` forces HTTPS and checks
`/health`.

```bash
# once: install flyctl (https://fly.io/docs/flyctl/install/) and sign in
fly auth login

# once: create the app (edit the app name in fly.toml first)
fly apps create iarchitect-backend-staging

# secrets - you type these; they are stored encrypted by Fly, never in the repo
fly secrets set OPENAI_API_KEY=... SUPABASE_URL=https://<ref>.supabase.co SUPABASE_ANON_KEY=...
fly secrets set FRONTEND_ORIGIN=https://<your-frontend>.vercel.app

fly deploy
curl https://iarchitect-backend-staging.fly.dev/health     # {"status":"ok"}
```

Any other Docker host with HTTPS works the same way (Railway: `railway up`
uses the same Dockerfile; Render and Cloud Run too) - set the same
variables in its secret store.

### Backend environment variables

| Variable | Required | Example | Notes |
|---|---|---|---|
| `OPENAI_API_KEY` | yes | - | Secret. Backend only. |
| `SUPABASE_URL` | yes (hosted) | `https://abcdefgh.supabase.co` | |
| `SUPABASE_ANON_KEY` | yes (hosted) | - | The anon/publishable key. A service-role/secret key is refused. |
| `FRONTEND_ORIGIN` | yes (hosted) | `https://iarchitect-staging.vercel.app` | Comma-separated exact origins allowed by CORS. Add `http://localhost:5173` only on staging if you develop against it. No wildcards, no paths; non-local origins must be https. |
| `NODE_ENV` | set by the Dockerfile | `production` | In production, `LOCAL_AUTH=memory` is refused. |
| `PORT` | set by the Dockerfile | `8787` | |
| `LOCAL_AUTH` | local only | `memory` | In-memory accounts for development. Never on a host. |

### Logs

`fly logs` shows one JSON line per request - time, method, route (project
ids replaced by `:id`), operation (`projects.save`, `auth.signin`,
`ai.interpret`...), status, duration, whether the caller was signed in
(`user` / `none` / `invalid` / `unverified`), and a short failure reason.
Never a token, password, email address, or document. Failures of Supabase
or OpenAI are logged by error name and message.

## 4. Deploy the frontend (Vercel)

The frontend is a static Vite build. `vercel.json` sets the build and
security headers; the production build adds a Content-Security-Policy that
only lets the page talk to itself and the backend.

```bash
npm i -g vercel        # or use npx vercel
vercel login
vercel link            # creates a Vercel project for this folder (.vercel/ is gitignored)
vercel env add VITE_AI_BACKEND_URL production    # value: https://iarchitect-backend-staging.fly.dev
vercel deploy --prod
```

`VITE_AI_BACKEND_URL` is the only frontend variable. It is **not** a secret
(the browser must know where the backend is). A hosted build fails if it
is missing or not `https://` - so a deployment can never quietly point at
localhost.

Then set the backend's `FRONTEND_ORIGIN` to the exact production URL Vercel
printed (`fly secrets set FRONTEND_ORIGIN=...` redeploys). Vercel preview
deployments have other URLs; they are refused by CORS unless you add them.

## 5. Verify the deployment

```bash
cd backend
# add DEPLOYED_BACKEND_URL and DEPLOYED_FRONTEND_URL to .env.integration
npm run test:deployed                  # add DEPLOYED_RUN_AI=yes for one real OpenAI request
```

It checks HTTPS and the health endpoint, CORS (the frontend allowed by
name, other origins refused), that signed-out project and AI requests are
refused, the frontend's CSP and that nothing it serves contains a secret, a
project round trip and two-user isolation on the deployed backend, the AI
path with undo/redo, and sign-out.

Then use the deployed site itself: sign in, build, save, reload, open, edit,
undo/redo, AI, save, sign out, sign back in, open, delete.

## CORS and HTTPS

- The backend answers browser requests only from `FRONTEND_ORIGIN`'s exact
  origins; any other `Origin` gets **403** before routing, authentication or
  storage. Requests with no `Origin` (health checks, `curl`) are not browser
  requests and still need a valid token for anything but `/health`.
- Fly.io (`force_https`) and Vercel serve HTTPS only and redirect HTTP. The
  backend adds `Strict-Transport-Security` when the host reports HTTPS.
- Every API response is `Cache-Control: no-store`.

## Local development

- `npm run mock` in `backend/` + `npm run dev` - no keys, no Supabase:
  in-memory accounts (create one in the app) and the keyword-matching mock
  AI.
- `npm start` in `backend/` with `backend/.env` - real OpenAI, and either
  the staging Supabase project or `LOCAL_AUTH=memory`.
- `npm run verify` (root) and `npm run verify` (backend) - the
  deterministic suites. `npm run build` - the production bundle.

## Secrets - never commit

`.env`, `.env.local`, `.env.integration`, any `.env.*` other than the
`*.example` templates (all gitignored), Supabase service-role/secret keys,
OpenAI keys, database passwords, access tokens. Before a commit, scan the
staged changes (`git diff --cached`) for key-shaped strings. The
production bundle is checked by `npm run test:deployed`.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Backend exits at start: "No account storage is configured" | `SUPABASE_URL`/`SUPABASE_ANON_KEY` not set on the host. |
| "SUPABASE_ANON_KEY holds a service-role (secret) key" | The wrong key was copied - use the anon/publishable one. |
| Browser console: CORS error, backend log `origin not allowed` | `FRONTEND_ORIGIN` doesn't list the exact frontend origin (scheme, host, port, no trailing path). |
| Sign-in says "Confirm your email address first" | Email confirmation is on and the account isn't confirmed - confirm it, or create it with Auto Confirm (staging). |
| Save/Open say "temporarily unavailable" (503) | The backend can't reach Supabase - check the project is running (free projects pause when idle). |
| AI says "Backend request failed with status 502" | OpenAI refused or failed - check the key and the account's quota. |
