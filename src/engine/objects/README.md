# Shared Construction Object Foundation

Every buildable thing in the workspace - walls today, and later pillars,
beams, slabs, doors, windows, roofing, furniture, and landscaping - is
modeled as a `ConstructionObjectBase<TType, TDimensions>` (see `types.ts`):

```ts
interface ConstructionObjectBase<TType, TDimensions> {
  id: ObjectId;
  type: TType;               // the ObjectType discriminator, e.g. "wall"
  position: Vector3Data;     // center of the object, in meters
  rotation: number;          // radians around the vertical (Y) axis
  dimensions: TDimensions;   // type-specific size fields
  material: string;
  color: string;
  assemblyId: string | null; // reserved for future assembly grouping
}
```

`dimensions` is intentionally open - a wall's `{length, height, thickness}`
has nothing in common with a future door's `{width, height, thickness}`
or a pillar's `{radius, height}`. Each object type defines its own
dimensions shape and instantiates the generic, e.g.:

```ts
// src/engine/wall/types.ts
export interface WallDimensions { length: number; height: number; thickness: number; }
export type WallData = ConstructionObjectBase<"wall", WallDimensions>;
```

## Generic registry (`ObjectRegistry`)

`ObjectRegistry<T extends ConstructionObjectBase>` (`ObjectRegistry.ts`)
is a generic, object-type-agnostic store: `add/update/set/remove/get/
getAll/has/subscribe`. `WallStore` now composes `ObjectRegistry<WallData>`
internally (see below) - it's live in the running app. The *next* object
type (pillar, beam, slab, ...) doesn't need to hand-copy `WallStore`'s
old plumbing - it can follow the same "compose ObjectRegistry, add only
your own rules" pattern `WallStore` now demonstrates.

**Generic type design.** The registry is generic over `T extends
ConstructionObjectBase` rather than tied to any concrete type, so the
same class works for `WallData`, a future `PillarData`, etc. It knows
nothing beyond the shared envelope (`id`, `type`, `position`, `rotation`,
`dimensions`, `material`, `color`, `assemblyId`) - it has no
type-specific business rules.

**Immutability at the boundary.** Objects are deep-cloned going in
(`add`/`update`/`set`) and coming out (`get`/`getAll`), and the internal
`Map` is never exposed. Mutating a returned object, or mutating the
object you passed to `add()` afterward, never affects what's stored.
This matters more here than it did for `WallStore`, precisely because
the registry will eventually be shared machinery for every object type
- a caller-side mutation bug in one object type's UI code should not be
able to corrupt another type's store.

**Why `WallStore` still exists (it's a facade, not a duplicate).**
`WallStore` composes a private `ObjectRegistry<WallData>` and delegates
`add/set/remove/get/getAll/subscribe` straight through - one line each.
The only real logic left in `WallStore` is in `update()`: when
`dimensions.height` changes without an explicit `position`, it reads the
existing wall (`registry.get(id)`), computes the grounded `position.y`,
and folds that into the changes it hands to `registry.update()`. A
generic registry can't encode that rule (it doesn't know a wall has a
"height" or that height means anything about grounding) without ceasing
to be generic - so it stays in `WallStore`, expressed as "pre-process
the changes, then delegate" rather than as registry-side logic.

Because `WallStore`'s public API (method names, signatures, and
behavior) didn't change, nothing that only talks to `WallStore` through
that API needed to change either: `WallHistoryController`, `WallLayer`,
`SceneManager`, and `rightSidebar.ts` are all unmodified by this
migration.

**Pattern for future object-type stores.** A future `PillarStore`,
`BeamStore`, `SlabStore`, etc. should follow the same shape `WallStore`
now demonstrates: compose `ObjectRegistry<TheirDataType>` internally,
delegate the CRUD methods straight through, and add only whatever
type-specific derived-field rule that object actually needs on top (or
skip the wrapper store entirely and use `ObjectRegistry` directly, if it
needs no such rule).

## Adding a new object type later

Most new construction objects don't need a new type at all: an element
kind is one entry in `elements/catalog.ts`, and the element system's
single store, commands, history, scene layer, Properties panel,
persistence, and AI support cover it (see `elements/README.md`). The
steps below are for a genuinely new *type* with its own store.

1. Add the type name to the `ObjectType` union in `types.ts`, if it
   isn't already listed (most are pre-listed as reserved extension
   points, so this step is usually already done).
2. Create `src/engine/<type>/types.ts` defining `<Type>Dimensions` and
   `<Type>Data = ConstructionObjectBase<"<type>", <Type>Dimensions>`.
3. Create `src/engine/<type>/create<Type>.ts` (a factory, following
   `wall/createWall.ts`), `src/engine/<type>/validate<Type>.ts` (a pure
   function following `wall/validateWall.ts`, if the type has real
   constraints to enforce), and a `<Type>Store` that composes
   `ObjectRegistry<<Type>Data>` internally, the same way `WallStore`
   composes `ObjectRegistry<WallData>` (see "Generic registry" above) -
   validating before every write and rejecting invalid ones, the same
   way `WallStore` does. Add only the type-specific rules your object
   actually needs on top; use `ObjectRegistry` directly if it needs
   none. Then wire the store into
   `src/engine/history/<type>History.ts` the same way `wallHistory.ts`
   wires `WallStore` into `HistoryManager`.
4. Create `src/scene/<type>/` with a mesh-builder module and a
   `<Type>Layer` (copy `WallLayer`'s or `PillarLayer`'s shape - a
   `getMeshes()` method, mesh sync/dispose, selection-outline sync; no
   click handling) that `SceneManager` composes alongside the others,
   registering `newLayer.getMeshes` with the shared `SelectionRaycaster`.
5. Extend the right sidebar / construction ribbon UI to read and write
   through the new store, the same way `rightSidebar.ts` and
   `constructionRibbon.ts` do for walls and pillars.

No existing file needs to change to support a new object type beyond
the `ObjectType` union (already anticipates every type this app plans
to support), `SceneManager` composing one more `<Type>Layer`, and
registering that layer's meshes with the shared `SelectionRaycaster`
(see the row below) - both pillar's `PillarLayer` and wall's
`WallLayer` were adjusted the moment a second selectable type appeared;
a third type follows the same two-line registration, no further
changes.

## Layer ownership

| Concern | Owner | Knows about Three.js? |
|---|---|---|
| Generic CRUD + subscribe storage, reusable across all object types | `ObjectRegistry<T>` (generic) | No |
| Object data + type-specific derived-field rules (e.g. a wall's or pillar's base stays grounded) | `<Type>Store` (e.g. `WallStore`, `PillarStore`), composing `ObjectRegistry<T>` internally | No |
| Field-level validation (e.g. a wall's dimensions must be positive finite numbers) | `validate<Type>.ts` (e.g. `validateWall.ts`), called by `<Type>Store` before every write | No |
| Undo/redo | `HistoryManager` (generic) + `<type>History.ts` (e.g. `wallHistory.ts`, `pillarHistory.ts`) - all types share one `HistoryManager` instance, so undo/redo interleaves across types | No |
| Selection | `SelectionStore` (generic, shared across all object types - one selected object at a time, regardless of type) | No |
| Mesh creation/sync/disposal | `<Type>Layer` (e.g. `WallLayer`, `PillarLayer`) + its mesh-builder module; for every element kind, `ElementLayer` + `buildElementMesh.ts` (one recipe per catalog `shape`) | Yes |
| Click-to-select raycasting | `SelectionRaycaster` (generic, shared across all layers) - each `<Type>Layer` only exposes `getMeshes()`; it does not listen for clicks itself. See `SelectionRaycaster.ts`'s docs for why this moved out of `WallLayer` once a second selectable type existed | Yes |
| Selection-outline mesh | `selectionOutline.ts` (generic, shared across all layers) | Yes |
| Scene/camera/renderer/controls lifecycle | `SceneManager` | Yes |
| Mouse move/resize/rotate - gesture math and turning a gesture into `update_object` commands, one history group per gesture | `src/engine/manipulation/` (`manipulationMath.ts`, `ObjectManipulator.ts`) | No |
| Manipulation handles (drawn from store state) and pointer handling | `src/scene/manipulation/` (`ManipulationHandles`, `ManipulationController`) - never writes a store or moves a construction mesh | Yes |
| Reading/editing object data as UI | `rightSidebar.ts` (one catalog-driven panel for every element kind), `constructionRibbon.ts` + `ribbonTabs.ts` (the category tabs and their tools) | No (goes through the store/history layer) |

`src/engine/` never imports from `src/scene/` or `src/ui/` - data flows
one way: engine stores are the source of truth, `src/scene/*Layer`
classes render whatever the stores currently contain, and `src/ui/*`
reads and writes through the stores/history controllers. This is what
lets a second product (e.g. a future City Builder) reuse everything
under `src/engine/` with a completely different renderer.
