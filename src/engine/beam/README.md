# Beam

The beam object type: data model (`types.ts`), factory
(`createBeam.ts`), storage (`BeamStore.ts`), and validation
(`validateBeam.ts`). See `src/engine/objects/README.md` for the shared
foundation this builds on, and `src/engine/wall/README.md` /
`src/engine/pillar/README.md` for the sibling object types this was
built to mirror exactly.

## Validation ownership

`validateBeam.ts` is a pure function - `validateBeam(beam: BeamData):
BeamValidationResult` - with no side effects and no knowledge of
`BeamStore`, `ObjectRegistry`, history, or UI. `BeamStore` is the only
caller: it validates before every write - `add()`, `update()` (the
final *merged* beam, not just the incoming partial changes), and
`set()` - and rejects the write if validation fails.

## Constraints

| Field | Rule |
|---|---|
| `id` | Non-empty string |
| `type` | Must be exactly `"beam"` |
| `position.x`, `.y`, `.z` | Finite numbers (no `NaN`/`Infinity`) |
| `rotation` | Finite number |
| `dimensions.length` | Finite number, `> 0` |
| `dimensions.width` | Finite number, `> 0` |
| `dimensions.height` | Finite number, `> 0` |
| `color` | 6-digit hex string, e.g. `#8a8a8a` |
| `material` | Non-empty string |
| `assemblyId` | Non-empty string, or `null` |
| `id` (on `BeamStore.add()`) | Must not already exist in the store - checked by `BeamStore`, not `validateBeam` itself (see below) |

## Duplicate-id rejection lives in the store, not the validator

`validateBeam()` only checks a single `BeamData` object's own shape -
it has no way to know what other beams already exist. Like
`PillarStore.add()`, `BeamStore.add()` additionally checks
`registry.has(id)` and rejects a collision before ever calling
`registry.add()`.

## Behavior on invalid data

`BeamStore.add()`, `.update()`, and `.set()` return a
`BeamValidationResult` (`{ valid: boolean; errors: BeamValidationError[] }`)
instead of throwing. When `valid` is `false`:

- **Nothing is written.** The existing beam (if any) is left exactly
  as it was; an `add()` that fails validation stores nothing at all.
- **Subscribers are not notified.** `BeamStore` never delegates to
  `ObjectRegistry` when validation fails, so no `emit()` happens.
- **No undo/redo history entry is created.** `BeamHistoryController`
  checks the returned result before calling `HistoryManager.record()` -
  a rejected write leaves the undo/redo stacks untouched.

`remove()` is unaffected by validation, same as `WallStore.remove()`/
`PillarStore.remove()`.

## Orientation

A beam's local axes are fixed, matching the task's explicit
requirement (no arbitrary 3D rotation, no quaternion editing):

- `dimensions.length` runs along the local X-axis.
- `dimensions.width` runs along the local Z-axis.
- `dimensions.height` runs along the local Y-axis.
- `rotation` is a single scalar (radians around the vertical Y-axis),
  exactly like a wall's or pillar's rotation.

## Grounding

Same rule as a wall or pillar: if `dimensions.height` changes without
an explicit `position` also being supplied, `BeamStore.update()`
recomputes `position.y` before validating so the beam's base stays
where it was (see `objects/grounding.ts`) - on the construction plane
(`y = height / 2`, as before) or wherever it was raised to. An edit
that leaves the height unchanged leaves `position.y` alone. Unlike a wall's Position
Y (read-only in the UI), a beam's Position Y stays editable - the same
choice pillar's property panel already made, so a beam can be raised
off the ground (e.g. modeling a floor beam) when that's actually
wanted.

## History

`src/engine/history/beamHistory.ts` (`BeamHistoryController`) mirrors
`wallHistory.ts`/`pillarHistory.ts` exactly, and shares the *same*
`HistoryManager` instance walls and pillars use (see `ProjectContext`) -
undo/redo for wall, pillar, and beam operations interleave into one
global undo stack, not three separate ones.
