# Window

The window object type: data model (`types.ts`), factory
(`createWindow.ts`), storage (`WindowStore.ts`), and validation
(`validateWindow.ts`). See `src/engine/objects/README.md` for the
shared foundation this builds on, and `src/engine/door/README.md` for
the sibling object type this was built to mirror exactly (doors and
windows share an identical dimensions shape and grounding rule; only
the defaults, color, and semantic meaning differ).

## Validation ownership

`validateWindow.ts` is a pure function - `validateWindow(windowData:
WindowData): WindowValidationResult` - with no side effects and no
knowledge of `WindowStore`, `ObjectRegistry`, history, or UI.
`WindowStore` is the only caller: it validates before every write -
`add()`, `update()` (the final *merged* window, not just the incoming
partial changes), and `set()` - and rejects the write if validation
fails.

## Constraints

| Field | Rule |
|---|---|
| `id` | Non-empty string |
| `type` | Must be exactly `"window"` |
| `position.x`, `.y`, `.z` | Finite numbers (no `NaN`/`Infinity`) |
| `rotation` | Finite number |
| `dimensions.width` | Finite number, `> 0` |
| `dimensions.height` | Finite number, `> 0` |
| `dimensions.thickness` | Finite number, `> 0` |
| `color` | 6-digit hex string, e.g. `#7ec8e3` |
| `material` | Non-empty string |
| `assemblyId` | Non-empty string, or `null` |
| `id` (on `WindowStore.add()`) | Must not already exist in the store - checked by `WindowStore`, not `validateWindow` itself (see below) |

## Duplicate-id rejection lives in the store, not the validator

`validateWindow()` only checks a single `WindowData` object's own
shape - it has no way to know what other windows already exist. Like
the sibling stores' `add()` methods, `WindowStore.add()` additionally
checks `registry.has(id)` and rejects a collision before ever calling
`registry.add()`.

## Behavior on invalid data

`WindowStore.add()`, `.update()`, and `.set()` return a
`WindowValidationResult` (`{ valid: boolean; errors: WindowValidationError[] }`)
instead of throwing. When `valid` is `false`:

- **Nothing is written.** The existing window (if any) is left exactly
  as it was; an `add()` that fails validation stores nothing at all.
- **Subscribers are not notified.** `WindowStore` never delegates to
  `ObjectRegistry` when validation fails, so no `emit()` happens.
- **No undo/redo history entry is created.** `WindowHistoryController`
  checks the returned result before calling `HistoryManager.record()` -
  a rejected write leaves the undo/redo stacks untouched.

`remove()` is unaffected by validation, same as the sibling stores'
`remove()` methods.

## Orientation

A window's local axes are fixed, matching the same "no arbitrary 3D
rotation" rule every other object type follows:

- `dimensions.width` runs along the local X-axis.
- `dimensions.height` runs along the local Y-axis.
- `dimensions.thickness` runs along the local Z-axis.
- `rotation` is a single scalar (radians around the vertical Y-axis).

## Grounding

Same rule as every sibling type: if `dimensions.height` changes
without an explicit `position` also being supplied,
`WindowStore.update()` recomputes `position.y = height / 2` before
validating, keeping the window's base resting on the construction
plane. Position Y stays editable in the UI (same choice every sibling
type's panel made) - a window would realistically sit higher off the
ground than its default, so this matters more for window than for most
siblings.

## History

`src/engine/history/windowHistory.ts` (`WindowHistoryController`)
mirrors `doorHistory.ts` and every other sibling `*HistoryController`
exactly, and shares the *same* `HistoryManager` instance every other
object type uses (see `ProjectContext`) - undo/redo for every object
type interleaves into one global undo stack.

## Not yet implemented

A window today is an independent, freestanding construction object -
it is not hosted by a wall, does not cut an opening into one, and has
no glazing/frame subdivision. That integration is deliberately out of
scope for this milestone (see the parent task's constraints) and would
be a later addition on top of this same data model.
