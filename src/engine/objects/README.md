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

## Adding a new object type later

1. Add the type name to the `ObjectType` union in `types.ts`, if it
   isn't already listed (most are pre-listed as reserved extension
   points, so this step is usually already done).
2. Create `src/engine/<type>/types.ts` defining `<Type>Dimensions` and
   `<Type>Data = ConstructionObjectBase<"<type>", <Type>Dimensions>`.
3. Create `src/engine/<type>/create<Type>.ts` (a factory, following
   `wall/createWall.ts`) and a `<Type>Store` (copy `WallStore`'s shape:
   `add/update/set/remove/get/getAll/subscribe`), then wire it into
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
| Object data + validation rules (e.g. a wall's base stays grounded) | `<Type>Store` (e.g. `WallStore`) | No |
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
