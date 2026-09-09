import "./ui/styles.css";
import { SceneManager } from "./scene/SceneManager";
import { createAppShell } from "./ui/layout";
import { createProjectContext } from "./engine/project/ProjectContext";
import type { AddWallCommand, AddPillarCommand } from "./engine/commands/types";

const appRoot = document.getElementById("app");

if (!appRoot) {
  throw new Error("Missing #app element in index.html");
}

// One shared composition root - see src/engine/project/ProjectContext.ts.
// assemblyStore/pillarStore are the same instances commandExecutor uses
// internally (not invisible defaults of their own) - the UI reads/writes
// them through commandExecutor, same as wallStore.
const { wallStore, pillarStore, assemblyStore, selectionStore, history, commandExecutor } = createProjectContext();

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

// Successive pillars are spaced along X, on the opposite side of the
// grid from where walls stack along Z, so a freshly-added pillar is
// never buried inside a wall.
const PILLAR_X_START = 4;
const PILLAR_X_SPACING = 1.5;

function addPillar(): void {
  const index = pillarStore.getAll().length;
  const command: AddPillarCommand = {
    type: "pillar.add",
    pillar: { position: { x: PILLAR_X_START + index * PILLAR_X_SPACING } }
  };
  commandExecutor.execute(command);
}

addWall(); // default wall, visible on the grid at startup
history.clearHistory(); // the startup wall isn't a user action - start with a clean undo/redo state

/**
 * Duplicate/Delete now act on "whichever construction object is
 * currently selected" rather than "the selected wall" - selectionStore
 * is shared between walls and pillars (see ProjectContext), so the
 * selected id could belong to either store. Checking wallStore first,
 * then pillarStore, mirrors the same "try one store, fall back to the
 * next" shape rightSidebar.ts and assemblyPanel.ts already use to
 * resolve a selected/member id without assuming its type.
 */
function deleteSelected(): void {
  const selectedId = selectionStore.get();
  if (!selectedId) {
    return; // the toolbar button is disabled in this state, but guard anyway
  }
  if (wallStore.get(selectedId)) {
    // Selection is cleared as a side effect of WallHistoryController.remove()
    // (called inside the executor) - CommandExecutor itself never touches
    // SelectionStore, so no explicit clear() is needed here.
    commandExecutor.execute({ type: "wall.delete", id: selectedId });
  } else if (pillarStore.get(selectedId)) {
    commandExecutor.execute({ type: "pillar.delete", id: selectedId });
  }
}

function duplicateSelected(): void {
  const selectedId = selectionStore.get();
  if (!selectedId) {
    return; // the toolbar button is disabled in this state, but guard anyway
  }
  if (wallStore.get(selectedId)) {
    const result = commandExecutor.execute({ type: "wall.duplicate", id: selectedId });
    if (result.success && result.objectId) {
      selectionStore.select(result.objectId);
    }
  } else if (pillarStore.get(selectedId)) {
    const result = commandExecutor.execute({ type: "pillar.duplicate", id: selectedId });
    if (result.success && result.objectId) {
      selectionStore.select(result.objectId);
    }
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
  onAddPillar: addPillar,
  onDuplicateSelected: duplicateSelected,
  onDeleteSelected: deleteSelected,
  onUndo: () => history.undo(),
  onRedo: () => history.redo(),
  wallStore,
  pillarStore,
  assemblyStore,
  selectionStore,
  history,
  commandExecutor
});

appRoot.append(shell.root);

sceneManager.current = new SceneManager(shell.viewportContainer, wallStore, pillarStore, selectionStore);
sceneManager.current.start();
