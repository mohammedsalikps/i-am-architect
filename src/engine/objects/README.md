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
getAll/has/subscribe`. It is **not wired into the running app yet** -
`WallStore` still owns all wall data. It exists so the *next* object
type (pillar, beam, slab, ...) doesn't need to hand-copy `WallStore`'s
plumbing the way this document previously suggested ("copy WallStore's
shape") - it can just instantiate `new ObjectRegistry<PillarData>()`.

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

**Why `WallStore` still exists / hasn't migrated.** `WallStore.update()`
has one piece of wall-specific behavior the generic registry
deliberately does not know: when `dimensions.height` changes, it
re-derives `position.y` so the wall's base stays on the ground. A
generic registry can't encode that rule (it doesn't know a wall has a
"height" or that height means anything about grounding) without ceasing
to be generic. Migrating `WallStore` onto `ObjectRegistry` today would
either lose that behavior or force type-specific logic into the generic
class - both worse than the current small amount of duplication.

**Future migration path.** Once a second object type (e.g. pillars)
needs its own store, `WallStore` can be refactored to *compose*
`ObjectRegistry<WallData>` internally: delegate `add/set/remove/get/
getAll/has/subscribe` straight through, and keep only the
grounding rule as an override in `WallStore.update()` that calls the
registry's `update()`/`set()` underneath. The public `WallStore` API
(and therefore `WallHistoryController`, `WallLayer`, `rightSidebar.ts`,
etc.) would not need to change at all - only `WallStore`'s internals
would. A future `PillarStore`, `BeamStore`, `SlabStore` etc. would each
follow the same pattern: compose `ObjectRegistry<TheirDataType>`, add
only whatever type-specific rule they need on top (or none at all, if
they need no derived-field behavior).

## Adding a new object type later

1. Add the type name to the `ObjectType` union in `types.ts`, if it
   isn't already listed (most are pre-listed as reserved extension
   points, so this step is usually already done).
2. Create `src/engine/<type>/types.ts` defining `<Type>Dimensions` and
   `<Type>Data = ConstructionObjectBase<"<type>", <Type>Dimensions>`.
3. Create `src/engine/<type>/create<Type>.ts` (a factory, following
   `wall/createWall.ts`) and a `<Type>Store` that composes
   `ObjectRegistry<<Type>Data>` internally (see "Generic registry"
   above) - or, if `WallStore` was migrated onto `ObjectRegistry` by
   then, follow that pattern. Add only the type-specific rules your
   object actually needs on top; use `ObjectRegistry` directly if it
   needs none. Then wire the store into
   `src/engine/history/<type>History.ts` the same way `wallHistory.ts`
   wires `WallStore` into `HistoryManager`.
4. Create `src/scene/<type>/` with a mesh-builder module and a
   `<Type>Layer` (copy `WallLayer`'s shape) that `SceneManager` composes
   alongside `WallLayer`.
5. Extend the right sidebar / toolbar UI to read and write through the
   new store, the same way `rightSidebar.ts` and `header.ts` do for
   walls.

No existing file needs to change to support a new object type beyond
the `ObjectType` union (already anticipates every type this app plans
to support) and `SceneManager` composing one more `<Type>Layer`.

## Layer ownership

| Concern | Owner | Knows about Three.js? |
|---|---|---|
| Generic CRUD + subscribe storage, reusable across all object types | `ObjectRegistry<T>` (generic) | No |
| Object data + type-specific validation rules (e.g. a wall's base stays grounded) | `<Type>Store` (e.g. `WallStore`), optionally composing `ObjectRegistry<T>` | No |
| Undo/redo | `HistoryManager` (generic) + `<type>History.ts` (e.g. `wallHistory.ts`) | No |
| Selection | `SelectionStore` (generic, shared across all object types) | No |
| Mesh creation/sync/disposal, click-to-select raycasting | `<Type>Layer` (e.g. `WallLayer`) + its mesh-builder module | Yes |
| Scene/camera/renderer/controls lifecycle | `SceneManager` | Yes |
| Reading/editing object data as UI | `rightSidebar.ts`, `header.ts` | No (goes through the store/history layer) |

`src/engine/` never imports from `src/scene/` or `src/ui/` - data flows
one way: engine stores are the source of truth, `src/scene/*Layer`
classes render whatever the stores currently contain, and `src/ui/*`
reads and writes through the stores/history controllers. This is what
lets a second product (e.g. a future City Builder) reuse everything
under `src/engine/` with a completely different renderer.
