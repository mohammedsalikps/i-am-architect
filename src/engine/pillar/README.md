# Pillar

The pillar object type: data model (`types.ts`), factory
(`createPillar.ts`), storage (`PillarStore.ts`), and validation
(`validatePillar.ts`). See `src/engine/objects/README.md` for the
shared foundation this builds on, and `src/engine/wall/README.md` for
the sibling object type this was built to mirror exactly.

## Validation ownership

`validatePillar.ts` is a pure function - `validatePillar(pillar:
PillarData): PillarValidationResult` - with no side effects and no
knowledge of `PillarStore`, `ObjectRegistry`, history, or UI.
`PillarStore` is the only caller: it validates before every write -
`add()`, `update()` (the final *merged* pillar, not just the incoming
partial changes), and `set()` - and rejects the write if validation
fails. `ObjectRegistry` and `PillarHistoryController` know nothing
about *what* makes a pillar valid; `PillarHistoryController` only
checks the pass/fail result to decide whether to record undo history.

## Constraints

| Field | Rule |
|---|---|
| `id` | Non-empty string |
| `type` | Must be exactly `"pillar"` |
| `position.x`, `.y`, `.z` | Finite numbers (no `NaN`/`Infinity`) |
| `rotation` | Finite number |
| `dimensions.width` | Finite number, `> 0` |
| `dimensions.depth` | Finite number, `> 0` |
| `dimensions.height` | Finite number, `> 0` |
| `color` | 6-digit hex string, e.g. `#a8a8a8` |
| `material` | Non-empty string |
| `assemblyId` | Non-empty string, or `null` |
| `id` (on `PillarStore.add()`) | Must not already exist in the store - checked by `PillarStore`, not `validatePillar` itself (see below) |

`material` and `assemblyId` are validated here even though
`validateWall.ts` doesn't validate them yet - there's still no real
material system or assembly-existence check behind either field, but
the milestone that introduced pillars asked for the extra defense at
this boundary. This is a deliberate, small divergence from wall's
validator, not an oversight.

## Duplicate-id rejection lives in the store, not the validator

`validatePillar()` only checks a single `PillarData` object's own
shape - it has no way to know what other pillars already exist. Like
`AssemblyStore.add()`, `PillarStore.add()` additionally checks
`registry.has(id)` and rejects a collision before ever calling
`registry.add()`. Wall ids never needed this because `createWallData()`'s
counter guarantees uniqueness and nothing else calls `WallStore.add()`
with a caller-supplied id - the same is true for pillars via
`createPillarData()`, but this store enforces it explicitly anyway.

## Behavior on invalid data

`PillarStore.add()`, `.update()`, and `.set()` return a
`PillarValidationResult` (`{ valid: boolean; errors: PillarValidationError[] }`)
instead of throwing. When `valid` is `false`:

- **Nothing is written.** The existing pillar (if any) is left exactly
  as it was; an `add()` that fails validation stores nothing at all.
- **Subscribers are not notified.** `PillarStore` never delegates to
  `ObjectRegistry` when validation fails, so no `emit()` happens.
- **No undo/redo history entry is created.** `PillarHistoryController`
  checks the returned result before calling `HistoryManager.record()` -
  a rejected write leaves the undo/redo stacks untouched.

`remove()` is unaffected by validation, same as `WallStore.remove()`.

## Grounding

Same rule as a wall: if `dimensions.height` changes without an
explicit `position` also being supplied, `PillarStore.update()`
recomputes `position.y` before validating so the pillar's base stays
where it was (see `objects/grounding.ts`). A pillar on the construction
plane stays on it (`y = height / 2`, as before); one standing on a slab
stays on the slab. An edit that leaves the height unchanged leaves
`position.y` alone.

## History

`src/engine/history/pillarHistory.ts` (`PillarHistoryController`)
mirrors `wallHistory.ts` (`WallHistoryController`) exactly, and shares
the *same* `HistoryManager` instance walls use (see `ProjectContext`) -
undo/redo for wall and pillar operations interleave into one global
undo stack, not two separate ones.
