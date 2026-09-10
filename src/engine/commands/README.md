# Construction Commands

A `Command` is structured data describing one construction-object
operation - `{ type: "wall.add", wall: {...} }` - not a function, not a
string of code to `eval`, not arbitrary executable logic. `CommandExecutor`
is the single place that turns a `Command` into real `WallStore` /
`WallHistoryController` calls.

## Why this layer exists

Every wall mutation in the app already goes through `WallHistoryController`
(so it's undoable), which goes through `WallStore` (so it's validated).
Both are meant to be called from trusted, already-typed call sites -
`rightSidebar.ts` and `header.ts` via `main.ts`. `CommandExecutor` is
the boundary for callers that *aren't* a trusted, already-typed call
site: a future feature that turns an AI prompt into one or more
commands, a macro/scripting feature, or any other producer of
structured-but-not-compile-time-guaranteed data.

**The executor does not parse natural language.** Turning "add a 5
meter wall" into `{ type: "wall.add", wall: { length: 5 } }` is a
future feature's job (a prompt parser, an LLM call, whatever it turns
out to be) - `CommandExecutor` only accepts commands that are already
structured objects. `execute()` takes `unknown` (not the `Command`
type) precisely because it's meant to receive data from a caller that
hasn't necessarily produced well-typed TypeScript, and validates the
shape itself before doing anything.

## What CommandExecutor does and doesn't own

- **Command shape validation** (does this look like a command at all;
  does it name a known `type`; does it carry the id a mutation needs)
  is the executor's own job.
- **Wall field validation** (is `length` a positive finite number, is
  `color` a valid hex string, ...) is *not* the executor's job - it
  stays entirely inside `validateWall.ts`, reached through `WallStore`.
  The executor only relays the `WallValidationResult` it gets back as
  part of the `CommandResult`.
- **Undo/redo** is not the executor's job either - `wall.add`,
  `wall.update`, and `wall.delete` commands route through
  `WallHistoryController` (injected via the constructor as a
  `WallHistoryLike` structural interface, not the concrete class - see
  `types.ts`) so a successful command is undoable exactly like a
  UI-driven edit is. A rejected command creates no history entry,
  matching how `WallHistoryController` already behaves for a rejected
  direct call.
- **Selection** is deliberately not touched by the executor at all -
  it isn't given a `SelectionStore`. Which object ends up highlighted
  in the UI after a command runs is a UI-layer concern, not a command
  layer one.

## Supported commands (today)

| `type` | Fields | Behavior |
|---|---|---|
| `wall.add` | `wall: CreateWallOptions` (same optional fields `createWallData()` takes) | Creates a wall, routes through `WallHistoryController.add()` |
| `wall.update` | `id`, `changes` (same shape `WallStore.update()` takes) | Routes through `WallHistoryController.update()` |
| `wall.delete` | `id` | Routes through `WallHistoryController.remove()` |
| `wall.duplicate` | `id` | Builds a copy via `duplicateWallData()`, routes through `WallHistoryController.add()` |
| `update_object` | `objectId`, `changes` - all partial: `dimensions` the object already has, `position` (any of x/y/z), `rotation` (radians, or `{ y }`), `material`, `color` | Edits any type by id. Resolves the type with `resolveConstructionObject()`, merges the change over the object's current values, then runs that type's own `<type>.update` - so validation, the grounding rule, and the single history entry match a UI edit. Rejects an unknown id and any property the model doesn't have; never creates an object. |

Every `execute()` call returns a `CommandResult` -
`{ success, objectId?, errors?, message? }` - instead of throwing, the
same "structured result, not an exception" approach `validateWall`
already uses for normal invalid input.

## Extending this for a future object type

Add that type's command interfaces to `types.ts` (namespaced, e.g.
`"pillar.add"`), join them into the `Command` union, and add one case
to `CommandExecutor`'s switch. No existing command shape or case needs
to change.
