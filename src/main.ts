import "./ui/styles.css";
import { SceneManager } from "./scene/SceneManager";
import { createAppShell } from "./ui/layout";
import { WallStore } from "./engine/wall/WallStore";
import { SelectionStore } from "./engine/selection/SelectionStore";
import { duplicateWallData } from "./engine/wall/createWall";
import { HistoryManager } from "./engine/history/HistoryManager";
import { WallHistoryController } from "./engine/history/wallHistory";
import { CommandExecutor } from "./engine/commands/CommandExecutor";
import type { AddWallCommand } from "./engine/commands/types";

const appRoot = document.getElementById("app");

if (!appRoot) {
  throw new Error("Missing #app element in index.html");
}

const wallStore = new WallStore();
const selectionStore = new SelectionStore();
const history = new HistoryManager();
const wallHistory = new WallHistoryController(wallStore, selectionStore, history);
// Minimal proof CommandExecutor works end-to-end: "Add Wall" routes through
// it instead of calling wallHistory directly. Duplicate/Delete/Update still
// call wallHistory/wallStore directly - see src/engine/commands/README.md.
const commandExecutor = new CommandExecutor(wallStore, wallHistory);

// Successive walls are spaced along Z so "Add Wall" produces a visibly
// separate wall each time instead of stacking exactly on top of another.
const WALL_Z_START = -4;
const WALL_Z_SPACING = 2.5;

function addWall(): void {
  const index = wallStore.getAll().length;
  const command: AddWallCommand = {
    type: "wall.add",
    wall: { position: { z: WALL_Z_START + index * WALL_Z_SPACING } }
  };
  commandExecutor.execute(command);
}

addWall(); // default wall, visible on the grid at startup
history.clearHistory(); // the startup wall isn't a user action - start with a clean undo/redo state

function deleteSelectedWall(): void {
  const selectedId = selectionStore.get();
  if (!selectedId) {
    return; // the toolbar button is disabled in this state, but guard anyway
  }
  wallHistory.remove(selectedId);
}

function duplicateSelectedWall(): void {
  const selectedId = selectionStore.get();
  const wall = selectedId ? wallStore.get(selectedId) : undefined;
  if (!wall) {
    return; // the toolbar button is disabled in this state, but guard anyway
  }
  const duplicate = duplicateWallData(wall);
  wallHistory.add(duplicate);
  selectionStore.select(duplicate.id);
}

// Wrapped in a mutable ref: the header's view-control buttons need a
// callback before SceneManager exists (it mounts into a container the
// shell creates), so the callback reads this ref instead of a value.
const sceneManager = { current: null as SceneManager | null };

const shell = createAppShell({
  projectName: "Untitled Project",
  onViewChange: (preset) => sceneManager.current?.setView(preset),
  onAddWall: addWall,
  onDuplicateWall: duplicateSelectedWall,
  onDeleteWall: deleteSelectedWall,
  onUndo: () => history.undo(),
  onRedo: () => history.redo(),
  wallStore,
  selectionStore,
  history,
  wallHistory
});

appRoot.append(shell.root);

sceneManager.current = new SceneManager(shell.viewportContainer, wallStore, selectionStore);
sceneManager.current.start();
