import "./ui/styles.css";
import { SceneManager } from "./scene/SceneManager";
import { createAppShell } from "./ui/layout";
import { createProjectChooser } from "./ui/projectChooser";
import type { ProjectOpenResult } from "./ui/projectChooser";
import type { RibbonActions } from "./ui/ribbonTabs";
import { clearProject, createProjectContext } from "./engine/project/ProjectContext";
import { firstFreeSlot } from "./engine/project/placement";
import { HttpProjectRepository } from "./engine/project/HttpProjectRepository";
import { ProjectPersistenceController } from "./engine/project/ProjectPersistenceController";
import { BackendAIProvider } from "./engine/ai/providers/BackendAIProvider";
import { AIService } from "./engine/ai/AIService";
import { getElementKind } from "./engine/elements/catalog";
import type { ElementCategory } from "./engine/elements/catalog";
import { roomPresetOptions } from "./engine/elements/roomPresets";
import type { CreateElementOptions } from "./engine/elements/createElement";
import { resolveConstructionObject } from "./engine/objects/resolveConstructionObject";
import { SnapSettings } from "./engine/snapping/SnapSettings";
import type { WallData } from "./engine/wall/types";
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
// Every store here is the same instance commandExecutor uses internally
// (not an invisible default of its own) - the UI reads the stores and
// writes through commandExecutor.
const project = createProjectContext();
const {
  wallStore,
  pillarStore,
  beamStore,
  slabStore,
  doorStore,
  windowStore,
  elementStore,
  assemblyStore,
  selectionStore,
  history,
  commandExecutor,
  projectMeta
} = project;

// The backend's base URL (see backend/README.md) - a non-secret value
// (just where to send requests, never a credential), read via Vite's
// client-side env mechanism (only VITE_-prefixed vars are ever inlined
// into the browser bundle - see .env.example and src/engine/ai/README.md
// "Security boundary" for why OPENAI_API_KEY itself never appears here
// or anywhere else client-side). The same backend serves AI requests and
// project storage. Defaults to the backend's own documented local-dev
// port when unset - not a same-origin fallback (this app's Vite dev
// server has no proxy configured for a different-origin backend), just
// an explicit, documented absolute default.
const BACKEND_URL = import.meta.env.VITE_AI_BACKEND_URL ?? "http://localhost:8787";

// BackendAIProvider never reads an environment variable or global
// fetch itself (see its own docs) - both are supplied explicitly here,
// the one place in the running app that constructs it. Wrapped in an
// arrow function (not passed as a bare `fetch` reference) so it's
// always invoked with the correct `this` - some environments throw on
// a detached `fetch` reference.
const aiProvider = new BackendAIProvider({
  baseUrl: BACKEND_URL,
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
  snapshotSource: {
    wallStore,
    pillarStore,
    beamStore,
    slabStore,
    doorStore,
    windowStore,
    elementStore,
    assemblyStore,
    selectionStore
  }
});

/** Wired into the command bar's "AI Prompt" tab (see ui/commandBar.ts) - the only path from a typed instruction to AICommandPipeline. */
function submitAiInstruction(instruction: string): Promise<AIPipelineResult> {
  return aiService.submit(instruction);
}

// Project storage goes through the backend's /api/projects routes - the
// browser holds no storage credential of any kind (see
// src/engine/project/README.md). Same injected-transport rule as
// BackendAIProvider above.
const projectRepository = new HttpProjectRepository({
  baseUrl: BACKEND_URL,
  fetch: (url, init) => fetch(url, init)
});
const persistence = new ProjectPersistenceController({ repository: projectRepository, project });

/** Every object store, for resolving a selected id to whatever it is. */
const objectStores = { wallStore, pillarStore, beamStore, slabStore, doorStore, windowStore, elementStore };

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

/** The selected object, when it's a wall - doors and windows are then placed in it. */
function selectedWall(): WallData | undefined {
  const selectedId = selectionStore.get();
  return selectedId ? wallStore.get(selectedId) : undefined;
}

/**
 * Adds a door or window INTO `wall` - one command: the executor finds the
 * first free spot from the wall's center (a window at sill height), derives
 * its position from the wall, and the wall is redrawn with a hole for it.
 * From then on it moves and turns with the wall. See
 * engine/openings/hostOpening.ts.
 */
function addHostedOpening(type: "door" | "window", wall: WallData): void {
  commandExecutor.execute(type === "door" ? { type: "door.add", door: { hostId: wall.id } } : { type: "window.add", window: { hostId: wall.id } });
}

// Successive free-standing doors are spaced along Z on the negative side,
// further out than the wall stack, so a freshly-added door is never
// buried inside a wall.
const DOOR_Z_START = -8;
const DOOR_Z_SPACING = 1.5;

/** With a wall selected, the door goes in that wall; otherwise it's placed free-standing, as before. */
function addDoor(): void {
  const wall = selectedWall();
  if (wall) {
    addHostedOpening("door", wall);
    return;
  }
  const index = firstFreeSlot(positionsOf(doorStore.getAll()), (slot) => ({ x: 0, z: DOOR_Z_START - slot * DOOR_Z_SPACING }));
  const command: AddDoorCommand = {
    type: "door.add",
    door: { position: { z: DOOR_Z_START - index * DOOR_Z_SPACING } }
  };
  commandExecutor.execute(command);
}

// Successive free-standing windows are spaced along X on the positive
// side, further out than the pillar stack, so a freshly-added window is
// never buried inside a pillar.
const WINDOW_X_START = 8;
const WINDOW_X_SPACING = 1.5;

/** With a wall selected, the window goes in that wall at sill height; otherwise it's placed free-standing, as before. */
function addWindow(): void {
  const wall = selectedWall();
  if (wall) {
    addHostedOpening("window", wall);
    return;
  }
  const index = firstFreeSlot(positionsOf(windowStore.getAll()), (slot) => ({ x: WINDOW_X_START + slot * WINDOW_X_SPACING, z: 0 }));
  const command: AddWindowCommand = {
    type: "window.add",
    window: { position: { x: WINDOW_X_START + index * WINDOW_X_SPACING } }
  };
  commandExecutor.execute(command);
}

/** House-scale kinds start centered on the origin - under, over, or around the house. */
const HOUSE_SCALE_KINDS: ReadonlySet<string> = new Set(["foundation", "roof", "landscape"]);

/**
 * Every other element starts in its category's staging row, clear of the
 * six original types' rows (which run along the X and Z axes through the
 * origin) - move it into place from there. Spacing fits the category's
 * largest default footprint.
 */
const ELEMENT_ROW_X_START = 3;
const ELEMENT_ROWS: Readonly<Record<ElementCategory, { z: number; spacing: number }>> = {
  structure: { z: -16, spacing: 4.5 },
  openings: { z: -16, spacing: 4.5 },
  rooms: { z: 11, spacing: 5.5 },
  finish: { z: 16, spacing: 5 },
  plumbing: { z: -11, spacing: 3.5 },
  electrical: { z: -13, spacing: 3.5 },
  interior: { z: 20, spacing: 3 },
  exterior: { z: 24, spacing: 11 }
};

function elementSlot(kind: string): { x: number; z: number } {
  const definition = getElementKind(kind);
  if (!definition) {
    return { x: 0, z: 0 };
  }
  if (HOUSE_SCALE_KINDS.has(kind)) {
    const step = definition.dimensions[0].default + 2;
    const occupied = positionsOf(elementStore.getAll().filter((element) => element.kind === kind));
    const index = firstFreeSlot(occupied, (slot) => ({ x: slot * step, z: 0 }));
    return { x: index * step, z: 0 };
  }
  const row = ELEMENT_ROWS[definition.category];
  const occupied = positionsOf(
    elementStore
      .getAll()
      .filter((element) => !HOUSE_SCALE_KINDS.has(element.kind) && getElementKind(element.kind)?.category === definition.category)
  );
  const index = firstFreeSlot(occupied, (slot) => ({ x: ELEMENT_ROW_X_START + slot * row.spacing, z: row.z }));
  return { x: ELEMENT_ROW_X_START + index * row.spacing, z: row.z };
}

/** Adds one element of a catalog kind at its next free slot - an element.add command, so it validates, and undoes, like any other add. */
function addElement(kind: string, options: Omit<CreateElementOptions, "kind"> = {}): void {
  const slot = elementSlot(kind);
  commandExecutor.execute({ type: "element.add", element: { ...options, kind, position: { x: slot.x, z: slot.z } } });
}

/** Whether the selection is an object Paint can repaint - any construction object. */
function canPaintSelection(): boolean {
  const selectedId = selectionStore.get();
  return !!selectedId && resolveConstructionObject(selectedId, objectStores) !== null;
}

/**
 * Paint: the selected object gets material "paint" and the chosen color
 * through one update_object command - a painted wall is still the same
 * wall, with the same id, size and assemblies, and one undo unpaints it.
 */
function paintSelected(color: string): void {
  const selectedId = selectionStore.get();
  if (!selectedId || !canPaintSelection()) {
    return; // the button is disabled in this state, but guard anyway
  }
  commandExecutor.execute({ type: "update_object", objectId: selectedId, changes: { material: "paint", color } });
}

const ribbonActions: RibbonActions = {
  addWall,
  addPillar,
  addBeam,
  addSlab,
  addDoor,
  addWindow,
  addElement: (kind) => addElement(kind),
  addRoom: (preset) => {
    const { kind, ...options } = roomPresetOptions(preset);
    addElement(kind, options);
  },
  paintSelected,
  canPaintSelection
};

addWall(); // default wall, visible on the grid at startup
history.clearHistory(); // the startup wall isn't a user action - start with a clean undo/redo state

/** True when discarding the model would lose something: any object or assembly. */
function modelHasContent(): boolean {
  return (
    [wallStore, pillarStore, beamStore, slabStore, doorStore, windowStore, elementStore].some((store) => store.getAll().length > 0) ||
    assemblyStore.getAll().length > 0
  );
}

/**
 * "New Project": empties the model - objects, assemblies, selection, and
 * undo history - and starts a new, unsaved "Untitled Project", through
 * clearProject() (see ProjectContext.ts). When there is anything to lose
 * the user confirms first.
 */
function newProject(): void {
  if (persistence.isBusy()) {
    return;
  }
  if (modelHasContent() && !window.confirm("Start a new project? The current model, its assemblies, and its undo history will be discarded.")) {
    return;
  }
  clearProject(project);
  persistence.reset();
}

/** "Save": stores the model under the project's name - see ProjectPersistenceController.save(). Never an undo step. */
function saveProject(): void {
  void persistence.save();
}

/**
 * Opens a saved project from the chooser, replacing the current model
 * (see loadProject()). When the current model has content, the user
 * confirms first - opening doesn't save it.
 */
async function openSavedProject(id: string, name: string): Promise<ProjectOpenResult> {
  if (modelHasContent() && !window.confirm(`Open "${name}"? The current model and its undo history will be replaced - save first to keep them.`)) {
    return { opened: false };
  }
  const opened = await persistence.open(id);
  return opened ? { opened: true } : { opened: false, error: persistence.getState().message ?? "The project could not be opened." };
}

const projectChooser = createProjectChooser({
  listProjects: () => persistence.listProjects(),
  onOpen: openSavedProject
});

/**
 * Duplicate/Delete act on "whichever construction object is currently
 * selected" - selectionStore is shared across every object type (see
 * ProjectContext), so the selected id could belong to any store. Checking
 * each store in turn mirrors the same "try each store in turn" shape
 * rightSidebar.ts and assemblyPanel.ts use to resolve an id without
 * assuming its type.
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
  } else if (elementStore.get(selectedId)) {
    commandExecutor.execute({ type: "element.delete", id: selectedId });
  }
}

function duplicateSelected(): void {
  const selectedId = selectionStore.get();
  if (!selectedId) {
    return; // the toolbar button is disabled in this state, but guard anyway
  }
  let result: { success: boolean; objectId?: string } | undefined;
  if (wallStore.get(selectedId)) {
    result = commandExecutor.execute({ type: "wall.duplicate", id: selectedId });
  } else if (pillarStore.get(selectedId)) {
    result = commandExecutor.execute({ type: "pillar.duplicate", id: selectedId });
  } else if (beamStore.get(selectedId)) {
    result = commandExecutor.execute({ type: "beam.duplicate", id: selectedId });
  } else if (slabStore.get(selectedId)) {
    result = commandExecutor.execute({ type: "slab.duplicate", id: selectedId });
  } else if (doorStore.get(selectedId)) {
    result = commandExecutor.execute({ type: "door.duplicate", id: selectedId });
  } else if (windowStore.get(selectedId)) {
    result = commandExecutor.execute({ type: "window.duplicate", id: selectedId });
  } else if (elementStore.get(selectedId)) {
    result = commandExecutor.execute({ type: "element.duplicate", id: selectedId });
  }
  if (result?.success && result.objectId) {
    selectionStore.select(result.objectId);
  }
}

// Wrapped in a mutable ref: the header's view-control buttons need a
// callback before SceneManager exists (it mounts into a container the
// shell creates), so the callback reads this ref instead of a value.
const sceneManager = { current: null as SceneManager | null };

// Whether drags snap - a UI preference (the viewport's Snap toggle), not part of the model.
const snapSettings = new SnapSettings();

const shell = createAppShell({
  projectMeta,
  persistence,
  onViewChange: (preset) => sceneManager.current?.setView(preset),
  ribbonActions,
  onDuplicateSelected: duplicateSelected,
  onDeleteSelected: deleteSelected,
  onNewProject: newProject,
  onOpenProject: () => projectChooser.open(),
  onSaveProject: saveProject,
  onUndo: () => history.undo(),
  onRedo: () => history.redo(),
  onSubmitAiInstruction: submitAiInstruction,
  wallStore,
  pillarStore,
  beamStore,
  slabStore,
  doorStore,
  windowStore,
  elementStore,
  assemblyStore,
  selectionStore,
  history,
  commandExecutor,
  snapSettings
});

appRoot.append(shell.root);
// Outside the shell's six-row grid - it's a fixed overlay.
document.body.append(projectChooser.element);

sceneManager.current = new SceneManager(
  shell.viewportContainer,
  wallStore,
  pillarStore,
  beamStore,
  slabStore,
  doorStore,
  windowStore,
  elementStore,
  selectionStore,
  commandExecutor,
  history,
  snapSettings
);
sceneManager.current.start();
