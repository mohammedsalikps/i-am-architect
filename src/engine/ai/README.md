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
| `MockAIProvider.ts` | A deterministic, keyword-matching `AIProvider` - no network calls, no randomness. |
| `providers/OpenAIProvider.ts` | A real, OpenAI-backed `AIProvider` - structured JSON output, injected API key and HTTP transport. See "Security boundary". |
| `providers/verify.ts` | Node-runnable unit verification for `OpenAIProvider`, entirely against a mocked transport. |
| `AICommandPipeline.ts` | Orchestrates one instruction end-to-end: validate input → call provider → validate output → execute via `CommandExecutor`. |
| `verify.ts` | Node-runnable unit verification for `MockAIProvider`/`AICommandPipeline`/`buildAIProjectSnapshot()` (`npm run verify` includes this and `providers/verify.ts`). |

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
      │  3. reject malformed / unsupported entries, keep the rest
      ▼
CommandExecutor.execute(command)   ← the ONLY mutation path
      │  4. domain validation (e.g. invalid dimensions), history, stores
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
- **Multi-command responses, partial success.** `response.commands` may
  contain any number of commands; every one is attempted in order
  regardless of whether an earlier one failed, and each gets its own
  `AICommandOutcome`. `AIPipelineResult.success` is `true` only when
  every command succeeded - a caller can still inspect `outcomes`/`errors`
  to see exactly which ones did.
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
- **Shared undo/redo, unchanged.** Every command the pipeline executes
  goes through `CommandExecutor` exactly like a UI-issued command, so it
  is recorded on the same shared `HistoryManager` (see
  `src/engine/project/ProjectContext.ts`) - undo/redo works identically
  whether a command came from a button click or an AI instruction, with
  no AI-specific history code anywhere.

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
an empty instruction, command-level failure propagation (one bad
command in a batch doesn't block the others), undo/redo compatibility
(a pipeline-issued command undoes/redoes exactly like a directly-issued
one), and a structural check that an `AICommandPipeline` instance holds
no store reference at all - only a provider and a `CommandExecutorLike`.

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
  as a UI edit, and an unknown id is an error - never a new object. The
  model can't place objects relative to one another, align or connect
  them, delete or duplicate them, or plan geometry; those need a later
  geometry milestone. `MockAIProvider` understands four edit phrasings:
  "Make wall-1 5 meters long", "Change wall-1 height to 3.2 meters",
  "Rotate wall-1 by 90 degrees" (or "to"), and "Move wall-1 to X=2".
- **What the model sees.** `OpenAIProvider` sends the full snapshot - every
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
  request. The command schema is unchanged, though: the model can still
  only produce `<type>.add` commands, which carry no position. So it can
  read an existing object's dimensions (e.g. "as tall as wall-7"), but
  it cannot place a new object relative to one, edit one, or plan
  geometry. `MockAIProvider` also reads the context: it notes any
  existing object the instruction names by id.
- **`MockAIProvider`'s language understanding is still limited.** It
  only recognizes "create/add a `<type>`" style clauses via whole-word
  keyword matching (wall/pillar/beam/slab/door/window) - no
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
- **No snapping, wall-hosting, or opening behavior.** Commands produced
  here create/update construction objects exactly as
  `CommandExecutor` already allows - independent objects with no spatial
  relationship inference. Unchanged from the door/window milestone.
- **No assembly commands from AI yet.** `AI_SUPPORTED_OBJECT_TYPES`
  covers the six construction object types only; `assembly.*` commands
  are intentionally not reachable through this pipeline in this
  milestone (nothing prevents it structurally - a future change could
  simply extend the supported-type list and add assembly-aware handling
  to a provider).
