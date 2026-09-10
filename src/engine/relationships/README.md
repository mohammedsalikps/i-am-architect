# Construction relationships

How the model's objects relate: doors and windows **in** walls, pipes,
conduits and cables **connected** at their endpoints, and the
**snapping** and **alignment** that help put things together. MVP level:
deterministic, command-driven, fully undoable, and persisted. It is not a
BIM constraint solver.

The code lives where the data lives:

| Concern | Module |
| --- | --- |
| Hosting math: placement, fit, holes, which wall | [openings/hostOpening.ts](../openings/hostOpening.ts) |
| Endpoints, connections, joints, networks | [connections/connections.ts](../connections/connections.ts) |
| Snapping rules (pure) | [snapping/snapping.ts](../snapping/snapping.ts) |
| Snapping against the live stores, and the on/off setting | [snapping/storeSnapper.ts](../snapping/storeSnapper.ts), [snapping/SnapSettings.ts](../snapping/SnapSettings.ts) |
| Enforcement - propagation, cascade, validation, one undo step | [commands/CommandExecutor.ts](../commands/CommandExecutor.ts) |
| Tests | [verify.ts](verify.ts) (plus the complete house in [elements/verify.ts](../elements/verify.ts)) |

## One mutation path, one undo step

Every relationship is enforced in `CommandExecutor` - the only way the
model changes - so a Properties edit, a viewport drag, a ribbon tool, and
an AI response all get exactly the same behavior. A change that touches
several objects (a wall and the openings in it, a pipe and the ones
joined to it) runs inside one `HistoryManager` group: one Undo reverts
all of it. Inside a group that's already open (a drag, an AI batch) it
joins that group. Everything is checked before anything is written, so a
refused change leaves the model exactly as it was.

## Doors and windows in walls

A hosted opening stores its wall (`hostId`) and its **relative placement**
(`hostPlacement`: `offset` along the wall from its center, `sill` above
the wall's base). The placement is the source of truth; the opening's
world position and rotation are always derived from its wall's transform
(`hostedTransform`). It sits centered in the wall's thickness, turned
with it, and the wall is drawn with a real rectangular hole for it
(`src/scene/wall/buildWallMesh.ts` builds the holed wall from solid boxes
- no CSG). The door or window stays its own editable object.

| Action | Result |
| --- | --- |
| `door.add` / `window.add` with `hostId` | Goes into the wall at `offset`/`sill`, or - without them - the first free spot from the center (sill 0 for a door, 0.9 m for a window). |
| Move or turn the wall | Its openings move and turn with it; placements unchanged. |
| Shorten the wall | Openings are pulled back onto it. A wall too short or too low for an opening is refused. |
| Move the opening | Projected onto its wall: it slides along it (the height sets the sill); it never leaves the wall. |
| Turn the opening | Refused - it turns with its wall. (No rotation ring is shown for it.) |
| `hostId` change / `null` | Moves it into another wall / takes it out, where it stands. |
| Delete the opening | The wall remains. |
| **Delete the wall** | **Its openings are deleted with it** - a door floating where a wall used to be isn't a valid building. One Undo brings everything back, still hosted. |

Fit rules, checked on every write and on load: the host is an existing
wall; the opening fits the wall's length and height; openings in one wall
don't overlap.

## Endpoints and connections

Water pipes, drain pipes, conduits and cables are straight runs along
their local X: `start` is the -X end, `end` the +X end, derived from
position, rotation and length. An endpoint drag (the green handles)
moves one end and keeps the other.

A connection is recorded on **both** elements
(`connections: [{ endpoint, objectId, objectEndpoint }]`) and the two
endpoints always coincide. Compatible kinds come from the catalog's
`connectsWith`: water pipe ↔ water pipe, drain pipe ↔ drain pipe,
conduit ↔ conduit, cable ↔ cable.

- `element.connect` joins two endpoints within 0.3 m (the nearest pair
  unless endpoints are named) and snaps the first onto the second.
- Dropping a dragged endpoint on a compatible one connects them - part
  of the same undo step as the drag.
- Moving a connected endpoint (a move, turn, or new length) moves every
  endpoint at that joint; a new height moves the whole connected run. A
  change that would make a joined segment invalid is refused.
- Deleting an element removes its connections from its neighbors.
- Refused: self-connections, duplicates, incompatible kinds, unknown
  endpoint names, missing elements, endpoints too far apart, and editing
  `connections` directly (only `element.connect` / `element.disconnect`).
- A thicker pipe keeps its axis (and joints) where they are.

No flow, pressure, voltage, load, or routing is modeled.

## Snapping

While the viewport's **Snap** toggle is on, drags snap - in order:
point to point (endpoints, then corners, then centers, within 0.3 m),
then alignment of edges and centers per axis, then the 0.1 m grid.
Deterministic: ties go by distance, point kind, then object id.

- A wall's end snaps onto another wall's end; a pillar onto a wall's
  corner; a pipe end onto a compatible pipe end (and connects).
- A free-standing door or window near a wall snaps onto its plane.
- What moves with the dragged object (a wall's own openings, joined
  elements) is never a target.

Alignment helpers, as commands: `object.align` (X, Z, or both, onto
another object's center) and `object.snap` (`endpoint`: nearest key
points coincide, connecting two compatible pipes; `wall`: puts a door or
window into the wall). The Properties panel's "Align & snap" section
issues them.

## Geometry analysis and AI

`analyzeConstructionGeometry()` reports `hosts` (every hosted opening,
its offset and sill, and whether it fits) and `connections` (every
connected pair once, the gap, and whether it's valid) - linear in the
number of relationships. The AI snapshot carries a hosted opening's
`hostId` and an element's `connections`; the structured-output schema
offers `hostId`/`offset`/`sill` on `door.add`/`window.add` and
`element.connect`. Still structured commands only, never code.

## Persistence

The project document stores `hostId`, `hostPlacement` and `connections`.
Loading re-derives every hosted opening's transform from its wall,
derives a placement for older documents that lack one, and rejects any
broken host or connection.

## Not modeled (production-grade gaps)

Boolean/CSG openings in non-rectangular walls, openings spanning walls,
wall joins and miters, fittings (elbows, tees) as objects, routing,
clash resolution, a constraint solver, multi-select alignment, and any
engineering analysis.
