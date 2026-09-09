# Slab

The slab object type: data model (`types.ts`), factory
(`createSlab.ts`), storage (`SlabStore.ts`), and validation
(`validateSlab.ts`). See `src/engine/objects/README.md` for the shared
foundation this builds on, and `src/engine/wall/README.md` /
`src/engine/pillar/README.md` / `src/engine/beam/README.md` for the
sibling object types this was built to mirror exactly.

## Validation ownership

`validateSlab.ts` is a pure function - `validateSlab(slab: SlabData):
SlabValidationResult` - with no side effects and no knowledge of
`SlabStore`, `ObjectRegistry`, history, or UI. `SlabStore` is the only
caller: it validates before every write - `add()`, `update()` (the
final *merged* slab, not just the incoming partial changes), and
`set()` - and rejects the write if validation fails.

## Constraints

| Field | Rule |
|---|---|
| `id` | Non-empty string |
| `type` | Must be exactly `"slab"` |
| `position.x`, `.y`, `.z` | Finite numbers (no `NaN`/`Infinity`) |
| `rotation` | Finite number |
| `dimensions.length` | Finite number, `> 0` |
| `dimensions.width` | Finite number, `> 0` |
| `dimensions.thickness` | Finite number, `> 0` |
| `color` | 6-digit hex string, e.g. `#b0b0b0` |
| `material` | Non-empty string |
| `assemblyId` | Non-empty string, or `null` |
| `id` (on `SlabStore.add()`) | Must not already exist in the store - checked by `SlabStore`, not `validateSlab` itself (see below) |

## Duplicate-id rejection lives in the store, not the validator

`validateSlab()` only checks a single `SlabData` object's own shape -
it has no way to know what other slabs already exist. Like
`PillarStore.add()`/`BeamStore.add()`, `SlabStore.add()` additionally
checks `registry.has(id)` and rejects a collision before ever calling
`registry.add()`.

## Behavior on invalid data

`SlabStore.add()`, `.update()`, and `.set()` return a
`SlabValidationResult` (`{ valid: boolean; errors: SlabValidationError[] }`)
instead of throwing. When `valid` is `false`:

- **Nothing is written.** The existing slab (if any) is left exactly
  as it was; an `add()` that fails validation stores nothing at all.
- **Subscribers are not notified.** `SlabStore` never delegates to
  `ObjectRegistry` when validation fails, so no `emit()` happens.
- **No undo/redo history entry is created.** `SlabHistoryController`
  checks the returned result before calling `HistoryManager.record()` -
  a rejected write leaves the undo/redo stacks untouched.

`remove()` is unaffected by validation, same as the sibling stores'
`remove()` methods.

## Orientation

A slab's local axes are fixed, matching the same "no arbitrary 3D
rotation" rule the other object types follow:

- `dimensions.length` runs along the local X-axis.
- `dimensions.width` runs along the local Z-axis.
- `dimensions.thickness` runs along the local Y-axis (a slab is a flat
  horizontal element, so its "up" dimension is thin, unlike a pillar's
  or beam's height).
- `rotation` is a single scalar (radians around the vertical Y-axis).

## Grounding

Same rule as the sibling object types, but keyed on `thickness` rather
than `height` (a slab has no `height` field - its vertical extent
*is* its thickness): if `dimensions.thickness` changes without an
explicit `position` also being supplied, `SlabStore.update()`
recomputes `position.y = thickness / 2` before validating, keeping the
slab's top resting flush with the construction plane at y=0 by
default. Position Y stays editable in the UI (same choice pillar's and
beam's panels made), so a slab can be raised to model an upper floor
when that's actually wanted.

## History

`src/engine/history/slabHistory.ts` (`SlabHistoryController`) mirrors
`wallHistory.ts`/`pillarHistory.ts`/`beamHistory.ts` exactly, and
shares the *same* `HistoryManager` instance every other object type
uses (see `ProjectContext`) - undo/redo for wall, pillar, beam, and
slab operations interleave into one global undo stack, not four
separate ones.
