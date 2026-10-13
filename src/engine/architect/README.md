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
