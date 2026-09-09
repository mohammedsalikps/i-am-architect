# Construction Engine

Framework-agnostic construction data and logic - no Three.js or DOM
imports anywhere under this folder. See `src/scene` for rendering and
`src/ui` for the editor chrome built on top of this.

- `objects/` - the shared construction-object foundation every object
  type builds on. Start here when adding a new object type. See
  `objects/README.md`.
- `wall/` - the wall object type: data model, store, and factory
  functions. The only object type implemented so far.
- `selection/` - generic single-selection state, shared by every object
  type.
- `history/` - generic undo/redo (`HistoryManager`) plus one adapter per
  object type (`wallHistory.ts`) that turns that type's mutations into
  undoable commands.
