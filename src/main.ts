import "./ui/styles.css";
import { SceneManager } from "./scene/SceneManager";
import { createAppShell } from "./ui/layout";
import { clearProject, createProjectContext } from "./engine/project/ProjectContext";
import { firstFreeSlot } from "./engine/project/placement";
import { BackendAIProvider } from "./engine/ai/providers/BackendAIProvider";
import { AIService } from "./engine/ai/AIService";
import type {
  AddWallCommand,
  AddPillarCommand,
  AddBeamCommand,
  AddSlabCommand,
  AddDoorCommand,
  AddWindowCommand
} from "./engine/commands/types";
import type { AIPipelineResult } from "./engine/ai/types";

const appRoot = document.getElementById("app");

if (!appRoot) {
  throw new Error("Missing #app element in index.html");
}

// One shared composition root - see src/engine/project/ProjectContext.ts.
// assemblyStore/pillarStore/beamStore/slabStore/doorStore/windowStore
// are the same instances commandExecutor uses internally (not
// invisible defaults of their own) - the UI reads/writes them through
// commandExecutor, same as wallStore.
const project = createProjectContext();
const {
  wallStore,
  pillarStore,
  beamStore,
  slabStore,
  doorStore,
  windowStore,
  assemblyStore,
  selectionStore,
  history,
  commandExecutor
} = project;

// The AI proxy backend's base URL (see backend/README.md) - a
// non-secret value (just where to send requests, never a credential),
// read via Vite's client-side env mechanism (only VITE_-prefixed vars
// are ever inlined into the browser bundle - see .env.example and
// src/engine/ai/README.md "Security boundary" for why OPENAI_API_KEY
// itself never appears here or anywhere else client-side). Defaults to
// the backend's own documented local-dev port when unset - not a
// same-origin fallback (this app's Vite dev server has no proxy
// configured for a different-origin backend), just an explicit,
// documented absolute default.
const AI_BACKEND_URL = import.meta.env.VITE_AI_BACKEND_URL ?? "http://localhost:8787";

// BackendAIProvider never reads an environment variable or global
// fetch itself (see its own docs) - both are supplied explicitly here,
// the one place in the running app that constructs it. Wrapped in an
// arrow function (not passed as a bare `fetch` reference) so it's
// always invoked with the correct `this` - some environments throw on
// a detached `fetch` reference.
const aiProvider = new BackendAIProvider({
  baseUrl: AI_BACKEND_URL,
  fetch: (url, init) => fetch(url, init)
});

// Constructed once, here, from the SAME shared commandExecutor every
// manual UI action already uses - see ai/README.md "Where
// AICommandPipeline can be constructed safely". AIService holds no
// store reference itself (see its own docs); `snapshotSource` is only
// ever read via getAll()/get(), never written to.
const aiService = new AIService({
  provider: aiProvider,
  commandExecutor,
  // The same shared history: a whole AI response is ONE undo step, and a
  // response that fails part-way is rolled back rather than half-applied.
  history,
  snapshotSource: { wallStore, pillarStore, beamStore, slabStore, doorStore, windowStore, assemblyStore, selectionStore }
});

/** Wired into the command bar's "AI Prompt" tab (see ui/commandBar.ts) - the only path from a typed instruction to AICommandPipeline. */
function submitAiInstruction(instruction: string): Promise<AIPipelineResult> {
  return aiService.submit(instruction);
}

// Each type has a row of default slots; a new object takes the first slot
// no existing object of that type sits on (see engine/project/placement.ts),
// so adding after a delete never lands on top of a survivor.
const positionsOf = (objects: readonly { position: { x: number; z: number } }[]) => objects.map((object) => object.position);

// Successive walls are spaced along Z so "Add Wall" produces a visibly
// separate wall each time instead of stacking exactly on top of another.
const WALL_Z_START = -4;
const WALL_Z_SPACING = 2.5;

function addWall(): void {
  const index = firstFreeSlot(positionsOf(wallStore.getAll()), (slot) => ({ x: 0, z: WALL_Z_START + slot * WALL_Z_SPACING }));
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
  const index = firstFreeSlot(positionsOf(pillarStore.getAll()), (slot) => ({ x: PILLAR_X_START + slot * PILLAR_X_SPACING, z: 0 }));
  const command: AddPillarCommand = {
    type: "pillar.add",
    pillar: { position: { x: PILLAR_X_START + index * PILLAR_X_SPACING } }
  };
  commandExecutor.execute(command);
}

// Successive beams are spaced along Z on the positive side, away from
// both the wall stack (negative Z) and the pillar stack (positive X),
// so a freshly-added beam is never buried inside either.
const BEAM_Z_START = 4;
const BEAM_Z_SPACING = 1.5;

function addBeam(): void {
  const index = firstFreeSlot(positionsOf(beamStore.getAll()), (slot) => ({ x: 0, z: BEAM_Z_START + slot * BEAM_Z_SPACING }));
  const command: AddBeamCommand = {
    type: "beam.add",
    beam: { position: { z: BEAM_Z_START + index * BEAM_Z_SPACING } }
  };
  commandExecutor.execute(command);
}

// Successive slabs are spaced along X on the negative side, away from
// the wall stack (negative Z), the pillar stack (positive X), and the
// beam stack (positive Z), so a freshly-added slab is never buried
// under any of them.
const SLAB_X_START = -4;
const SLAB_X_SPACING = 5;

function addSlab(): void {
  const index = firstFreeSlot(positionsOf(slabStore.getAll()), (slot) => ({ x: SLAB_X_START - slot * SLAB_X_SPACING, z: 0 }));
  const command: AddSlabCommand = {
    type: "slab.add",
    slab: { position: { x: SLAB_X_START - index * SLAB_X_SPACING } }
  };
  commandExecutor.execute(command);
}

// Successive doors are spaced along Z on the negative side, further out
// than the wall stack, so a freshly-added door is never buried inside
// a wall.
const DOOR_Z_START = -8;
const DOOR_Z_SPACING = 1.5;

function addDoor(): void {
  const index = firstFreeSlot(positionsOf(doorStore.getAll()), (slot) => ({ x: 0, z: DOOR_Z_START - slot * DOOR_Z_SPACING }));
  const command: AddDoorCommand = {
    type: "door.add",
    door: { position: { z: DOOR_Z_START - index * DOOR_Z_SPACING } }
  };
  commandExecutor.execute(command);
}

// Successive windows are spaced along X on the positive side, further
// out than the pillar stack, so a freshly-added window is never buried
// inside a pillar.
const WINDOW_X_START = 8;
const WINDOW_X_SPACING = 1.5;

function addWindow(): void {
  const index = firstFreeSlot(positionsOf(windowStore.getAll()), (slot) => ({ x: WINDOW_X_START + slot * WINDOW_X_SPACING, z: 0 }));
  const command: AddWindowCommand = {
    type: "window.add",
    window: { position: { x: WINDOW_X_START + index * WINDOW_X_SPACING } }
  };
  commandExecutor.execute(command);
}

addWall(); // default wall, visible on the grid at startup
history.clearHistory(); // the startup wall isn't a user action - start with a clean undo/redo state

/**
 * "New Project": empties the in-memory model - objects, assemblies,
 * selection, and undo history - through clearProject() (see
 * ProjectContext.ts). Nothing is saved anywhere, so when there is
 * anything to lose the user confirms first.
 */
function newProject(): void {
  const hasContent =
    [wallStore, pillarStore, beamStore, slabStore, doorStore, windowStore].some((store) => store.getAll().length > 0) ||
    assemblyStore.getAll().length > 0;
  if (hasContent && !window.confirm("Start a new project? The current model, its assemblies, and its undo history will be discarded.")) {
    return;
  }
  clearProject(project);
}

/**
 * Duplicate/Delete now act on "whichever construction object is
 * currently selected" rather than "the selected wall" - selectionStore
 * is shared across every object type (see ProjectContext), so the
 * selected id could belong to any of the six stores. Checking each
 * store in turn mirrors the same "try each store in turn" shape
 * rightSidebar.ts and assemblyPanel.ts already use to resolve a
 * selected/member id without assuming its type.
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
  } else if (beamStore.get(selectedId)) {
    commandExecutor.execute({ type: "beam.delete", id: selectedId });
  } else if (slabStore.get(selectedId)) {
    commandExecutor.execute({ type: "slab.delete", id: selectedId });
  } else if (doorStore.get(selectedId)) {
    commandExecutor.execute({ type: "door.delete", id: selectedId });
  } else if (windowStore.get(selectedId)) {
    commandExecutor.execute({ type: "window.delete", id: selectedId });
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
  } else if (beamStore.get(selectedId)) {
    const result = commandExecutor.execute({ type: "beam.duplicate", id: selectedId });
    if (result.success && result.objectId) {
      selectionStore.select(result.objectId);
    }
  } else if (slabStore.get(selectedId)) {
    const result = commandExecutor.execute({ type: "slab.duplicate", id: selectedId });
    if (result.success && result.objectId) {
      selectionStore.select(result.objectId);
    }
  } else if (doorStore.get(selectedId)) {
    const result = commandExecutor.execute({ type: "door.duplicate", id: selectedId });
    if (result.success && result.objectId) {
      selectionStore.select(result.objectId);
    }
  } else if (windowStore.get(selectedId)) {
    const result = commandExecutor.execute({ type: "window.duplicate", id: selectedId });
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
  onAddBeam: addBeam,
  onAddSlab: addSlab,
  onAddDoor: addDoor,
  onAddWindow: addWindow,
  onDuplicateSelected: duplicateSelected,
  onDeleteSelected: deleteSelected,
  onNewProject: newProject,
  onUndo: () => history.undo(),
  onRedo: () => history.redo(),
  onSubmitAiInstruction: submitAiInstruction,
  wallStore,
  pillarStore,
  beamStore,
  slabStore,
  doorStore,
  windowStore,
  assemblyStore,
  selectionStore,
  history,
  commandExecutor
});

appRoot.append(shell.root);

sceneManager.current = new SceneManager(
  shell.viewportContainer,
  wallStore,
  pillarStore,
  beamStore,
  slabStore,
  doorStore,
  windowStore,
  selectionStore,
  commandExecutor,
  history
);
sceneManager.current.start();
