# Wall

The wall object type: data model (`types.ts`), factory (`createWall.ts`),
storage (`WallStore.ts`), and validation (`validateWall.ts`). See
`src/engine/objects/README.md` for the shared foundation this builds on.

## Validation ownership

`validateWall.ts` is a pure function - `validateWall(wall: WallData):
WallValidationResult` - with no side effects and no knowledge of
`WallStore`, `ObjectRegistry`, history, or UI. `WallStore` is the only
caller: it validates before every write - `add()`, `update()` (the
final *merged* wall, not just the incoming partial changes), and
`set()` - and rejects the write if validation fails. `ObjectRegistry`
and `WallHistoryController` know nothing about *what* makes a wall
valid; `WallHistoryController` only checks the pass/fail result to
decide whether to record undo history. This is wall-specific logic
living entirely in this folder, consistent with the "generic registry,
type-specific rules in the type's own store" pattern described in
`objects/README.md`.

## Constraints

| Field | Rule |
|---|---|
| `id` | Non-empty string |
| `type` | Must be exactly `"wall"` |
| `position.x`, `.y`, `.z` | Finite numbers (no `NaN`/`Infinity`) |
| `rotation` | Finite number |
| `dimensions.length` | Finite number, `> 0` |
| `dimensions.height` | Finite number, `> 0` |
| `dimensions.thickness` | Finite number, `> 0` |
| `color` | 6-digit hex string, e.g. `#c9c9c9` (matches what the color-picker UI and `createWallData`'s defaults produce) |

`material` and `assemblyId` are not validated yet - there is no
material system or assembly system to validate them against.

## Behavior on invalid data

`WallStore.add()`, `.update()`, and `.set()` return a
`WallValidationResult` (`{ valid: boolean; errors: WallValidationError[] }`)
instead of throwing - typing `0` into the Thickness field is normal
user input, not an exceptional program state. When `valid` is `false`:

- **Nothing is written.** The existing wall (if any) is left exactly as
  it was; an `add()` that fails validation stores nothing at all.
- **Subscribers are not notified.** `WallStore` never delegates to
  `ObjectRegistry` when validation fails, so no `emit()` happens.
- **No undo/redo history entry is created.** `WallHistoryController`
  checks the returned result before calling `HistoryManager.record()` -
  a rejected write leaves the undo/redo stacks untouched.

`remove()` is unaffected by validation - a wall can always be removed
regardless of its current data (in practice it can't become invalid in
the first place, since every write is validated, but removal doesn't
depend on that guarantee either way).

Today, nothing in the UI can actually submit invalid data - the
Properties panel's numeric inputs already reject non-finite values and
enforce their own positive-dimension minimums client-side, and the
native color picker can't produce anything but a valid 6-digit hex
value. `validateWall` is a second, independent layer of defense at the
engine boundary: it protects any future caller of `WallStore` that
doesn't go through this UI (a different UI, an AI-driven creation
path, a script) exactly the same way.
