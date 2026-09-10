# Construction Engine

Framework-agnostic construction data and logic - no Three.js or DOM
imports anywhere under this folder. See `src/scene` for rendering and
`src/ui` for the editor chrome built on top of this.

- `objects/` - the shared construction-object foundation every object
  type builds on. Start here when adding a new object type. See
  `objects/README.md`.
- `wall/`, `pillar/`, `beam/`, `slab/`, `door/`, `window/` - the six
  original object types, each with its own data model, store, factory,
  and validator.
- `elements/` - every other construction object (foundation, roof,
  stair, rooms, finishes, plumbing, electrical, interior, exterior) as
  one catalog-driven element system: one registry, store, command set,
  and history controller for all kinds. See `elements/README.md`.
- `materials/` - the material library every object's material comes
  from.
- `openings/` - hosting doors and windows on a wall (`hostId` and
  flush-on-face placement).
- `project/` - the shared `ProjectContext`, New Project, and saving and
  opening projects. See `project/README.md`.
- `ai/` - the AI command pipeline: structured commands only, validated,
  then executed through `CommandExecutor`. See `ai/README.md`.
- `selection/` - generic single-selection state, shared by every object
  type.
- `history/` - generic undo/redo (`HistoryManager`) plus one adapter per
  object type (`wallHistory.ts`) that turns that type's mutations into
  undoable commands. `HistoryManager` groups let one gesture record
  several commands as a single undo entry.
- `manipulation/` - mouse move/resize/rotate of the selected object:
  pure gesture math plus `ObjectManipulator`, which turns a gesture into
  `update_object` commands, one history entry per gesture. The
  Three.js/pointer side lives in `src/scene/manipulation/`. See
  `manipulation/README.md`.
