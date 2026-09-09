import "./ui/styles.css";
import { SceneManager } from "./scene/SceneManager";
import { createAppShell } from "./ui/layout";
import { createProjectContext } from "./engine/project/ProjectContext";
import type { AddWallCommand } from "./engine/commands/types";

const appRoot = document.getElementById("app");

if (!appRoot) {
  throw new Error("Missing #app element in index.html");
}

// One shared composition root - see src/engine/project/ProjectContext.ts.
// assemblyStore is the same instance commandExecutor uses internally
// (not an invisible default of its own) - the left sidebar's assembly
// panel reads/writes it through commandExecutor, same as wallStore.
const { wallStore, assemblyStore, selectionStore, history, commandExecutor } = createProjectContext();

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
  // Selection is cleared as a side effect of WallHistoryController.remove()
  // (called inside the executor) - CommandExecutor itself never touches
  // SelectionStore, so no explicit clear() is needed here.
  commandExecutor.execute({ type: "wall.delete", id: selectedId });
}

function duplicateSelectedWall(): void {
  const selectedId = selectionStore.get();
  if (!selectedId) {
    return; // the toolbar button is disabled in this state, but guard anyway
  }
  const result = commandExecutor.execute({ type: "wall.duplicate", id: selectedId });
  if (result.success && result.objectId) {
    selectionStore.select(result.objectId);
  }
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
  assemblyStore,
  selectionStore,
  history,
  commandExecutor
});

appRoot.append(shell.root);

sceneManager.current = new SceneManager(shell.viewportContainer, wallStore, selectionStore);
sceneManager.current.start();
