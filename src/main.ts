import "./ui/styles.css";
import { SceneManager } from "./scene/SceneManager";
import { createAppShell } from "./ui/layout";
import { WallStore } from "./engine/wall/WallStore";
import { SelectionStore } from "./engine/selection/SelectionStore";
import { createWallData } from "./engine/wall/createWall";

const appRoot = document.getElementById("app");

if (!appRoot) {
  throw new Error("Missing #app element in index.html");
}

const wallStore = new WallStore();
const selectionStore = new SelectionStore();

// Successive walls are spaced along Z so "Add Wall" produces a visibly
// separate wall each time instead of stacking exactly on top of another.
const WALL_Z_START = -4;
const WALL_Z_SPACING = 2.5;

function addWall(): void {
  const index = wallStore.getAll().length;
  wallStore.add(createWallData({ position: { z: WALL_Z_START + index * WALL_Z_SPACING } }));
}

addWall(); // default wall, visible on the grid at startup

// Wrapped in a mutable ref: the header's view-control buttons need a
// callback before SceneManager exists (it mounts into a container the
// shell creates), so the callback reads this ref instead of a value.
const sceneManager = { current: null as SceneManager | null };

const shell = createAppShell({
  projectName: "Untitled Project",
  onViewChange: (preset) => sceneManager.current?.setView(preset),
  onAddWall: addWall,
  wallStore,
  selectionStore
});

appRoot.append(shell.root);

sceneManager.current = new SceneManager(shell.viewportContainer, wallStore, selectionStore);
sceneManager.current.start();
