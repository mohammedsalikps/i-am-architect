# Project persistence

Create a project, build it by hand or with AI, save it, open it again,
and keep editing. The construction model in the stores is the source of
truth: a saved project is that model as one plain JSON document, and
opening one refills the stores - the scene and every panel rebuild from
the stores' ordinary notifications, exactly as they do for any edit.

## Architecture

```
Top bar (Save / Open… / name)          ui/topBar.ts, ui/projectChooser.ts
  → ProjectPersistenceController       DOM-free Save/Open state machine
      → serializeProject() / loadProject()   projectPersistence.ts - stores ⇄ document
      → ProjectRepository (interface)        ProjectRepository.ts
          browser:  HttpProjectRepository  → backend /api/projects
          backend:  InMemoryProjectRepository   (a database-backed repository later)
```

- **Dependency injection.** The app only knows the `ProjectRepository`
  interface. `main.ts` constructs an `HttpProjectRepository` with the
  backend URL and a `fetch`. `backend/src/server.ts` and
  `backend/mockBackend.ts` pass an `InMemoryProjectRepository` to
  `createServer()`. Nothing depends on a particular storage.
- **No credentials in the browser.** The browser talks only to the
  backend. A future Supabase repository would run on the backend, with
  its service key read there - never through Vite.
- **Independent of AI.** Nothing here imports the AI layer, and the AI
  layer needs nothing from here: after a load, AI reads the restored
  stores through its usual snapshot, like any other model.

## Files

| File | Responsibility |
|---|---|
| `projectDocument.ts` | `ProjectDocument` (the persisted schema), `parseProjectDocument()` (the one validator every document passes), `parseProjectName()`. Shared by the browser, the backend, and the tests. |
| `ProjectRepository.ts` | The `ProjectRepository` interface, `ProjectRecord`/`ProjectSummary`/`ProjectInput`, `parseProjectInput()`, and the `ProjectNotFoundError`/`ProjectValidationError` errors. |
| `InMemoryProjectRepository.ts` | The backend's store until a database exists, and every test's. Validates every write, stores and returns copies. |
| `HttpProjectRepository.ts` | The browser's client for `/api/projects`. Injected base URL and `fetch`, a timeout, clear errors. |
| `projectPersistence.ts` | `serializeProject()` and `loadProject()` - the controlled hydration path. |
| `ProjectMetaStore.ts` | The project's identity: saved id (or null), name, timestamps. Not undoable. |
| `ProjectPersistenceController.ts` | Save and Open for the UI: status, messages, one operation at a time. |
| `ProjectContext.ts` | Holds `projectMeta`; `clearProject()` (New Project) resets it; re-exports the save/load operations. |
| `verify.ts` | The persistence suite (see "Tests"). |

## The document

One project is one document:

```json
{
  "version": 1,
  "objects": [
    {
      "id": "wall-2", "type": "wall",
      "position": { "x": 0, "y": 1.55, "z": 3.9 }, "rotation": 0,
      "dimensions": { "length": 9.2, "height": 2.7, "thickness": 0.2 },
      "material": "generic", "color": "#c9c9c9", "assemblyId": null
    }
  ],
  "assemblies": [
    { "id": "assembly-1", "name": "Ground Floor", "objectIds": ["wall-2"], "createdAt": 1789000000000, "updatedAt": 1789000000000 }
  ]
}
```

- **Objects** are stored exactly as their stores hold them: id, type,
  position, rotation (radians around Y), the type's own dimensions,
  material, color, and the reserved `assemblyId`, which is always null
  today. A loaded object is byte-for-byte the object that was saved.
- **Assemblies** keep their id, name, optional description, members in
  order, and timestamps. Membership lives here, as it does in the app.
  An assembly's deleted-but-undoable members are left out, because
  history isn't saved.
- **What isn't stored:** meshes, anything Three.js, DOM or WebGL state,
  the selection, UI state, and undo history.

A stored project wraps the document: `{ id, name, createdAt, updatedAt,
document }`, with ISO 8601 timestamps.

## Loading (hydration)

`loadProject(project, document)` never simulates UI clicks or replays
undoable commands:

1. **Validate the whole document** with `parseProjectDocument()`. If
   anything is wrong, nothing is touched.
2. **Replace the model.** Empty every store, then add every object and
   assembly straight from the document, keeping its id and values. Each
   store still runs its own validation. If a store ever refused
   something the document validator accepted, the previous model is put
   back and the load fails.
3. **Reserve the loaded ids.** Each factory's id counter moves past the
   loaded ids, so an object added afterwards never reuses one. Without
   this, a new `wall-2` would silently overwrite the loaded `wall-2`.
4. **Start clean.** Clear the selection and the undo history. Undo
   starts empty, and the load itself is not an undo step.

## Validation

`parseProjectDocument()` rejects, with a message naming the object:

- **Shape:** not a version-1 document with `objects` and `assemblies`
  arrays.
- **Types:** an unknown object type (only wall, pillar, beam, slab, door
  and window are supported).
- **Ids:** an object id that isn't `<type>-<n>` or doesn't match its
  type, a duplicate object id, or a malformed or duplicate assembly id.
- **Dimensions:** missing, extra, zero, negative, or non-numeric.
- **Transforms and appearance:** a non-finite position or rotation, a
  blank material, or a color that isn't `#rrggbb`. Anything else the
  type's own store validator rejects is rejected too.
- **Assembly references:** a member that isn't an object in the
  document, a member listed twice, a blank name, or an object
  `assemblyId` naming no assembly.

The backend runs the same validator before storing, and the browser runs
it again before loading, so a corrupted project can never overwrite the
current one.

## Save, Open, New Project

- **Save** stores the model under the project's name. The first save
  creates the project; later saves update the same one. It shows
  "Saving…" and then the outcome, and refuses a second save while one
  is running. A failure leaves the model untouched and says why. If the
  stored copy has disappeared (the backend's in-memory store was
  restarted), the project is saved again as new. Saving only reads the
  model: it is never an undo step and doesn't change the selection.
- **Open…** lists the saved projects (name, object and assembly counts,
  last update) and opens one. If the current model has content, the
  user confirms first. An invalid project fails with the reason, and the
  current project is left as it was.
- **New Project** works as before: it confirms when there is content,
  then clears objects, assemblies, selection and history, and starts an
  unsaved "Untitled Project".
- **The name** is an editable field in the top bar. A blank name is
  refused, names are trimmed and at most 120 characters, and renaming is
  not an undo step.

## AI compatibility

After a load, `AIService` builds its snapshot and geometry from the
restored stores exactly as it does for a model built in the session:
same ids, same values. An AI `update_object` on a restored object and an
AI house built into a loaded project go through the normal pipeline and
make normal, grouped undo entries. `ai/e2e/verify.ts` checks both.

## Storage today, and Supabase later

No database is configured in this repository. The backend keeps projects
in an `InMemoryProjectRepository`, so they last as long as the backend
process.

A Supabase repository would implement `ProjectRepository` on the backend,
keeping its service-role key in the backend's environment only. The
intended table stores one document per project:

```sql
create table projects (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 120),
  data jsonb not null,            -- the ProjectDocument
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

Row ownership and access policies come with authentication, in a later
milestone.

## Tests

`verify.ts` runs with `--experimental-transform-types`, because it uses
the real `ProjectContext`. It covers:

- serializing all six types and an assembly, and JSON safety;
- repository create, get, list and save, with validation;
- restoring identical ids and values;
- every rejection above, and that a rejected load leaves the model,
  selection and history untouched;
- rollback when a store refuses an object;
- empty history after a load, then normal editing;
- no id reuse after a load;
- New Project;
- that Save leaves undo and redo alone, and that only one save runs at a
  time;
- save and open failures;
- the HTTP client's contract and its error mapping.

`backend/verify.ts` runs `HttpProjectRepository` against the real server.

## Limitations

- **Storage is in memory.** Projects are lost when the backend stops.
- **No accounts or access control.** Anyone who can reach the backend
  can list and open every project.
- **No autosave, version history, delete, rename-from-list, or
  conflict detection.** The last save wins.
- **Opening doesn't save the current model first.** The user is asked
  to confirm instead.
