# Mouse manipulation

Move, resize, and rotate the selected construction object with the mouse.
The construction engine stays the single source of truth: a gesture only
ever changes the model through `CommandExecutor`, and everything you see
- the mesh, its outline, the handles, the Properties panel - redraws from
the stores.

```
pointer on the canvas
  → ManipulationController       (src/scene/manipulation/) raycast handles / selected body, project onto a drag plane
  → ObjectManipulator            (this folder) gesture → changes, via manipulationMath.ts
  → CommandExecutor.execute({ type: "update_object", objectId, changes })
  → <type>.update → <Type>Store validation → <Type>HistoryController → HistoryManager (grouped)
  → store notifies → <Type>Layer mesh + outline, ManipulationHandles, Properties panel
```

| File | Responsibility |
|---|---|
| `manipulationMath.ts` | Pure functions: `computeMove`, `computeResize`, `computeRotation`, `snapToStep`, `layoutHandles`. No Three.js, DOM, stores, or commands. |
| `ObjectManipulator.ts` | One gesture at a time: `begin` → `update` (one `update_object` per real change) → `end`/`cancel`, inside one history group. `createStoreObjectReader()` reads any object by id. |
| `verify.ts` | Node unit suite: the math, history groups, and the manipulator on real stores. The fully real path (`createProjectContext()`) is in `src/engine/ai/e2e/verify.ts`. |
| `src/scene/manipulation/ManipulationHandles.ts` | Draws the handles from store state, like a layer. |
| `src/scene/manipulation/ManipulationController.ts` | Pointer events, raycasting, drag planes, cursors. Never writes a store or a mesh. |

## Gestures

- **Move:** drag the selected object's body. It moves on the horizontal
  X/Z plane through the point you grabbed. Y never changes, so the object
  keeps its height.
- **Resize:** drag a blue diamond. There is one just outside each face
  along the object's local X and Z, and one on top. The side diamonds sit
  on the object's base plane (its footprint), so the faces stay free for
  grabbing the body. The rotation ring sits outside them. Handles are
  depth-tested, and the controller picks whatever is nearest along the
  pointer ray, so a handle hidden behind the object can't be grabbed
  through it. The **opposite face
  stays fixed**: the dimension changes by the pointer's travel along that
  axis, and the center moves by half of it. The change is sent with an
  explicit position, so the store's "re-ground on a height change" rule
  doesn't pull a raised window down. The top handle keeps the bottom fixed.
- **Rotate:** drag the ring around the object's base. The rotation changes
  by the angle swept around the object's center, taken the short way
  round. It is the same single Y rotation the stores already have.

Each handle drives a dimension the object really has. The mapping is the
one verified against the mesh builders (`LOCAL_AXIS_DIMENSIONS` in
`src/engine/ai/geometry/`):

| Type | Side handles (local X) | Side handles (local Z) | Top handle |
|---|---|---|---|
| wall | length | thickness | height |
| pillar | width | depth | height |
| beam | length | width | height |
| slab | length | width | thickness |
| door, window | width | thickness | height |

## Snapping

Changes come in whole increments, **measured from where the gesture
started**:

- moves and resizes: 0.1 m (`MOVE_STEP`, `RESIZE_STEP`)
- rotations: 1° (`ROTATE_STEP`)

Grabbing therefore never makes an object jump, and an off-grid value
keeps its precision. Values are rounded to 9 decimal places, so no float
noise like `0.30000000000000004` reaches the store. There is no grid
alignment, object-to-object snapping, or inference.

## History

`begin()` opens a `HistoryManager` group. Each `update()` that changes
something executes one command inside it, and `end()` closes it as **one**
undo entry: undo returns straight to the state before the drag, and redo
returns straight to the result. A press that never moves far enough to
change anything records nothing. `cancel()` - Escape, or a cancelled
pointer - rolls the group back and records nothing.

## Validation

Every change goes through the store's own validator, via `update_object`.
Nothing clamps a value, and nothing bypasses validation. A drag that
would make a dimension zero or negative is rejected: the object stays at
its last valid size, and later valid pointer positions still apply.

## Camera controls

The controller catches a press on the viewport container in the capture
phase, and only when it starts a gesture: the press must land on a handle
or on the selected object's body. It stops that press, so neither
OrbitControls nor click-to-select sees it. Every other press - empty
space, another object, the right button, the wheel - behaves exactly as
before.

## Limitations

- **Orbiting:** dragging the selected object now moves it. To orbit, drag
  from empty space or another object.
- **Top handle in the Top view:** it does nothing in a straight-down view,
  because a vertical drag plane has no usable projection there.
- **Handle size:** handles have a fixed size in meters, so they get small
  when zoomed far out.
- **Rotation:** a single rotate gesture covers at most ±180°.
- **One object at a time:** there is no multi-select.
- **Moves are horizontal only.**
- **Door and window side handles (local Z):** these resize thickness, the
  dimension along that axis. There is no separate sill or offset
  property, so none is invented.
- **Undo cost:** undoing a drag replays each step it took. That is cheap
  at 0.1 m increments, but proportional to the drag.
