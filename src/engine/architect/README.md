# EAVARA Architect (conversational workflow)

A conversation that takes a design from a site to a furnished, editable
house - deterministic, offline, and built entirely on the existing engine.

```
site → location → house details → plan → staged build → edits
"My plot is 30 × 20 m"   📍 click / "at 4, -2"   "Build a 3-bedroom house"
→ clarifying questions → "Lay the foundation" / "next" / "build everything"
```

| File | Responsibility |
|---|---|
| `parseUtterance.ts` | Classifies one turn (site, location, house, details, stage, next/all, yes/no, undo...). Pure, regex-based. Anything unrecognized is `unknown`. |
| `ArchitectSession.ts` | The DOM-free state machine: asks instead of guessing, plans with `ai/houseDesign.ts`, builds stage by stage. |
| `interiors.ts` | Deterministic furniture per room as `asset.add` commands, clear of doors, walls, pillars and (for tall pieces) windows - planned from a layout, or from the scene as it stands (`planFurnishingsInScene`). |
| `roomModel.ts` | Reads the real rooms from a snapshot: the walls that border each one (exterior, or shared with a named neighbour), the doors/windows hosted in its stretch of them, its furniture. Resolves room, wall and opening references in text. |
| `roomEdits.ts` | Room-aware edits on the built house - add a window/door to a room, move an opening along its wall, set a wall's length, refurnish, show a room. Each is one undo step, verified against a fresh snapshot before success is reported. |
| `verify.ts` | Parser, interiors, and whole conversations through the real `ProjectContext`. Part of `npm run verify`. |

UI: `src/ui/architectPanel.ts` (chat, chips, stage strip, 📍, 🎤),
`src/ui/voiceInput.ts` (Web Speech API), `src/scene/siteOverlay.ts`
(site boundary, location pin, planned footprint). Wired in `src/main.ts`.

## Guarantees

- **One mutation path.** Every change is a command through the shared
  `CommandExecutor`. The site is an ordinary `landscape` element, the
  house is ordinary walls/pillars/slab/doors/windows/rooms/roof, the
  furniture is ordinary assets - all selectable, editable, saved.
- **One undo step per stage.** Each stage runs through
  `executeCommandBatch()` with the shared history: all or nothing.
- **Never stale.** The session re-reads a fresh snapshot each turn. A
  stage counts as built while any object it created still exists, so
  undo, redo and manual deletes are reflected in the progress strip.
- **Clarifies.** A house with no size, no location yet, a footprint past
  the site boundary, a spot overlapping existing construction, a stage
  asked for out of order, "furnish the bedroom" with several bedrooms,
  "add a window" with no wall selected - each is a question with
  one-click answers, never a guess.
- **Offline first.** Only unrecognized turns go to the existing
  `AIService` (selection edits like "make the selected wall 5 metres
  long" still resolve locally there; sign-in is asked for only when the
  AI provider is really needed).

## Stages

`foundation` (slab) → `structure` (exterior + interior walls, corner
columns) → `openings` (doors and windows hosted in their walls) → `rooms`
(named room elements) → `roof` (gable) → `interiors` (furniture, room by
room). The first five reuse `houseDesign.ts`'s stage builders - the same
ones the one-shot AI Prompt house uses, so both paths build identical
houses.

## Room-aware edits

```
"Add a window to the kitchen."        "Move the front door one metre left."
"Refurnish bedroom 2."                "Make the bedroom wall 4 metres long."
"Show me the living room."            "Show the roof"
```

- Rooms are real `room` elements in the model - built by these stages,
  the AI Prompt, or by hand. Walls, openings and furniture are read
  from the model each turn (`roomModel.ts`), never from the plan.
- Ambiguity is a question whose chips each name one real target
  ("Which bedroom?", "Which wall of the Bathroom?", "Which door?"). A
  typed answer naming one option ("bedroom 2", "the right one") works too.
- Success is reported only after a fresh snapshot shows the change.
  Refusals (no free space, past the wall's end, length ≤ 0) and no-ops
  (already that long, 0 m, already furnished) change nothing and leave no
  undo entry.
- Directions are as seen in the Front view: left = -X, right = +X,
  front = +Z, back = -Z. A wall's length change keeps it centred.
- "Show me" hides the roof over the room through the viewport's
  VisibilityStore (a view setting, never the model); "show the roof"
  brings it back.

## Exterior style

```
"Keep the dimensions but make the exterior modern."    "Make the exterior traditional."
"Make the roof flat."    "Change the roof to a gable roof."    "Give it a mono-pitch roof."
```

- A generated house is **contemporary by default**: a flat roof with a
  parapet in dark metal, the four outside walls rendered warm white and
  the interior walls plastered. The walls' material stays the masonry the
  user chose (the record book still says brick) - only the finish colour
  changes, and the build reply says so.
- A roof's **style** (`flat`, `mono-pitch`, `gable` - see
  `engine/elements/roofStyles.ts`) changes only the shape drawn inside its
  box, with a height to suit it and its finish; its length, span, plan
  position and base on the walls never change. "Modern" is a flat roof and
  rendered outside walls; "traditional" a clay-tile gable and the masonry's
  own colour. The inspector's roof **Style** row restyles the same way
  (`roofStyleChanges()` is shared).
- A restyle never moves or resizes a room, wall, door or window; it is one
  undo step, says what changed, and says so when there is nothing to change
  or nothing built yet.
- Projects saved before roofs had a style open with their roofs as gables
  (the parameter's `legacy` value in `projectDocument.ts`) - nothing old
  changes appearance.

## Coordinates, grid and dimensions

```
"Set the plot to 30 metres by 40 metres."    "Set the grid spacing to half a metre."
"Create a 4.5 by 5 metre kitchen at X 8, Y 6."   "Move the room to X 10, Y 8."
"Move the kitchen two metres to the right."   "Make the kitchen 4.5 metres wide."
"Turn snapping off."                          "Snap to 0.25 m."
```

One coordinate system everywhere - the scene, the inspector, the record
book and the conversation (documented in
`engine/workspace/workspaceSettings.ts`):

- **X** runs east (+) / west (-), **Y** is up, **Z** runs south (+, the
  Front view's "front") / north (-). Metres.
- **Origin** (0, 0, 0): ground level at the world centre - marked in the
  viewport with the X/Y/Z axes and a "0, 0" ring.
- **Plan coordinates** are said as X and Y: "at X 8, Y 6" is world x 8,
  z 6, because the plan's second axis is world Z. Replies answer in the
  same terms ("moved to X 10, Y 8").
- A room's position is its centre; its **length** runs along X
  (east-west), its **width** along Z (north-south).

The **plot** is the site - a real landscape element, so it is saved and
undoable. Resizing it replaces it and never rescales anything built. The
**grid** is a view guide over a 200 m workspace, separate from the plot;
its spacing, **snapping** (on/off and its step), and whether the axes and
dimension labels show are viewer preferences - remembered per browser
(`localStorage`, key `iarchitect.workspace`), never in the project or the
undo history. Change them by voice/text, or in the viewport's **Grid &
plot** popover beside the Snap button.

Rooms move and resize **with their own walls** whichever way they're
asked - by conversation, or in the inspector's room rows
(`ArchitectSession.editRoom`, the same checks: overlap with another room,
shared walls, 1.5-30 m sides, 2-6 m ceilings). Each change is one undo
step; a refused one changes nothing and says why. While a room is still
being planned, "move it 2 m east" or "move it to X 12, Y 8" re-plans its
centre, and is never taken as the answer to the open question.

Dimension labels (each room's "Kitchen 4.5 × 5 m" on its floor, each
wall's length above it, the plot's edges) are drawn from the model every
time it changes - never stored. They keep a readable size at any zoom; a
wall's label steps aside while it would overlap a room's label or its wall
is too short on screen to carry it.

## Known limits

- Single storey; the planner's two-row room grid only.
- Interiors may leave out pieces in small rooms (reported, never forced).
- Voice needs a browser with the Web Speech API (Chrome, Edge); not the
  Android WebView.
- Conversation state is not saved with the project.
- Room edits understand axis-aligned rooms and walls only, and front/
  back/left/right sides (no compass points).
- Changing a wall's length doesn't move the walls it meets - the reply
  warns that a gap or overlap may result.
- Coordinates: rooms turned off the plan's axes can't be moved or resized
  with their walls (the inspector and the conversation both say so).
  Doors and windows keep their existing inspector rows (offset along the
  host wall, sizes); walls keep theirs (length, height, thickness).
- Dimension labels pass through the viewport's filmic tone mapping, so
  their white backgrounds read slightly grey; many rooms seen from far
  away can still crowd each other's labels.
