# Elements

Every construction object beyond the six original types (wall, pillar,
beam, slab, door, window) is an **element**: a real, editable,
catalog-driven object with one store, one set of commands, and one
history controller for all kinds. Foundation, roof, stair, rooms,
flooring and ceiling, plumbing, electrical, furniture, kitchen, and
exterior works are all elements.

There are no per-kind stores or copy-pasted pipelines. A kind is one entry
in [catalog.ts](catalog.ts), and everything downstream is generic over it.

## The pipeline

| Step | Where | What it does for every kind |
| --- | --- | --- |
| Registry | `catalog.ts` | Label, category, dimensions (defaults, minimums, steps), which dimension spans each local axis, `baseY`, default material/color, suited material categories, parameters, mesh recipe (`shape`), AI keywords |
| Factory | `createElement.ts` | `createElementData({ kind, ... })`: catalog defaults, base at `baseY`, per-kind ids (`water-pipe-3`); `duplicateElementData`; `reserveElementIds` after a load |
| Validation | `validateElement.ts` | Known kind; exactly the kind's dimensions, each ≥ its minimum; finite position/rotation; a material from the [material library](../materials/materialLibrary.ts); `#rrggbb` color; parameters per spec; a non-blank label |
| Store | `ElementStore.ts` | Validated writes, duplicate-id rejection, kind never changes, vertical resize keeps the base (`keepBaseY`) |
| Commands | `commands/CommandExecutor.ts` | `element.add`, `element.update`, `element.delete`, `element.duplicate`; `update_object` also edits an element's `label` and `params` |
| History | `history/elementHistory.ts` | Undo/redo for add/update/remove, sharing the one HistoryManager |
| Scene | `src/scene/elements/` | `buildElementMesh.ts` draws each `shape` from primitives sized to the element's box; `ElementLayer.ts` syncs with the store and shows the selection outline |
| Selection & manipulation | `ai/geometry/analyzeConstructionGeometry.ts` (`localAxesFor`), `manipulation/` | Geometry, resize handles, move and rotate all read the kind's axes from the catalog |
| Project | `project/ProjectContext.ts`, `projectDocument.ts`, `projectPersistence.ts` | Elements live in the shared context, are cleared by New Project, and are saved and reopened exactly |
| Assemblies | `assemblies/` | Any element id can be an assembly member |
| AI | `ai/types.ts`, `ai/parseProjectSnapshot.ts`, `ai/providers/OpenAIProvider.ts`, `ai/MockAIProvider.ts` | Elements appear in the snapshot (with kind and label); the structured-output schema offers `element.add` with the kind and material enums taken from the registries |

`constructionTypeRegistry()` lists every constructible type - the six
original commands and one `element.add` entry per kind - for any client
(the AI layer, a future palette) that needs to discover what can be built.

## Coordinates

The same as the rest of the engine: meters, +Y up, `position` is the
center of the element's box, `rotation` is radians around Y. Every element
is a box in its own frame: `axes.x`, `axes.y`, `axes.z` name the dimension
along each local axis. A pipe runs along local X (`length`) with its
`diameter` on Y and Z; its Properties panel also edits its start and end
points, which are derived from center, length, and rotation.

## Rooms

A room is an element of kind `room`: a name (`label`), a footprint
(`length` × `width`), and a ceiling height. [rooms.ts](rooms.ts) computes
its floor area and which objects stand in it - membership is computed from
positions, never stored, so nothing goes stale when objects move.
[roomPresets.ts](roomPresets.ts) holds the Living Room, Kitchen, Master
Bedroom, Bedroom, Bathroom, and Dining Room presets the ribbon offers.

## Openings hosted by walls

Doors and windows have a `hostId`: the wall they belong to, or `null` for a
free-standing one (the default, and every duplicate).
[openings/hostOpening.ts](../openings/hostOpening.ts) places a hosted
opening flush against its wall's face, turned with it, at sill height for a
window. Walls are not cut (no boolean geometry yet); the relationship is
what future hosting builds on. A saved project never references a missing
wall: an opening whose wall was deleted is saved unhosted, and a document
naming a wall it doesn't contain is rejected.

## Finishes and paint

Painting is an ordinary `update_object` with `material: "paint"` and a
color: a painted wall is still the same wall - same id, size, place, and
assemblies - and one undo unpaints it. The Materials tab applies any
library material (with its typical color) the same way.

## Adding a kind

1. Add an entry to `ELEMENT_KINDS` in `catalog.ts` (reuse a `shape`, or add
   a recipe to `src/scene/elements/buildElementMesh.ts`).
2. Put it in a ribbon group in `src/ui/ribbonTabs.ts`.

`catalogProblems()` and `elements/verify.ts` check the rest: its axes name
real dimensions, its material is in the library, it appears on its
category's tab, and it survives the full create → edit → gesture →
duplicate → delete → undo → redo → save/reopen lifecycle.

## Not modeled (yet)

No boolean cuts for openings, no connections or flow between pipes and
fittings, no circuits, no structural, hydraulic, or electrical load
calculations, no code compliance, and no terrain. Room membership is by
object center only.
