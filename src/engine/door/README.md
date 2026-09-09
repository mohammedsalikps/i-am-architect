# Door

The door object type: data model (`types.ts`), factory
(`createDoor.ts`), storage (`DoorStore.ts`), and validation
(`validateDoor.ts`). See `src/engine/objects/README.md` for the shared
foundation this builds on, and `src/engine/wall/README.md` /
`src/engine/pillar/README.md` / `src/engine/beam/README.md` /
`src/engine/slab/README.md` for the sibling object types this was
built to mirror exactly.

## Validation ownership

`validateDoor.ts` is a pure function - `validateDoor(door: DoorData):
DoorValidationResult` - with no side effects and no knowledge of
`DoorStore`, `ObjectRegistry`, history, or UI. `DoorStore` is the only
caller: it validates before every write - `add()`, `update()` (the
final *merged* door, not just the incoming partial changes), and
`set()` - and rejects the write if validation fails.

## Constraints

| Field | Rule |
|---|---|
| `id` | Non-empty string |
| `type` | Must be exactly `"door"` |
| `position.x`, `.y`, `.z` | Finite numbers (no `NaN`/`Infinity`) |
| `rotation` | Finite number |
| `dimensions.width` | Finite number, `> 0` |
| `dimensions.height` | Finite number, `> 0` |
| `dimensions.thickness` | Finite number, `> 0` |
| `color` | 6-digit hex string, e.g. `#6b4423` |
| `material` | Non-empty string |
| `assemblyId` | Non-empty string, or `null` |
| `id` (on `DoorStore.add()`) | Must not already exist in the store - checked by `DoorStore`, not `validateDoor` itself (see below) |

## Duplicate-id rejection lives in the store, not the validator

`validateDoor()` only checks a single `DoorData` object's own shape -
it has no way to know what other doors already exist. Like the
sibling stores' `add()` methods, `DoorStore.add()` additionally checks
`registry.has(id)` and rejects a collision before ever calling
`registry.add()`.

## Behavior on invalid data

`DoorStore.add()`, `.update()`, and `.set()` return a
`DoorValidationResult` (`{ valid: boolean; errors: DoorValidationError[] }`)
instead of throwing. When `valid` is `false`:

- **Nothing is written.** The existing door (if any) is left exactly
  as it was; an `add()` that fails validation stores nothing at all.
- **Subscribers are not notified.** `DoorStore` never delegates to
  `ObjectRegistry` when validation fails, so no `emit()` happens.
- **No undo/redo history entry is created.** `DoorHistoryController`
  checks the returned result before calling `HistoryManager.record()` -
  a rejected write leaves the undo/redo stacks untouched.

`remove()` is unaffected by validation, same as the sibling stores'
`remove()` methods.

## Orientation

A door's local axes are fixed, matching the same "no arbitrary 3D
rotation" rule the other object types follow:

- `dimensions.width` runs along the local X-axis.
- `dimensions.height` runs along the local Y-axis.
- `dimensions.thickness` runs along the local Z-axis.
- `rotation` is a single scalar (radians around the vertical Y-axis).

## Grounding

Same rule as a wall/pillar/beam: if `dimensions.height` changes
without an explicit `position` also being supplied, `DoorStore.update()`
recomputes `position.y = height / 2` before validating, keeping the
door's base resting on the construction plane. Position Y stays
editable in the UI (same choice every sibling type's panel made).

## History

`src/engine/history/doorHistory.ts` (`DoorHistoryController`) mirrors
`wallHistory.ts`/`pillarHistory.ts`/`beamHistory.ts`/`slabHistory.ts`
exactly, and shares the *same* `HistoryManager` instance every other
object type uses (see `ProjectContext`) - undo/redo for every object
type interleaves into one global undo stack.

## Not yet implemented

A door today is an independent, freestanding construction object - it
is not hosted by a wall, does not cut an opening into one, and has no
swing/hinge behavior. That integration is deliberately out of scope
for this milestone (see the parent task's constraints) and would be a
later addition on top of this same data model.
