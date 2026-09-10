# Deployment

How to run i am Architect outside localhost: a real Supabase project for
accounts and projects, the backend on Fly.io, the frontend on Vercel. No
credential appears anywhere in this repository - every value below is
something you paste into a dashboard, a gitignored `.env` file, or a host's
secret store.

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
| Frontend | `npm run dev` | `npm run dev` | a Vercel project, e.g. `iarchitect-staging` | a separate Vercel project (or domain) |

Keep staging and production fully separate: separate Supabase projects,
separate backend apps, separate secrets. The real-infrastructure tests only
ever run against staging, and refuse to run unless you confirm that.

## 1. Create the Supabase project (staging)

1. At https://supabase.com, create a project named e.g. `iarchitect-staging`.
   Pick a strong database password and store it in your password manager -
   the app never needs it. Note the **region** you pick: the backend should
   run near it (step 2 of the hosted deployment).
2. **Authentication → Providers → Email**: enabled.
3. **Authentication → Sign In / Providers → Email → Confirm email**:
   - production: keep **on** (new accounts confirm by email);
   - staging: either keep it on and create test accounts in the dashboard
     with **Auto Confirm User** (step 4), or turn it off for staging only.
     Never weaken the production project. Supabase's built-in email sender
     allows only a few messages per hour - configure your own SMTP
     provider before relying on sign-up emails.
4. **Authentication → Users → Add user → Create new user**, with **Auto
   Confirm User**, twice: test users A and B for the real-infrastructure
   tests. Use addresses you control and passwords used nowhere else.

(The Auth **URL Configuration** - Site URL and redirect URLs - is set once
the frontend URL is known: step 8 of the hosted deployment.)

### Run the migrations

In **SQL Editor → New query**, run each file in
`backend/supabase/migrations/` in filename order - paste the whole file,
run it, then the next:

1. `20260910000000_create_projects.sql` - the table, trigger, RLS policies
   and grants;
2. `20260911000000_projects_document_check.sql` - replaces the document
   constraint so a document missing `version`, `objects` or `assemblies`
   is refused (the first version let a missing key through, because a CHECK
   that evaluates to NULL passes). One atomic, idempotent statement: if the
   tightened constraint is already live it changes nothing.

(Or, with the Supabase CLI: `supabase link --project-ref <ref>` then
`supabase db push` from `backend/`, which applies them in order.) Both are
safe to run again.

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
whether the migration is live.

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

**Project Settings → API**: the **Project URL** and the **anon /
publishable** key are what the backend needs. Never copy the service-role /
secret key anywhere - the backend refuses to start with one.

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

## 3. Hosted deployment, in order

The backend URL is baked into the frontend at build time, and the backend
only accepts the frontend's exact origin - so each side needs the other's
URL. Choosing both names first makes both URLs known before anything is
created.

### Step 1 - Choose the Fly.io and Vercel names

| | Name (example) | URL it gives |
|---|---|---|
| Fly.io app (backend) | `iarchitect-backend-staging` | `https://iarchitect-backend-staging.fly.dev` |
| Vercel project (frontend) | `iarchitect-staging` | `https://iarchitect-staging.vercel.app` |

Fly app names are global - if yours is taken, pick another and put it in
`fly.toml`'s `app = ...`. A Vercel project's production domain is normally
`https://<project>.vercel.app`; Vercel adds a suffix when that domain is
taken, so the frontend URL is only final in step 5.

### Step 2 - Determine the Supabase staging region

The backend checks every request's token with Supabase and reads and writes
projects there, so it should run in the Fly.io region nearest the database.
Find the region in **Supabase → Project Settings → General**, and set
`fly.toml`'s `primary_region` accordingly:

| Supabase (AWS) region | Fly.io region |
|---|---|
| `us-east-1` N. Virginia | `iad` |
| `us-east-2` Ohio | `ord` |
| `us-west-1` N. California, `us-west-2` Oregon | `sjc` |
| `ca-central-1` Canada | `yyz` |
| `sa-east-1` São Paulo | `gru` |
| `eu-west-1` Ireland, `eu-west-2` London | `lhr` |
| `eu-west-3` Paris | `cdg` |
| `eu-central-1` Frankfurt, `eu-central-2` Zurich | `fra` |
| `eu-north-1` Stockholm | `arn` |
| `ap-south-1` Mumbai | `bom` |
| `ap-southeast-1` Singapore | `sin` |
| `ap-southeast-2` Sydney | `syd` |
| `ap-northeast-1` Tokyo, `ap-northeast-2` Seoul | `nrt` |

(`fly platform regions` lists Fly's current regions.)

### Step 3 - Configure Fly.io

```bash
# once: install flyctl (https://fly.io/docs/flyctl/install/) and sign in
fly auth login

# create the app (no deployment yet) - the name from step 1, as in fly.toml
fly apps create iarchitect-backend-staging

# secrets - you type these; Fly stores them encrypted, never in the repo.
# --stage stores them without starting anything yet.
fly secrets set --stage -a iarchitect-backend-staging \
  OPENAI_API_KEY=... \
  SUPABASE_URL=https://<ref>.supabase.co \
  SUPABASE_ANON_KEY=... \
  FRONTEND_ORIGIN=https://iarchitect-staging.vercel.app
```

`FRONTEND_ORIGIN` is the frontend URL planned in step 1; step 7 corrects it
if Vercel assigns a different one.

### Step 4 - Deploy the backend

```bash
fly deploy
curl https://iarchitect-backend-staging.fly.dev/health     # {"status":"ok"}
fly logs
```

`Dockerfile` (repo root - the backend imports the shared engine in
`src/engine/`) builds the backend with Node 24, which runs the TypeScript
directly: no build step, no runtime dependencies, no secret in the image
(`.dockerignore` keeps every `.env` file out of the upload). `fly.toml`
forces HTTPS, sets `NODE_ENV=production`, and checks `/health` every 30 s.

### Step 5 - Obtain and confirm the frontend URL

Create the Vercel project - preferably by importing the GitHub repository
(**Vercel → Add New → Project → Import** `i-am-architect`), which uploads only
committed files. Name it as chosen in step 1 and, on the configuration screen,
**before** the first deployment, do step 6. (Or with the CLI: `vercel login`,
then `vercel link` in the repo root, which creates the project without
deploying; `.vercelignore` keeps `backend/`, every `.env` file and other
local-only files out of any CLI upload.)

Read the project's production domain in **Settings → Domains** - that exact
URL is the frontend origin.

### Step 6 - Configure Vercel

Add ONE environment variable, for **both Production and Preview**:

| Variable | Value | Environments |
|---|---|---|
| `VITE_AI_BACKEND_URL` | `https://iarchitect-backend-staging.fly.dev` | Production **and** Preview |

(CLI: `vercel env add VITE_AI_BACKEND_URL production`, then
`vercel env add VITE_AI_BACKEND_URL preview`.) It is not a secret - the
browser must know where the backend is. It is read at **build** time:
changing it takes a new deployment.

Every Vercel build - Production and Preview - runs the same checks, so a
build fails if the variable is missing or isn't `https://`. That is
deliberate: a deployment can never quietly point at localhost. The
production build's Content-Security-Policy allows network requests only to
the site itself and this backend.

Then deploy production: from the import screen, or `vercel deploy --prod`
(CLI). `vercel.json` sets `npm ci` + `npm run build`, the `dist` output, and
security headers.

**Preview deployments** are served from other URLs (one per branch or
commit). The backend accepts only the exact origins in `FRONTEND_ORIGIN`, so
a preview's requests are refused (403) - by design. To try one preview
against the staging backend, add that preview's exact URL to
`FRONTEND_ORIGIN` (comma-separated) and remove it afterwards - never a
wildcard.

### Step 7 - Set the backend's exact FRONTEND_ORIGIN

If the production URL from step 5 differs from the one planned in step 1:

```bash
fly secrets set -a iarchitect-backend-staging FRONTEND_ORIGIN=https://<the exact production URL>
```

(Setting a secret restarts the backend with it.) The value is an exact
origin: `https://`, the host, no path, no trailing slash.

### Step 8 - Configure the Supabase Auth URL settings

**Supabase → Authentication → URL Configuration**:

- **Site URL**: the exact frontend production URL;
- **Redirect URLs**: the same URL.

Confirmation emails then link back to the deployed app instead of the
default local address.

### Step 9 - Run the deployed smoke tests

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

## Reference

### Backend environment (Fly.io)

| Variable | Where | Example | Notes |
|---|---|---|---|
| `OPENAI_API_KEY` | Fly secret | - | Secret. Backend only. Set a monthly spend limit on its OpenAI project - any signed-in user can use the AI. |
| `SUPABASE_URL` | Fly secret | `https://abcdefgh.supabase.co` | |
| `SUPABASE_ANON_KEY` | Fly secret | - | The anon/publishable key. A service-role/secret key is refused. |
| `FRONTEND_ORIGIN` | Fly secret | `https://iarchitect-staging.vercel.app` | Comma-separated exact origins allowed by CORS. No wildcards, no paths; non-local origins must be https. |
| `NODE_ENV` | `fly.toml` / Dockerfile | `production` | In production, `LOCAL_AUTH=memory` is refused. |
| `PORT` | `fly.toml` / Dockerfile | `8787` | |
| `LOCAL_AUTH` | local only | `memory` | In-memory accounts for development. Never on a host. |

Never on Fly.io, Vercel or anywhere else: the Supabase service-role/secret
key or the database password.

### Frontend environment (Vercel)

Only `VITE_AI_BACKEND_URL`, for Production and Preview (step 6). Never the
OpenAI key, anything Supabase, or `FRONTEND_ORIGIN`.

### Logs

`fly logs` shows one JSON line per request - time, method, route (project
ids replaced by `:id`), operation (`projects.save`, `auth.signin`,
`ai.interpret`...), status, duration, whether the caller was signed in
(`user` / `none` / `invalid` / `unverified`), and a short failure reason.
Never a token, password, email address, or document. Failures of Supabase
or OpenAI are logged by error name and message.

### CORS and HTTPS

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
production bundle is checked by `npm run test:deployed`. `.dockerignore`
(Fly.io) and `.vercelignore` (Vercel CLI) keep local secret files out of
hosting uploads.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Backend exits at start: "No account storage is configured" | `SUPABASE_URL`/`SUPABASE_ANON_KEY` not set as Fly secrets. |
| "SUPABASE_ANON_KEY holds a service-role (secret) key" | The wrong key was copied - use the anon/publishable one. |
| Vercel build fails: "Set VITE_AI_BACKEND_URL … for the preview environment" | The variable is set for Production only - add it for Preview too (step 6). |
| Browser console: CORS error, backend log `origin not allowed` | `FRONTEND_ORIGIN` doesn't list the exact frontend origin (scheme, host, port, no trailing path) - or it's a Preview URL (by design). |
| Sign-in says "Confirm your email address first" | Email confirmation is on and the account isn't confirmed - confirm it, or create it with Auto Confirm (staging). |
| Save/Open say "temporarily unavailable" (503) | The backend can't reach Supabase - check the project is running (free projects pause when idle). |
| AI says "Backend request failed with status 502" | OpenAI refused or failed - check the key and the account's quota. |
