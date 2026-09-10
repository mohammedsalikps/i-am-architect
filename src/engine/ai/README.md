# AI command pipeline

A provider-independent layer that turns a natural-language construction
instruction into validated, structured construction commands, executed
through the existing `CommandExecutor` (see `src/engine/commands/`).

`providers/OpenAIProvider.ts` is the first real (network-backed)
provider, using OpenAI's Chat Completions API with structured JSON
output. **Read "Security boundary" below before using it anywhere** -
this repository has no backend, and nothing in the running application
currently constructs `OpenAIProvider` with a real API key. No API key
is hardcoded anywhere, no `.env` file is committed, and no test in this
module ever makes a real network call (see "Verification approach").

## Files

| File | Responsibility |
|---|---|
| `types.ts` | Shared request/response/result types, `AI_SUPPORTED_OBJECT_TYPES`, and `buildAIProjectSnapshot()` - the only place store data enters the AI layer, as a plain, deterministic snapshot of the current model. |
| `parseProjectSnapshot.ts` | `parseAIProjectSnapshot()` - validates an untrusted incoming snapshot and returns a sanitized copy. Shared by the backend and the E2E mock backend. |
| `AIProvider.ts` | The `AIProvider` interface every provider (mock or real) implements. |
| `MockAIProvider.ts` | A deterministic, keyword-matching `AIProvider` - no network calls, no randomness. Answers a house instruction with the plan from `housePlan.ts`. |
| `housePlan.ts` | `buildSimpleHousePlan()` - the deterministic 12-command plan for a simple house, and `findHouseCenter()` - where it goes so it clears existing objects. See "AI house builder". |
| `providers/OpenAIProvider.ts` | A real, OpenAI-backed `AIProvider` - structured JSON output, injected API key and HTTP transport. See "Security boundary". |
| `providers/verify.ts` | Node-runnable unit verification for `OpenAIProvider`, entirely against a mocked transport. |
| `AICommandPipeline.ts` | Orchestrates one instruction end-to-end: validate input → call provider → validate output → execute via `CommandExecutor`. |
| `verify.ts` | Node-runnable unit verification for `MockAIProvider`/`AICommandPipeline`/`buildAIProjectSnapshot()` (`npm run verify` includes this and `providers/verify.ts`). |
| `geometry/analyzeConstructionGeometry.ts` | `analyzeConstructionGeometry()` - pure, deterministic bounding boxes and pairwise spatial facts derived from an `AIProjectSnapshot`. The only geometry calculation - see "Construction geometry analysis". |
| `aiProjectContext.ts` | `buildAIProjectContext()` - the snapshot plus its derived geometry, as the deep-frozen `AIProjectContext` every provider receives; `parseAIProjectContext()` - the backend's sanitize-then-derive entry point. See "Geometry in the AI context". |
| `geometry/verify.ts` | Node-runnable unit verification for the geometry analyzer. |

## Construction geometry analysis

`analyzeConstructionGeometry(snapshot)` (in `geometry/`) turns an
`AIProjectSnapshot` into plain geometric facts a later milestone can
use for spatial reasoning. It reads only the snapshot - no stores,
Three.js, DOM, providers, or `CommandExecutor` - never modifies it, and
returns fresh JSON-safe data with no timestamps, so the same snapshot
always yields byte-identical output.

**What it returns.**

- `objects`: one entry per object, sorted by id (the same `compareIds`
  order as the snapshot). Each entry has its id, type, center, dimensions,
  rotation, and axis-aligned bounding box (`aabb.min`/`aabb.max`, plus
  `size`).
- `relationships`: one entry per pair of objects, `a` before `b` in id
  order. Each entry has the center delta (b minus a), the 3D,
  horizontal (X/Z), and vertical (Y) center distances, per-axis and
  whole-box `overlap` flags, per-axis `gap`, and where a's box lies
  relative to b's (`aRelativeToB`).
- `invalidObjects`: any object whose geometry can't be derived.

**Coordinates.** The coordinates are the app's own, unchanged:

- World X, Y, Z in meters, with +Y up.
- `position` is the center of the object's bounding volume.
- `rotation` is radians around the vertical Y axis, applied the way the
  mesh builders apply it (Three.js `rotation.y`).

"Left", "right", "in front of", and "behind" are named from the app's
**Front** view preset (camera at +Z looking toward −Z):

| Term | Meaning |
|---|---|
| `leftOf` | entirely at smaller X |
| `rightOf` | entirely at larger X |
| `inFrontOf` | entirely at larger Z (toward that camera) |
| `behind` | entirely at smaller Z |
| `above` | entirely at larger Y |
| `below` | entirely at smaller Y |

These terms refer to world axes. They don't depend on which way an
object faces.

**AABB meaning.** Each type's dimensions map to its local axes exactly
as its mesh builder sizes its `BoxGeometry`. `geometry/verify.ts` reads
the builders' source to keep the two in step.

| Type | Local X | Local Y | Local Z |
|---|---|---|---|
| wall | length | height | thickness |
| pillar | width | height | depth |
| beam | length | height | width |
| slab | length | thickness | width |
| door, window | width | height | thickness |

The box is rotated around its center by `rotation`, and the AABB is the
smallest world-axis-aligned box that contains it. At 90° a wall's length
therefore runs along Z. An AABB is exact for unrotated objects and
over-covers rotated ones; it isn't the object's true footprint.

A box's projection onto an axis "overlaps" another's only if they share
some length. Touching faces don't overlap, and a box that touches
another's face still counts as entirely on that side.

**Precision.** Every derived number is rounded to 9 decimal places
(`GEOMETRY_DECIMALS`). This stops floating-point noise, such as
`cos(π/2)` not being exactly 0, from turning touching boxes into
overlapping ones. It also makes a rotation and the same rotation plus
any number of full turns give identical boxes.

**Invalid input.** An object with an unknown type, a non-finite position
or rotation, or a dimension that is missing, zero, or negative isn't
given a box. It is listed in `invalidObjects`, with the same field names
and messages its validator uses, and left out of `relationships`.
Snapshots built from the real stores never contain such objects, because
the stores already reject them.

**What it deliberately doesn't do yet.**

- Every provider receives it as the context's `geometry` section (see
  "Geometry in the AI context"), but nothing acts on it: the app never
  turns it into sentences or decisions.
- No command uses it.
- No placement relative to other objects, alignment, connection,
  snapping, collision resolution, rooms, or planning.
- It has no notion of an object's true (rotated) footprint, of wall
  hosting, or of openings.
- Relationships cover every pair, so they grow as n(n−1)/2. Whatever
  later sends them to a model will need to choose which to include.

## Data flow

```
instruction (string)
      │
      ▼
AICommandPipeline.run(instruction, projectContext, availableObjectTypes)
      │  1. reject if empty
      ▼
AIProvider.interpret({ instruction, projectContext, availableObjectTypes })
      │  2. provider returns { commands: unknown[] }
      ▼
per-command structural validation (shape / object type / command type)
      │  3. one malformed / unsupported entry rejects the WHOLE response - nothing runs
      ▼
executeCommandBatch(commands, history)   one history group: all or nothing
      │
      ▼
CommandExecutor.execute(command)   ← the ONLY mutation path
      │  4. domain validation (e.g. invalid dimensions), history, stores;
      │     the first failure rolls back every command before it
      ▼
AIPipelineResult { success, outcomes[], errors[] }
```

## Architectural decisions

- **Provider independence.** `AIProvider` is a plain interface
  (`interpret(request): AIProviderResponse | Promise<AIProviderResponse>`).
  `AICommandPipeline` only ever depends on that interface, never on
  `MockAIProvider`/`OpenAIProvider`/any specific implementation -
  `OpenAIProvider` was added with zero changes to `AICommandPipeline`'s
  validation logic, `CommandExecutor`, or any store (the only pipeline
  change was making `run()` return a `Promise`, needed because a real
  network call can't resolve synchronously - see "Sync or async,
  provider's choice" below). A future Gemini/Claude-backed provider
  needs only a new class implementing `AIProvider`.
- **No direct store or scene access.** Neither `AIProvider` nor
  `AICommandPipeline` imports `WallStore`/`PillarStore`/.../`SceneManager`/
  any Three.js type. A provider only ever sees a read-only
  `AIProjectSnapshot` (counts, the selected id, and every current
  object and assembly as plain, deterministic JSON, built by
  `buildAIProjectSnapshot()`) - never a live store reference. The
  pipeline's only way to cause a mutation is calling
  `commandExecutor.execute()`, exactly the same entry point the UI
  already uses (see `src/engine/commands/README.md`). This preserves
  every existing guarantee CommandExecutor already provides: structured-data-only
  mutations, shared `HistoryManager` undo/redo, and each store's own
  validation.
- **Untrusted output at every boundary.** An `AIProviderResponse`'s
  `commands` field is typed `unknown[]`, not `Command[]` - the same
  reasoning as `CommandExecutor.execute(input: unknown)`. Nothing this
  pipeline receives from a provider is trusted until it has passed
  structural validation (`AICommandPipeline.ts`) and then
  `CommandExecutor`'s own domain validation.
- **Two validation layers, not one.** Structural validation
  (`AICommandPipeline`) answers "is this shaped like a command at all,
  for a type/action this app supports?" and runs first, so it can give
  callers precise reasons (malformed shape vs. unsupported object type
  vs. unsupported command type) that a bare `CommandExecutor` rejection
  message doesn't distinguish. Domain validation (invalid dimensions,
  missing ids, etc.) is deliberately left to `CommandExecutor`/each
  store's validator - never duplicated here - so there is exactly one
  place that decides what a valid wall/pillar/beam/slab/door/window
  looks like.
- **Multi-command responses, all or nothing.** `response.commands` may
  contain many commands - a whole house is one response - up to
  `MAX_COMMANDS_PER_RESPONSE` (200). The pipeline first validates every
  command's shape, and one invalid entry rejects the whole response
  before anything runs. It then executes the list through
  `executeCommandBatch()` (`src/engine/commands/`): in order, stopping
  at the first command `CommandExecutor` rejects and rolling back every
  command before it. A response is applied completely or not at all -
  never half a house. Each command still gets its own
  `AICommandOutcome`, saying whether it ran, failed, was rolled back, or
  wasn't run.
- **Sync or async, provider's choice.** `AIProvider.interpret()` may
  return `AIProviderResponse` directly (`MockAIProvider` does - it needs
  nothing async) or a `Promise<AIProviderResponse>` (`OpenAIProvider`
  always does - an HTTP call cannot resolve synchronously).
  `AICommandPipeline.run()` is `async` and always `await`s the result,
  which works identically either way. This is the one contract change
  `OpenAIProvider` required (`AICommandPipeline.run()` now returns
  `Promise<AIPipelineResult>` instead of `AIPipelineResult` directly) -
  every other piece of the pipeline (structural validation, error
  staging, `CommandExecutorLike`) is unchanged.
- **Shared undo/redo - one step per response.** Every command the
  pipeline executes goes through `CommandExecutor` exactly like a
  UI-issued command, so it is recorded on the same shared
  `HistoryManager` (see `src/engine/project/ProjectContext.ts`). The
  pipeline is also handed that `HistoryManager` - only its group
  methods, through `AIService`'s `history` option - and records a whole
  response as ONE entry. One Undo removes an entire AI-built house, one
  Redo brings it back, and manual edits before and after it interleave
  normally. The only history mechanism involved is `HistoryManager`'s
  existing groups.

## Geometry in the AI context

Every provider receives `projectContext` as an `AIProjectContext`: the
construction snapshot, plus a `geometry` section holding
`analyzeConstructionGeometry()`'s output (`objects`, `relationships`,
`invalidObjects`) for that same snapshot. So besides "wall-1 is at these
coordinates with these dimensions", the model can read facts such as
wall-1's center being 6 m from wall-2's, their boxes overlapping on Z,
and wall-1 being entirely left of wall-2. These arrive as structured
numbers and booleans. The application never turns them into sentences
and never acts on them.

```
stores (ProjectContext)
  → buildAIProjectSnapshot()              AIService, per instruction
  → buildAIProjectContext(snapshot)       AICommandPipeline.run(): copy, derive geometry, deep-freeze
  → provider.interpret({ projectContext })
       MockAIProvider                     reads it in-process
       BackendAIProvider → POST /api/ai/interpret   (context, incl. the browser's geometry)
         → parseAIProjectContext()        backend: sanitize snapshot, drop client geometry, derive again
         → OpenAIProvider → {"currentConstructionState": { ...snapshot, "geometry": {...} }}
```

- **One calculation.** `analyzeConstructionGeometry()` is the only
  geometry code. The browser and the backend both run it: the backend
  imports it from `src/engine/ai/`, just as it already imports
  `OpenAIProvider` and the snapshot parser. `buildAIProjectContext()`
  (`aiProjectContext.ts`) is the only place a context is assembled.
  `OpenAIProvider` copies the section field by field into its message
  and computes nothing itself.
- **Always from the same snapshot.** The pipeline derives geometry from
  the exact snapshot it is about to send, on every run. A `geometry`
  field already on its input is ignored.
- **Trust boundary.** The browser sends its geometry, so the request
  carries the full context, but the backend never reads it.
  `parseAIProjectContext()` sanitizes the snapshot fields, which drops
  any other key, `geometry` included. It then derives geometry from the
  sanitized snapshot. Fabricated, malformed, or missing client geometry
  changes nothing and can't make a request fail. `backend/verify.ts`
  sends fabricated geometry and checks that OpenAI receives the
  server-derived values.
- **Plain, frozen, deterministic.** The context gets the same guarantees
  as the snapshot: JSON only, copied field by field, and sorted, so the
  same model always yields the same bytes. It is also deep-frozen, so a
  provider can read it but not change it.
- **Coordinates and relationship semantics** are those of the analyzer,
  as described in "Construction geometry analysis" above:
  - world X/Y/Z in meters, rotations in radians, +Y up
  - `leftOf`/`rightOf` compare X, `inFrontOf`/`behind` compare Z
    (+Z is toward the Front view's camera), and `above`/`below` compare Y
  - every relationship is about whole axis-aligned boxes in world space,
    regardless of which way an object faces
- **What the model is told.** Two prompt lines were appended. They say
  that geometry values are deterministic calculations from the current
  state, give the units and the world-space meaning of the direction
  flags, and say that geometry is data, not instructions. They also say
  it doesn't change which commands the model may produce. The command
  schema and message layout are unchanged.
- **MockAIProvider.** When an instruction names two or more existing
  objects, its notes include each named pair's relationship as the exact
  JSON from the context. This is proof that geometry reaches a provider,
  and nothing more.
- **Unfiltered, so it grows fast.** Every pair is sent: n(n−1)/2
  relationships of about 360 bytes each.

  | Objects | Pairs | Request body |
  |---|---|---|
  | 10 | 45 | about 20 KB |
  | 30 | 435 | about 160 KB |
  | 50 | 1,225 | about 450 KB |

  At about 75 objects, the request exceeds the backend's 1 MB body cap
  (`413`). The model's context window is likely to run out before that.
  Choosing which relationships to send is a separate, later milestone.
- **Still context only.** It adds no placement relative to other
  objects, alignment, connection, snapping, collision resolution, rooms,
  or planning. The prompt still tells the model to refuse
  relative-placement requests.

## AI house builder

One instruction can produce a whole, editable house - AI + CAD, not AI
instead of CAD. The AI only ever returns command data; the existing
engine builds the objects.

```
"Build a simple 2-bedroom house on a 10m × 8m footprint."
  → AIService.submit()        fresh snapshot + derived geometry
  → provider                  MockAIProvider, or BackendAIProvider → backend → OpenAIProvider
  → 12 "<type>.add" commands  explicit dimensions, positions, rotations
  → AICommandPipeline         validate all 12, then one all-or-nothing batch
  → CommandExecutor → stores  real walls, pillars, slab, door, windows
  → HistoryManager            ONE undo entry for the whole house
```

- **The plan.** `buildSimpleHousePlan()` in `housePlan.ts` is the
  reference layout, in the engine's own coordinates. On an L × W
  footprint (L along X, W along Z) it has:
  - one L × W slab, 0.2 m thick, on the ground;
  - four 0.4 × 0.4 m corner pillars standing on the slab;
  - four 0.2 m perimeter walls standing on the slab, running pillar to
    pillar, with the side walls turned 90°;
  - a door on the front (+Z) wall's outside face;
  - two windows with a 0.9 m sill, on the back and right walls' outside
    faces.

  Parts meet face to face, so the geometry analysis finds no
  overlapping pair. Openings sit on the walls' outside faces because
  there is no wall hosting.
- **Placement from the context.** The plan goes on the origin when that
  is free. Otherwise `findHouseCenter()` reads the context's geometry
  and moves the plan clear of every existing object, and the provider's
  notes say where it went.
- **Mock and real model.** `MockAIProvider` recognizes an instruction
  to build a new house ("build a … house/home/cottage"), reads the
  footprint ("10m × 8m", "12 x 9", "10 by 8 metres"; default 10 × 8,
  sides 4-40 m), and returns the plan. `OpenAIProvider`'s schema now
  gives every `<type>.add` an optional `position`. Its prompt now says:
  - commands are data executed by the construction engine, never code;
  - the coordinate and axis conventions;
  - the engine assigns ids;
  - how to build coherent geometry;
  - the same house layout the mock returns.
- **Atomic, one undo step.** See "Multi-command responses, all or
  nothing" and "Shared undo/redo" above. A plan with one bad part is
  rejected whole, and nothing is left behind.
- **Editable afterwards.** The objects are ordinary objects. When an
  object's height changes, the stores keep its base where it was (see
  `objects/grounding.ts`), so editing a wall that stands on the slab
  keeps it on the slab instead of sinking it to the ground.
- **What it doesn't do.**
  - The reference plan has no rooms, interior walls, finishes, services,
    or roof. Those are element kinds now (see `elements/README.md`): ask
    for them, or add them from the ribbon. The notes say so.
  - Openings aren't cut into walls, and the plan's door and windows
    aren't hosted (`hostId`) - hosting is a manual tool today.
  - Nothing is saved.
  - A real model's plan isn't guaranteed to match the reference layout.
    It is validated exactly like any other response, and a malformed or
    invalid one fails whole.

## Security boundary - why `OpenAIProvider` is never constructed with a real key today

This application is currently a **pure client-side Vite SPA** - `npm run
build` produces static HTML/CSS/JS with no server of any kind (see the
project root's `package.json`: `dev`/`build`/`preview` are all plain
Vite commands, nothing else). That matters a great deal for an API key:

- Vite only inlines environment variables prefixed `VITE_` into the
  browser bundle (a deliberate Vite security feature) - so a bare
  `OPENAI_API_KEY` would never reach `import.meta.env` in client code at
  all, and renaming it to `VITE_OPENAI_API_KEY` to work around that
  would inline the **raw key, in cleartext, into `dist/assets/*.js`** -
  readable by anyone who opens the deployed site's dev tools or just
  downloads that file. There is no Vite configuration that makes this
  safe; it is a property of shipping a secret to code that runs on
  someone else's machine.
- Even without build-time inlining, calling `https://api.openai.com`
  directly from browser JS means putting `Authorization: Bearer
  <key>` into a `fetch()` call the browser's own Network tab shows in
  full to that browser's user.

**Given that, this milestone does not wire a real API key into any
browser-reachable code path.** Concretely:

- `OpenAIProvider` **never reads `process.env` or `import.meta.env`
  itself** - the API key and the HTTP transport (`fetch`) are both
  passed in explicitly via its constructor (`OpenAIProviderOptions`).
  This keeps the class itself environment-agnostic: it has no idea
  whether it's running in a browser or a server, which is exactly what
  makes it safe to *write* now without being safe to *deploy* into the
  browser yet.
- Nothing in `main.ts` or anywhere under `src/ui/` constructs
  `OpenAIProvider` (there is no AI chat UI yet regardless - see
  "Limitations" - so this milestone introduces no new exposure either
  way).
- `.env.example` documents the `OPENAI_API_KEY` variable name for a
  *future* trusted, server-side consumer - it is not read by anything
  in this repository today. No `.env` file is committed (see
  `.gitignore`), and no real key exists anywhere in this codebase or
  its tests.

**What a real deployment needs instead (not built in this milestone):**
a small backend or serverless endpoint that holds `OPENAI_API_KEY`
server-side, accepts `{ instruction, projectContext, availableObjectTypes
}` from the browser, constructs `OpenAIProvider` itself (server-side,
with a real `fetch` and the real key), and returns only the resulting
`AIProviderResponse` to the browser. The browser would then use a thin
`AIProvider` implementation that just calls *that* endpoint - it would
never see the OpenAI key at all. `OpenAIProvider` as implemented here is
already shaped for exactly that role (injected key + injected transport,
zero environment/global reads) and needs no changes to be dropped into
such a backend unchanged.

## Verification approach

Both `verify.ts` and `providers/verify.ts` follow the same "no test
framework, plain assertion helpers, run directly by Node" convention as
every other `verify.ts` in this project. Neither instantiates
`CommandExecutor` against real `*HistoryController` classes (those use
TypeScript parameter-property constructors, which Node's native
TypeScript support can't run - see `src/engine/commands/verify.ts`'s own
header comment for the full explanation); `verify.ts` instead uses the
same store-backed `*HistoryLike` stub pattern already established there.

`verify.ts` covers: `MockAIProvider` output for every example
instruction, single- and multi-command execution, malformed/non-array
provider output, unsupported object types, unsupported command types,
an empty instruction, all-or-nothing batches (one bad command stops the
response; with a history, everything before it is rolled back and a
successful response is one undo entry), the house plan (pinned
coordinates, no overlapping parts, footprint parsing, placement clear of
existing objects), undo/redo compatibility (a pipeline-issued command
undoes/redoes exactly like a directly-issued one), and a structural
check that an `AICommandPipeline` instance holds no store reference at
all - only a provider, a `CommandExecutorLike`, and an optional history
group handle. The end-to-end suite (`e2e/verify.ts`) builds the house
through the real `ProjectContext` and checks the objects, the geometry,
one-step undo/redo, rollback of bad plans, and editability.

`providers/verify.ts` covers `OpenAIProvider` specifically: request
shaping (method, headers, structured `response_format`, the raw
instruction as the user message), response parsing for a single command
and for all six object types in one multi-command response, notes
passthrough, every required error case (missing/blank API key, missing
transport, a failed request, a non-OK HTTP status, a non-JSON HTTP
body, a response missing `choices[0].message.content`, non-JSON message
content, and content missing a `commands` array), and end-to-end
integration through the real `AICommandPipeline` (including an
unsupported command from the model being rejected the exact same way
any other provider's bad output is). **Every check constructs
`OpenAIProvider` with a hand-rolled mock `fetch` - never the real global
`fetch`, never a real key - so this file makes zero real network calls;
several checks additionally assert the mock was called exactly once,
as positive proof no extra (or real) request happened.**

## Limitations

- **The model can edit existing objects, but only by explicit property
  edits.** Besides `<type>.add`, a provider can return `update_object`
  (see commands/README.md): an existing object's id, copied from the
  construction state, plus the dimensions, position axes, rotation,
  material, or color to change. CommandExecutor resolves the id and runs
  that type's existing update, so validation and undo/redo are the same
  as a UI edit, and an unknown id is an error - never a new object. New
  objects can carry an explicit position, so the model can lay out a
  multi-object plan such as a house (see "AI house builder"), but it
  can't delete or duplicate objects, and there is no snapping,
  alignment, or collision resolution - a plan is coherent only because
  its coordinates are. `MockAIProvider` understands four edit phrasings:
  "Make wall-1 5 meters long", "Change wall-1 height to 3.2 meters",
  "Rotate wall-1 by 90 degrees" (or "to"), and "Move wall-1 to X=2".
- **What the model sees.** `OpenAIProvider` sends the full context: the
  snapshot plus its derived `geometry` section (see "Geometry in the AI
  context"), inside the same `currentConstructionState` message. The
  snapshot part covers every
  object's id, type, dimensions, position, rotation, material, color,
  and assembly membership, plus the assemblies, counts, and selected id -
  as a pure-JSON message (`{"currentConstructionState": ...}`) between
  the system prompt and the instruction. The system prompt tells the
  model this is the current state and that existing ids may be
  referenced. The state is a separate user-role message, not part of the
  system prompt, because it contains text users typed (assembly names,
  materials) that shouldn't carry the app's own authority. It is
  projected field by field, so nothing beyond the snapshot's defined
  fields is ever sent, and the same snapshot always produces the same
  request. The model can read an existing object's dimensions and
  position (e.g. "as tall as wall-7"), edit it with `update_object`, and
  give new objects explicit positions - enough to plan a house around
  what is already there (see "AI house builder"). `MockAIProvider` also reads the context: it notes any
  existing object the instruction names by id.
- **`MockAIProvider`'s language understanding is still limited.** It
  only recognizes "create/add a `<type>`" style clauses via whole-word
  keyword matching (wall/pillar/beam/slab/door/window, plus every element
  kind's catalog keywords - "roof", "water pipe", "light switch",
  "sofa", ...; the earliest, then longest, mention in a clause wins) - no
  "update"/"delete"/"duplicate" instructions, no free-text dimension or
  position parsing. `OpenAIProvider` can, in principle, understand
  dimensions/colors/materials/rotation from free text (the model fills
  those into the structured response), but is likewise scoped to
  "`<type>.add`" commands only in this milestone - see its system
  prompt in `providers/OpenAIProvider.ts`.
- **No backend, so no real `OpenAIProvider` usage yet.** See "Security
  boundary" above - this is the actual blocker on end-to-end real-AI
  behavior right now, not anything about `OpenAIProvider`'s own code.
- **No Gemini or Claude provider yet.** Only `MockAIProvider` and
  `OpenAIProvider` exist. Adding another network-backed provider means
  writing another `AIProvider` implementation under `providers/` - no
  changes to `AICommandPipeline` or the `AIProvider` interface should be
  needed, since `OpenAIProvider` already proved the interface supports a
  real async, network-backed provider.
- **No visible AI chat UI.** There is no chat panel, text input, or
  ribbon button wired up to `AICommandPipeline` yet. This module is
  usable today only from code (e.g. a future UI, or the `verify.ts`
  files) - see the parent task's constraints.
- **Relationships through structured commands.** A provider can put a
  door or window into an existing wall (`door.add`/`window.add` with
  `hostId`, and optionally `offset`/`sill`) and connect two compatible
  pipe/conduit/cable endpoints (`element.connect`). The snapshot carries
  each hosted opening's `hostId` and each connected element's
  `connections`, and the geometry section reports `hosts` and
  `connections` with their validity (see `relationships/README.md`).
  `MockAIProvider` understands "Add a door to wall-3" and "Connect
  water-pipe-1 to water-pipe-2". The AI still doesn't snap, route, or
  resolve clashes, and the reference house plan's door and windows are
  free-standing (the plan can't reference wall ids created in the same
  response).
- **Elements.** `AI_SUPPORTED_OBJECT_TYPES` includes `element`: the
  snapshot lists every element with its `kind` and `label`, the backend
  sanitizer accepts only catalog kinds, and the structured-output schema
  offers `element.add` with the kind and material enums generated from
  the element catalog and the material library. The system prompt lists
  every kind with its axes and parameters. Nothing about an element is
  AI-only: it goes through the same `element.add` command, store
  validation, and history as the ribbon.
- **No assembly commands from AI yet.** `AI_SUPPORTED_OBJECT_TYPES`
  covers the construction object types only; `assembly.*` commands
  are intentionally not reachable through this pipeline in this
  milestone (nothing prevents it structurally - a future change could
  simply extend the supported-type list and add assembly-aware handling
  to a provider).
