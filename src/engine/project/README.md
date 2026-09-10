# Project persistence

Sign in, create a project, build it by hand or with AI, save it, open it
again, and keep editing. The construction model in the stores is the source
of truth: a saved project is that model as one plain JSON document, and
opening one refills the stores - the scene and every panel rebuild from the
stores' ordinary notifications, exactly as they do for any edit.

## Architecture

```
Browser
  Top bar: New Project / Open… / Save / name / account     ui/topBar.ts, ui/projectChooser.ts, ui/authDialog.ts
    → AuthController (engine/auth/)                        the user's session: sign in/out, refresh, authorize(fetch)
    → ProjectPersistenceController                         DOM-free Create / Save / Open / Delete state machine
        → serializeProject() / loadProject()               projectPersistence.ts - stores ⇄ document
        → ProjectRepository (interface)                    ProjectRepository.ts
            HttpProjectRepository  → backend /api/projects, "Authorization: Bearer <the user's token>"

Backend (backend/src/createServer.ts)
  checks the token with the AuthService on every request → ProjectStore.forUser(user, token)
      SupabaseProjectStore  → Supabase PostgreSQL, as that user (Row Level Security)
      InMemoryProjectStore  → memory (LOCAL_AUTH=memory, npm run mock, tests)
```

- **Dependency injection.** The app only knows the `ProjectRepository`
  interface. `main.ts` constructs an `HttpProjectRepository` with the
  backend URL and a transport - `auth.authorize(fetch)`, which adds the
  signed-in user's token. The backend picks a `ProjectStore` at startup
  (`backend/src/server.ts`). Nothing under `src/engine/` knows Supabase
  exists: the Supabase adapters live in `backend/src/`.
- **No credentials in the browser.** The browser talks only to the backend
  and holds nothing but the user's own session tokens. The Supabase keys
  and the OpenAI key are read on the server only.
- **Ownership is enforced below the UI.** Every repository is scoped to one
  owner. In Supabase the database itself enforces it (Row Level Security);
  in memory `InMemoryProjectRepository` filters by owner. Another user's
  project behaves exactly like one that doesn't exist.
- **Independent of AI.** Nothing here imports the AI layer, and the AI
  layer needs nothing from here: after a load, AI reads the restored stores
  through its usual snapshot, like any other model.

## Files

| File | Responsibility |
|---|---|
| `projectDocument.ts` | `ProjectDocument` (the persisted schema), `parseProjectDocument()` (the one validator every document passes), `parseProjectName()`. Shared by the browser, the backend, and the tests. |
| `ProjectRepository.ts` | The `ProjectRepository` interface (create, save, get, list, delete), `ProjectRecord`/`ProjectSummary`/`ProjectInput`, `parseProjectInput()`, and the `ProjectNotFoundError`/`ProjectValidationError`/`ProjectAuthError` errors. |
| `InMemoryProjectRepository.ts` | One owner's projects in memory, and `InMemoryProjectStore`, which hands out one per user from a shared map. Validates every write, stores and returns copies. |
| `HttpProjectRepository.ts` | The browser's client for `/api/projects`. Injected base URL and transport, a timeout, clear errors; 401 becomes `ProjectAuthError`. |
| `projectPersistence.ts` | `serializeProject()` and `loadProject()` - the controlled hydration path. |
| `ProjectMetaStore.ts` | The project's identity: saved id (or null), name, timestamps. Not undoable. |
| `ProjectPersistenceController.ts` | Create, Save, Open and Delete for the UI: status, messages, `authRequired`, one operation at a time. |
| `ProjectContext.ts` | Holds `projectMeta`; `clearProject()` (New Project) resets it; re-exports the save/load operations. |
| `../auth/` | `AuthController` (session state, storage, refresh, `authorize()`), `HttpAuthClient` (the backend's `/api/auth` routes), shared types and credential rules. |
| `../testing/completeHouse.ts` | Test-only: the complete house the persistence suites save and reopen. |
| `verify.ts` | The persistence suite (see "Tests"). |

## The document

One project is one document with an explicit version:

```json
{
  "version": 1,
  "objects": [
    {
      "id": "wall-2", "type": "wall",
      "position": { "x": 0, "y": 1.55, "z": 3.9 }, "rotation": 0,
      "dimensions": { "length": 9.2, "height": 2.7, "thickness": 0.2 },
      "material": "paint", "color": "#e8dcc8", "assemblyId": null
    },
    {
      "id": "door-1", "type": "door", "...": "...",
      "hostId": "wall-2", "hostPlacement": { "offset": 3, "sill": 0 }
    }
  ],
  "assemblies": [
    { "id": "assembly-1", "name": "Bathroom", "objectIds": ["element-40", "element-51"], "createdAt": 1789000000000, "updatedAt": 1789000000000 }
  ]
}
```

- **Objects** are stored exactly as their stores hold them: id, type,
  position, rotation (radians around Y), the type's own dimensions,
  material, color, and the reserved `assemblyId`. Elements add their
  catalog `kind`, `label`, `params`, and - for linear kinds such as pipes,
  conduit and cable - `connections`. A loaded object is byte-for-byte the
  object that was saved.
- **Relationships are references by id.** A door or window in a wall has
  `hostId` and `hostPlacement` (offset along the wall, sill height); its
  position is re-derived from the wall on load. A connection is
  `{ endpoint, objectId, objectEndpoint }`, listed on both connected
  elements.
- **Assemblies** keep their id, name, optional description, members in
  order, and timestamps. An assembly's deleted-but-undoable members are
  left out, because history isn't saved.
- **What isn't stored:** meshes, anything Three.js, DOM or WebGL state,
  the selection, UI state, and undo history.
- **The version is checked.** Only `version: 1` is read; any other value
  (missing, a string, a newer number) fails with "Unsupported project
  document version" and nothing is changed.

A stored project wraps the document: `{ id, ownerId, name, createdAt,
updatedAt, document }`, with ISO 8601 timestamps. `ownerId` is the user who
owns it.

## Loading (hydration)

`loadProject(project, document)` never simulates UI clicks or replays
undoable commands:

1. **Validate the whole document** with `parseProjectDocument()`. If
   anything is wrong, nothing is touched.
2. **Replace the model.** Empty every store, then add every object and
   assembly straight from the document, keeping its id and values. Each
   store still runs its own validation. If a store ever refused something
   the document validator accepted, the previous model is put back and the
   load fails.
3. **Reserve the loaded ids.** Each factory's id counter moves past the
   loaded ids, so an object added afterwards never reuses one.
4. **Start clean.** Clear the selection and the undo history. Undo starts
   empty, and the load itself is not an undo step.

## Validation

`parseProjectDocument()` rejects, with a message naming the object:

- **Shape and version:** not a version-1 document with `objects` and
  `assemblies` arrays.
- **Types:** an unknown object type, or an element whose `kind` isn't in
  the catalog.
- **Ids:** an object id that isn't `<type>-<n>` or doesn't match its type,
  a duplicate object id, or a malformed or duplicate assembly id.
- **Dimensions, transforms, appearance, parameters:** anything the type's
  own validator rejects - missing, extra, zero, negative or non-numeric
  dimensions, a non-finite position or rotation, a blank material, a color
  that isn't `#rrggbb`, invalid element parameters.
- **Relationships:** a `hostId` that names no wall in the document, a
  placement that doesn't fit its wall or overlaps another opening, a
  placement on a free-standing opening, or a connection that names an
  object that isn't in the document.
- **Assembly references:** a member that isn't an object in the document,
  a member listed twice, a blank name, or an object `assemblyId` naming no
  assembly.

An opening saved with a `hostId` but no `hostPlacement` (older documents)
is not rejected: its placement is worked out from where it stands.

The backend runs the same validator before storing, and the browser runs it
again before loading, so a corrupted project can never overwrite the
current one.

## Accounts and ownership

- Saving, opening and deleting need a signed-in user. The top bar shows
  **Sign in** (email and password - sign in, or create an account) or the
  signed-in email with **Sign out**. Modelling works signed out.
- The session (the user's access and refresh tokens) is kept in
  `localStorage`, so a reload stays signed in; on startup it is confirmed
  with the backend. A token about to expire is refreshed before a request,
  and a request refused with 401 is retried once after a refresh. If the
  refresh fails, the user is signed out with "Your session expired - sign
  in again."
- Every project belongs to the user who created it. The backend takes the
  user from the token - never from the request body - and a user can only
  list, open, save or delete their own projects. Someone else's project
  answers exactly like a missing one.

## New Project, Save, Open, Delete

- **New Project** confirms when there is content, clears objects,
  assemblies, selection and history, and starts an "Untitled Project".
  Signed in, it is created in the user's account straight away (empty,
  owned by them); signed out, it stays unsaved. It never touches other
  saved projects.
- **Save** stores the model under the project's name: a new project the
  first time, the same project after that. Signed out, the user is asked to
  sign in first, and the save goes ahead once they have; an expired session
  asks them to sign in again. It shows "Saving…" and then the outcome, and
  refuses a second save while one is running. A failure leaves the model
  untouched and says why. If the stored copy has disappeared, the project
  is saved again as new. Saving only reads the model: it is never an undo
  step and doesn't change the selection.
- **Open…** lists the user's saved projects (name, object and assembly
  counts, last update), newest first. Signed out, it offers Sign in
  instead. Opening confirms when the current model has content; an invalid
  project fails with the reason and the current project is left as it was.
- **Delete** (in the Open… list) confirms, then removes that one project.
  The workspace is never cleared: deleting the open project just makes it
  unsaved.
- **Sign out** confirms when there is content, then clears the workspace -
  so the next person at the browser doesn't see it - and ends the session
  on the server.
- **The name** is an editable field in the top bar. A blank name is
  refused, names are trimmed and at most 120 characters, and renaming is
  not an undo step.

## History

The undo history is never saved. After an open it is empty; manual, AI and
relationship edits (moving a wall carries its openings) then undo and redo
as usual, and Save never adds or removes an entry.

## AI compatibility

After a load, `AIService` builds its snapshot and geometry from the
restored stores exactly as it does for a model built in the session: same
ids, same values, same hosts and connections. An AI `update_object` on a
restored object goes through the normal pipeline and makes one normal undo
entry. `backend/persistence.verify.ts` checks this for the complete house
through the real server, and `ai/e2e/verify.ts` checks it in the browser
pipeline.

## Storage

- **Supabase** (production): the backend's `SupabaseProjectStore` stores
  projects in a `projects` table - `id`, `user_id`, `name`, `document`
  (jsonb), `created_at`, `updated_at` - created by
  `backend/supabase/migrations/20260910000000_create_projects.sql`, with
  Row Level Security so each user reaches only their own rows. See
  `backend/README.md`.
- **Memory** (local development and tests): `InMemoryProjectStore`. Projects
  last as long as the backend process.

## Tests

`verify.ts` runs with `--experimental-transform-types`, because it uses the
real `ProjectContext`. It covers:

- serializing all seven object types, every element kind, and an assembly;
  every field of every object as stored; nothing transient; JSON safety;
- hosts and connections saved by id, both ways, and restored with the
  rest of the complete house, geometry included;
- repository create, get, list, save and delete, with validation;
  ownership between two users; copies in and out;
- restoring identical ids and values;
- every rejection above (including broken hosts, connections, kinds and
  versions), and that a rejected load leaves the model, selection and
  history untouched;
- rollback when a store refuses an object;
- empty history after a load, then normal editing - including moving a
  wall that hosts openings - with undo and redo;
- no id reuse after a load;
- New Project and createProject, which never touches other projects;
- Delete, of another project and of the open one;
- that Save leaves undo and redo alone, and that only one save runs at a
  time;
- save and open failures, and `authRequired` for a signed-out user;
- the HTTP client's contract and its error mapping (401 included).

`../auth/verify.ts` covers the browser's session handling. The backend's
suites (`backend/verify.ts`, `backend/auth.verify.ts`,
`backend/persistence.verify.ts`) run the same clients against the real
server, the Supabase adapters against a mocked Supabase, and the complete
house end to end.

## Limitations

- **The last save wins.** Two tabs saving the same project overwrite each
  other; there is no conflict detection, autosave, or version history.
- **Opening doesn't save the current model first.** The user is asked to
  confirm instead.
- **No sharing, teams, or roles.** A project has exactly one owner.
