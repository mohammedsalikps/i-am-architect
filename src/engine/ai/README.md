# AI command pipeline

A provider-independent layer that turns a natural-language construction
instruction into validated, structured construction commands, executed
through the existing `CommandExecutor` (see `src/engine/commands/`).
This module does **not** connect to OpenAI, Gemini, Claude, or any other
network API - see "Limitations" below. No API keys, environment
secrets, network requests, or backend code exist anywhere in this
module.

## Files

| File | Responsibility |
|---|---|
| `types.ts` | Shared request/response/result types, `AI_SUPPORTED_OBJECT_TYPES`, and `buildAIProjectSnapshot()`. |
| `AIProvider.ts` | The `AIProvider` interface every provider (mock or real) implements. |
| `MockAIProvider.ts` | A deterministic, keyword-matching `AIProvider` - no network calls, no randomness. |
| `AICommandPipeline.ts` | Orchestrates one instruction end-to-end: validate input → call provider → validate output → execute via `CommandExecutor`. |
| `verify.ts` | Node-runnable unit verification (`npm run verify` includes this). |

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
  (`interpret(request): AIProviderResponse`). `AICommandPipeline` only
  ever depends on that interface, never on `MockAIProvider` or any
  specific implementation - swapping in a real OpenAI/Gemini/Claude-backed
  provider later means writing a new class that implements `AIProvider`,
  with zero changes to `AICommandPipeline`, `CommandExecutor`, or any
  store.
- **No direct store or scene access.** Neither `AIProvider` nor
  `AICommandPipeline` imports `WallStore`/`PillarStore`/.../`SceneManager`/
  any Three.js type. A provider only ever sees a read-only
  `AIProjectSnapshot` (plain counts + the selected id, built by
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
- **Synchronous by design, for now.** `AIProvider.interpret()` returns
  `AIProviderResponse` directly, not a `Promise`. `MockAIProvider` has no
  need for async, and introducing it before a real network-backed
  provider exists to justify it would only complicate every test. See
  "Limitations".
- **Shared undo/redo, unchanged.** Every command the pipeline executes
  goes through `CommandExecutor` exactly like a UI-issued command, so it
  is recorded on the same shared `HistoryManager` (see
  `src/engine/project/ProjectContext.ts`) - undo/redo works identically
  whether a command came from a button click or an AI instruction, with
  no AI-specific history code anywhere.

## Verification approach

`verify.ts` follows the same "no test framework, plain assertion
helpers, run directly by Node" convention as every other `verify.ts` in
this project. It does not instantiate `CommandExecutor` against real
`*HistoryController` classes (those use TypeScript parameter-property
constructors, which Node's native TypeScript support can't run - see
`src/engine/commands/verify.ts`'s own header comment for the full
explanation); instead it uses the same store-backed `*HistoryLike` stub
pattern already established there. It covers: `MockAIProvider` output
for every example instruction, single- and multi-command execution,
malformed/non-array provider output, unsupported object types,
unsupported command types, an empty instruction, command-level failure
propagation (one bad command in a batch doesn't block the others),
undo/redo compatibility (a pipeline-issued command undoes/redoes
exactly like a directly-issued one), and a structural check that an
`AICommandPipeline` instance holds no store reference at all - only a
provider and a `CommandExecutorLike`.

## Limitations

- **No real provider.** `MockAIProvider` only recognizes "create/add a
  `<type>`" style clauses via whole-word keyword matching
  (wall/pillar/beam/slab/door/window). It has no concept of
  "update"/"delete"/"duplicate" instructions, no free-text dimension or
  position parsing, and no actual language understanding. Wiring up a
  real OpenAI/Gemini/Claude-backed provider - including API keys,
  network requests, and any backend code that would require - is
  explicitly out of scope for this milestone.
  Making `AIProvider.interpret()` asynchronous is the main change a
  real provider would need; every other piece of this module (types,
  `AICommandPipeline`, its validation) was written to make that a
  contained, one-interface change when it happens.
- **No visible AI chat UI.** There is no chat panel, text input, or
  ribbon button wired up to `AICommandPipeline` yet. This module is
  usable today only from code (e.g. a future UI, or `verify.ts`) - see
  the parent task's constraints.
- **No snapping, wall-hosting, or opening behavior.** Commands produced
  here create/update construction objects exactly as
  `CommandExecutor` already allows - independent objects with no spatial
  relationship inference. Unchanged from the door/window milestone.
- **No assembly commands from AI yet.** `AI_SUPPORTED_OBJECT_TYPES`
  covers the six construction object types only; `assembly.*` commands
  are intentionally not reachable through this pipeline in this
  milestone (nothing prevents it structurally - a future change could
  simply extend the supported-type list and add assembly-aware keyword
  matching to a real provider).
