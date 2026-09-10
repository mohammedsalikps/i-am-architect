# Assemblies

The foundational assembly system: a named, reusable grouping of
construction object ids (`types.ts`, `AssemblyStore.ts`). An assembly
is not a construction object itself - it has no position, dimensions,
material, or color; it just groups other objects' ids together, in
order.

## What an assembly is (and isn't) yet

```ts
interface AssemblyData {
  id: AssemblyId;
  name: string;
  description?: string;
  objectIds: ObjectId[]; // ordered, no duplicates
  createdAt: number;     // epoch ms
  updatedAt: number;     // epoch ms, never earlier than createdAt
}
```

This milestone is deliberately just the storage foundation. It does
**not** include: comparing two assemblies, snapshotting or reverting
an assembly's state, quotation/cost calculation, undo/redo for
assembly operations, or any UI. Those are all future work once this
foundation is proven.

## Why `AssemblyStore` can compose `ObjectRegistry`

`ObjectRegistry<T>`'s generic constraint is `T extends { id: ObjectId }`
- not the full `ConstructionObjectBase` shape. `AssemblyData` isn't a
construction object (no position/dimensions/material/color), but it
does have an `id`, so it can still use the exact same generic storage
class: `ObjectRegistry<AssemblyData>`. `AssemblyStore` composes it the
same way `WallStore` composes `ObjectRegistry<WallData>` (see
`objects/README.md`), adding only what's actually assembly-specific:

- **Shape validation** (`validateAssembly`, in `AssemblyStore.ts` -
  there's no separate `validateAssembly.ts` file for this milestone,
  unlike `wall/validateWall.ts`). Checks id/name are non-empty,
  `objectIds` are all non-empty strings with no duplicates, and
  `createdAt`/`updatedAt` are finite with `updatedAt >= createdAt`.
- **Duplicate-id rejection on `add()`.** A generic registry has no
  "this id must already be free" concept - `add()` just overwrites
  whatever's at that key. `AssemblyStore.add()` explicitly checks
  first and rejects if the id is already taken, since assemblies (unlike
  wall creation, which always mints a fresh id via a counter) can in
  principle be constructed with a caller-chosen id.

Everything else - cloning at the read/write boundary, `add/update/
remove/get/getAll/subscribe`, notification timing - comes from
`ObjectRegistry` for free, unmodified.

## What `validateAssembly` does *not* check

It validates an `AssemblyData` object's own shape only. It does not
verify that the ids in `objectIds` actually exist in `WallStore` (or
any future object store) - an assembly can end up referencing an
object that's later deleted. Reconciling that (e.g. pruning stale ids,
or blocking deletion of an object that's part of an assembly) is out
of scope for this milestone.

### Deleted members

Deleting an object leaves its id in every assembly that lists it.
Assembly edits aren't undoable, so removing the id would leave Undo
unable to put the membership back. The assembly panel lists and counts
only the members that currently exist. To the user, deleting an object
removes it from its assemblies, and undoing the delete puts it straight
back. `src/engine/ai/e2e/verify.ts` covers this.

## Commands

Assembly commands live in the existing command layer
(`src/engine/commands/types.ts` and `CommandExecutor.ts`), not a
separate module here - see that layer's README for the general
philosophy. `CommandExecutor` takes an `AssemblyStore` as an optional
third constructor argument (defaulting to a fresh one), so existing
callers that only construct it with `(wallStore, wallHistory)` are
unaffected.

| `type` | Fields | Behavior |
|---|---|---|
| `assembly.create` | `assembly: { name, description?, objectIds? }` | Creates an assembly via `createAssemblyData()`, then `AssemblyStore.add()` |
| `assembly.update` | `id`, `changes` | `AssemblyStore.update()` - `updatedAt` is always set to the current time by the executor, regardless of what (if anything) the caller passes |
| `assembly.delete` | `id` | `AssemblyStore.remove()` |
| `assembly.addObject` | `assemblyId`, `objectId` | Reads the assembly, appends `objectId` (rejected if already present), calls `update()` |
| `assembly.removeObject` | `assemblyId`, `objectId` | Reads the assembly, removes `objectId` (rejected if not present), calls `update()` |

None of these route through `HistoryManager` - assembly operations
aren't undoable yet, unlike wall operations. This is a deliberate scope
boundary for this milestone, not an oversight.
