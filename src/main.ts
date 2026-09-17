import "./ui/styles.css";
import { SceneManager } from "./scene/SceneManager";
import { createAppShell } from "./ui/layout";
import { createProjectChooser } from "./ui/projectChooser";
import type { ProjectDeleteResult, ProjectOpenResult } from "./ui/projectChooser";
import { createAuthDialog } from "./ui/authDialog";
import { releaseSplash } from "./ui/splash";
import type { RibbonActions } from "./ui/ribbonTabs";
import { clearProject, createProjectContext } from "./engine/project/ProjectContext";
import { firstFreeSlot } from "./engine/project/placement";
import { HttpProjectRepository } from "./engine/project/HttpProjectRepository";
import type { ProjectFetch } from "./engine/project/HttpProjectRepository";
import { ProjectPersistenceController } from "./engine/project/ProjectPersistenceController";
import { AuthController } from "./engine/auth/AuthController";
import type { SessionStorageLike } from "./engine/auth/AuthController";
import { HttpAuthClient } from "./engine/auth/HttpAuthClient";
import { BackendAIProvider } from "./engine/ai/providers/BackendAIProvider";
import type { BackendFetch } from "./engine/ai/providers/BackendAIProvider";
import { AIService } from "./engine/ai/AIService";
import { getElementKind } from "./engine/elements/catalog";
import type { ElementKindDefinition } from "./engine/elements/catalog";
import { getAssetDefinition } from "./engine/assets/catalog";
import type { AssetDefinition } from "./engine/assets/catalog";
import type { PlacementTool } from "./scene/placement/PlacementController";
import { createAssetPlacementPreview } from "./scene/placement/assetPlacementPreview";
import type { AssetPlacementPreview } from "./scene/placement/assetPlacementPreview";
import { createAssetPlacementSnapper } from "./engine/snapping/assetPlacementSnapper";
import { createElementPlacementHud } from "./scene/placement/elementPlacementHud";
import { createPlacementHud } from "./ui/placementHud";
import { roomPresetOptions } from "./engine/elements/roomPresets";
import type { CreateElementOptions } from "./engine/elements/createElement";
import { resolveConstructionObject } from "./engine/objects/resolveConstructionObject";
import { SnapSettings } from "./engine/snapping/SnapSettings";
import { VisibilityStore } from "./scene/visibility/VisibilityStore";
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
  assetStore,
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

/** window.localStorage - or, where the browser refuses it (some privacy modes), a map that lasts for this page only. */
function sessionStore(): SessionStorageLike {
  try {
    return window.localStorage;
  } catch {
    const memory = new Map<string, string>();
    return {
      getItem: (key) => memory.get(key) ?? null,
      setItem: (key, value) => {
        memory.set(key, value);
      },
      removeItem: (key) => {
        memory.delete(key);
      }
    };
  }
}

// Who is signed in. The browser keeps only the user's own session tokens
// (in localStorage, so a reload stays signed in) - never a Supabase or
// OpenAI key; the backend checks the token on every request. See
// src/engine/auth/ and backend/README.md "Security posture". Every fetch
// below is wrapped in an arrow function (not passed as a bare `fetch`
// reference) so it's always invoked with the correct `this` - some
// environments throw on a detached `fetch` reference.
const auth = new AuthController({
  client: new HttpAuthClient({ baseUrl: BACKEND_URL, fetch: (url, init) => fetch(url, init) }),
  storage: sessionStore()
});
const authDialog = createAuthDialog({ auth });

// BackendAIProvider never reads an environment variable or global
// fetch itself (see its own docs) - both are supplied explicitly here,
// the one place in the running app that constructs it. The transport is
// the real fetch wrapped by auth.authorize(), which adds the signed-in
// user's token (refreshing it when needed): the backend only answers AI
// requests from a signed-in user.
const aiProvider = new BackendAIProvider({
  baseUrl: BACKEND_URL,
  fetch: auth.authorize((url: string, init: Parameters<BackendFetch>[1]) => fetch(url, init))
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
    assetStore,
    assemblyStore,
    selectionStore
  }
});

/**
 * Wired into the command bar's "AI Prompt" tab (see ui/commandBar.ts) - the
 * only path from a typed instruction to AICommandPipeline. Signed out, the
 * user is asked to sign in first; if they decline, the backend refuses the
 * request and the command bar shows why.
 */
async function submitAiInstruction(instruction: string): Promise<AIPipelineResult> {
  if (!auth.isSignedIn()) {
    await authDialog.open("Sign in to use the AI assistant.");
  }
  return aiService.submit(instruction);
}

// Project storage goes through the backend's /api/projects routes - the
// browser holds no storage credential of any kind (see
// src/engine/project/README.md). Same injected, token-adding transport as
// BackendAIProvider above: the backend stores and returns only the
// signed-in user's projects.
const projectRepository = new HttpProjectRepository({
  baseUrl: BACKEND_URL,
  fetch: auth.authorize((url: string, init: Parameters<ProjectFetch>[1]) => fetch(url, init))
});
const persistence = new ProjectPersistenceController({ repository: projectRepository, project });

/** Every object store, for resolving a selected id to whatever it is. */
const objectStores = { wallStore, pillarStore, beamStore, slabStore, doorStore, windowStore, elementStore, assetStore };

// Each type has a row of default slots; a new object takes the first slot
// no existing object of that type sits on (see engine/project/placement.ts) -
// used only for the one startup wall below now; every ribbon/palette tool
// places through PlacementController (pick-and-place) instead - see
// armPlacement() and ribbonActions.
const positionsOf = (objects: readonly { position: { x: number; z: number } }[]) => objects.map((object) => object.position);

// The one startup wall (below) is spaced along Z the same way manual
// placement used to space every add, so a fresh project still starts with
// a wall visible on the grid, not stacked on the origin.
const WALL_Z_START = -4;
const WALL_Z_SPACING = 2.5;

/** The one wall present when a project starts - not a ribbon action, so it does not go through the placement/pick-and-place path below. */
function addStartupWall(): void {
  const index = firstFreeSlot(positionsOf(wallStore.getAll()), (slot) => ({ x: 0, z: WALL_Z_START + slot * WALL_Z_SPACING }));
  const command: AddWallCommand = {
    type: "wall.add",
    wall: { position: { z: WALL_Z_START + index * WALL_Z_SPACING } }
  };
  commandExecutor.execute(command);
}

/**
 * Arms the viewport for pick-and-place: the next click places the real
 * construction object there, through the exact same CommandExecutor path
 * every other creation path (AI included) already uses - only the
 * position source changes, from a computed slot to the clicked ground
 * point. See scene/placement/PlacementController.ts.
 *
 * The placed object is selected immediately - manipulation handles and
 * its Properties panel appear without an extra click, so "pick a tool,
 * place it, then drag/edit it" is one continuous motion. Unless `repeat`
 * is true, that one placement also disarms the tool and returns to
 * normal selection mode (PlacementController.handlePointerUp()) - the
 * user is never left in an invisible, unbounded "keeps building forever"
 * state. Clicking the same tool's ribbon button again while it's already
 * armed toggles it off instead of re-arming, so there is always an
 * obvious way back to selection mode beyond Escape alone.
 */
function armPlacement(
  id: string,
  label: string,
  ghostSize: PlacementTool["ghostSize"],
  buildCommand: (point: { x: number; z: number }) => unknown,
  options: { repeat?: boolean } = {}
): void {
  const controller = sceneManager.current?.placementController;
  if (!controller) {
    return;
  }
  if (controller.activeToolId() === id) {
    controller.disarm(); // same tool clicked again - toggle off, mirroring Escape
    return;
  }
  controller.arm({
    id,
    label,
    ghostSize,
    repeat: options.repeat ?? false,
    place: (point) => {
      const result = commandExecutor.execute(buildCommand(point));
      if (result.success && result.objectId) {
        selectionStore.select(result.objectId);
      }
    }
  });
}

// Ghost-preview footprints for the six original types, matching each
// factory's own DEFAULTS (createWall.ts/createPillar.ts/.../createWindow.ts) -
// the ghost is a visual preview only; the real object is still built by
// the real factory once placed, so these numbers drifting from a
// factory's own default would only make the PREVIEW briefly inaccurate,
// never the placed object itself.
const ORIGINAL_GHOST_SIZES: Record<"wall" | "pillar" | "beam" | "slab" | "door" | "window", PlacementTool["ghostSize"]> = {
  wall: { x: 4, y: 2.7, z: 0.2 },
  pillar: { x: 0.4, y: 2.7, z: 0.4 },
  beam: { x: 3, y: 0.4, z: 0.3 },
  slab: { x: 4, y: 0.2, z: 4 },
  door: { x: 0.9, y: 2.1, z: 0.05 },
  window: { x: 1.2, y: 1.2, z: 0.05 }
};

function addWall(): void {
  // Walls are naturally placed end-to-end in a run, so this is the one
  // tool that stays armed after a successful placement - Escape, the
  // status bar's Cancel button, or clicking Wall again all end it.
  armPlacement("wall", "Wall", ORIGINAL_GHOST_SIZES.wall, (point) => ({ type: "wall.add", wall: { position: { x: point.x, z: point.z } } }) satisfies AddWallCommand, {
    repeat: true
  });
}

function addPillar(): void {
  armPlacement("pillar", "Pillar", ORIGINAL_GHOST_SIZES.pillar, (point) => ({ type: "pillar.add", pillar: { position: { x: point.x, z: point.z } } }) satisfies AddPillarCommand);
}

function addBeam(): void {
  armPlacement("beam", "Beam", ORIGINAL_GHOST_SIZES.beam, (point) => ({ type: "beam.add", beam: { position: { x: point.x, z: point.z } } }) satisfies AddBeamCommand);
}

function addSlab(): void {
  armPlacement("slab", "Slab", ORIGINAL_GHOST_SIZES.slab, (point) => ({ type: "slab.add", slab: { position: { x: point.x, z: point.z } } }) satisfies AddSlabCommand);
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

/**
 * With a wall selected, the door goes in that wall INSTANTLY, exactly as
 * before (unchanged - preserved exactly, not routed through placement,
 * since the wall already fully determines where it goes). Without a wall
 * selected, arms pick-and-place for a free-standing door.
 */
function addDoor(): void {
  const wall = selectedWall();
  if (wall) {
    addHostedOpening("door", wall);
    return;
  }
  armPlacement("door", "Door", ORIGINAL_GHOST_SIZES.door, (point) => ({ type: "door.add", door: { position: { x: point.x, z: point.z } } }) satisfies AddDoorCommand);
}

/** With a wall selected, the window goes in that wall at sill height, unchanged; otherwise arms pick-and-place for a free-standing window. */
function addWindow(): void {
  const wall = selectedWall();
  if (wall) {
    addHostedOpening("window", wall);
    return;
  }
  armPlacement("window", "Window", ORIGINAL_GHOST_SIZES.window, (point) => ({ type: "window.add", window: { position: { x: point.x, z: point.z } } }) satisfies AddWindowCommand);
}

/**
 * A catalog kind's ghost footprint, read from the SAME catalog data the
 * kind's real dimensions come from (ElementKindDefinition.dimensions +
 * .axes) - never a second, hand-maintained size list.
 */
function elementGhostSize(definition: ElementKindDefinition): PlacementTool["ghostSize"] {
  const byKey = new Map(definition.dimensions.map((spec) => [spec.key, spec.default]));
  return { x: byKey.get(definition.axes.x) ?? 0.5, y: byKey.get(definition.axes.y) ?? 0.5, z: byKey.get(definition.axes.z) ?? 0.5 };
}

/** Arms pick-and-place for one catalog element kind - an element.add command once placed, so it validates and undoes like any other add. */
function addElement(kind: string, options: Omit<CreateElementOptions, "kind"> = {}): void {
  const definition = getElementKind(kind);
  if (!definition) {
    return;
  }
  armPlacement(kind, definition.label, elementGhostSize(definition), (point) => ({
    type: "element.add",
    element: { ...options, kind, position: { x: point.x, z: point.z } }
  }));
}

/**
 * A design asset's ghost footprint, read from the SAME catalog data its
 * real placed size comes from (AssetDefinition.defaultDimensions) - never
 * a second, hand-maintained size list. Mirrors elementGhostSize() above.
 */
function assetGhostSize(definition: AssetDefinition): PlacementTool["ghostSize"] {
  return { x: definition.defaultDimensions.width, y: definition.defaultDimensions.height, z: definition.defaultDimensions.depth };
}

/**
 * Arms pick-and-place for one catalog design asset - an asset.add command
 * once placed, so it validates, loads its real model, and undoes exactly
 * like any other add (see AssetLayer.ts). This is the manual half of
 * "AI + manual parity" (task section 17): ui/assetLibrary.ts's card click
 * calls this exact function, and AICommandPipeline's asset.add commands
 * (see engine/ai/types.ts) go through the identical commandExecutor path,
 * so a manually placed and an AI-placed sofa are the same kind of object.
 */
function addAsset(assetId: string): void {
  const definition = getAssetDefinition(assetId);
  if (!definition) {
    return;
  }
  armPlacement(`asset:${assetId}`, definition.label, assetGhostSize(definition), (point) => {
    // The preview's own current (already-snapped) position and rotation
    // (R/Shift+R, and Phase 6 initial-placement snapping - see
    // scene/placement/assetPlacementPreview.ts), read at the moment of
    // this confirmed click so the real placed object matches exactly
    // what was previewed - never the raw, unsnapped click point. Falls
    // back to the raw point/0° only if the preview module hasn't been
    // constructed yet or has no position yet (getViewportContext() only
    // exists once sceneManager.current is set - see below).
    const position = assetPlacementPreview?.getCurrentPosition() ?? { x: point.x, z: point.z };
    return {
      type: "asset.add",
      asset: { assetId, position, rotation: assetPlacementPreview?.getCurrentRotation() ?? 0 }
    };
  });
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

/** Whether ribbon/palette tool `id` is the one currently armed for pick-and-place - drives the ribbon's "active" button state. */
function isPlacementActive(id: string): boolean {
  return sceneManager.current?.placementController.activeToolId() === id;
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
  canPaintSelection,
  isPlacementActive
};

addStartupWall(); // default wall, visible on the grid at startup
history.clearHistory(); // the startup wall isn't a user action - start with a clean undo/redo state

/** True when discarding the model would lose something: any object or assembly. */
function modelHasContent(): boolean {
  return (
    [wallStore, pillarStore, beamStore, slabStore, doorStore, windowStore, elementStore, assetStore].some((store) => store.getAll().length > 0) ||
    assemblyStore.getAll().length > 0
  );
}

/**
 * "New Project": empties the model - objects, assemblies, selection, and
 * undo history - through clearProject() (see ProjectContext.ts), and
 * starts a new "Untitled Project". Signed in, that project is created in
 * the user's account straight away (empty, owned by them); signed out, it
 * stays unsaved until they sign in and Save. Other saved projects are
 * never touched. When there is anything to lose the user confirms first.
 */
async function newProject(): Promise<void> {
  if (persistence.isBusy()) {
    return;
  }
  if (modelHasContent() && !window.confirm("Start a new project? The current model, its assemblies, and its undo history will be discarded.")) {
    return;
  }
  clearProject(project);
  persistence.reset();
  if (auth.isSignedIn()) {
    await persistence.createProject();
  }
}

/**
 * "Save": stores the model under the project's name - see
 * ProjectPersistenceController.save(). Never an undo step. Saving needs an
 * account: signed out - or when the session turns out to have expired -
 * the user is asked to sign in, and the save goes ahead once they have.
 */
async function saveProject(): Promise<void> {
  if (persistence.isBusy()) {
    return;
  }
  if (!auth.isSignedIn() && !(await authDialog.open("Sign in to save your project."))) {
    return;
  }
  const saved = await persistence.save();
  if (!saved && persistence.getState().authRequired && (await authDialog.open("Your session expired - sign in again to save your project."))) {
    await persistence.save();
  }
}

/** Deletes one saved project from the chooser, after the user confirms. The workspace is never cleared. */
async function deleteSavedProject(id: string, name: string): Promise<ProjectDeleteResult> {
  if (!window.confirm(`Delete "${name}"? It will be removed from your saved projects. This can't be undone.`)) {
    return { deleted: false };
  }
  const deleted = await persistence.deleteProject(id, name);
  return deleted ? { deleted: true } : { deleted: false, error: persistence.getState().message ?? "The project could not be deleted." };
}

/**
 * "Sign out": the workspace is cleared too, so the next person at this
 * browser doesn't see the project - after a confirmation when there's
 * anything to lose.
 */
async function signOut(): Promise<void> {
  if (persistence.isBusy()) {
    return;
  }
  if (modelHasContent() && !window.confirm("Sign out? The model in the workspace will be cleared - save first to keep it.")) {
    return;
  }
  clearProject(project);
  persistence.reset();
  await auth.signOut();
}

// A project belongs to the account that saved it. If a different user
// signs in (say, after a session expired), the open model becomes unsaved
// for them - their Save creates a project of their own, never a write to
// someone else's.
let signedInUserId: string | null = null;
auth.subscribe((state) => {
  if (state.status !== "signed-in" || !state.user) {
    return;
  }
  if (signedInUserId !== null && signedInUserId !== state.user.id) {
    projectMeta.detach();
  }
  signedInUserId = state.user.id;
});

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
  onOpen: openSavedProject,
  onDelete: deleteSavedProject,
  isSignedIn: () => auth.isSignedIn(),
  onSignIn: () => authDialog.open("Sign in to see your saved projects.")
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
  } else if (assetStore.get(selectedId)) {
    commandExecutor.execute({ type: "asset.delete", id: selectedId });
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
  } else if (assetStore.get(selectedId)) {
    result = commandExecutor.execute({ type: "asset.duplicate", id: selectedId });
  }
  if (result?.success && result.objectId) {
    selectionStore.select(result.objectId);
  }
}

// Wrapped in a mutable ref: the header's view-control buttons need a
// callback before SceneManager exists (it mounts into a container the
// shell creates), so the callback reads this ref instead of a value.
const sceneManager = { current: null as SceneManager | null };

// Same "mutable ref read by an earlier-defined closure" pattern as
// sceneManager above: addAsset()'s placement closure needs the current
// preview rotation at click time, but this can only be constructed once
// sceneManager.current exists (see below, after `new SceneManager(...)`).
let assetPlacementPreview: AssetPlacementPreview | null = null;

// Whether drags snap - a UI preference (the viewport's Snap toggle), not part of the model.
const snapSettings = new SnapSettings();

// Which objects are hidden right now - a viewport/session concern, never
// part of the saved project document (see VisibilityStore's own docs).
// Constructed here, once, so the left sidebar's visibility controls and
// SceneManager's layers share exactly one instance.
const visibilityStore = new VisibilityStore();

const shell = createAppShell({
  projectMeta,
  persistence,
  auth,
  onSignIn: () => void authDialog.open(),
  onSignOut: () => void signOut(),
  onViewChange: (preset) => sceneManager.current?.setView(preset),
  onFitToScene: () => sceneManager.current?.fitToScene(),
  onFocusSelected: () => {
    const selectedId = selectionStore.get();
    if (selectedId) {
      sceneManager.current?.focusOn([selectedId]);
    }
  },
  onFocusObjects: (objectIds) => sceneManager.current?.focusOn(objectIds),
  visibilityStore,
  ribbonActions,
  onDuplicateSelected: duplicateSelected,
  onDeleteSelected: deleteSelected,
  onNewProject: () => void newProject(),
  onOpenProject: () => projectChooser.open(),
  onSaveProject: () => void saveProject(),
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
  assetStore,
  assemblyStore,
  selectionStore,
  history,
  commandExecutor,
  snapSettings,
  onAddAsset: addAsset,
  onHighlightConstructionObjects: (objectIds) => sceneManager.current?.highlightConstructionObjects(objectIds) ?? { resolved: 0, unresolved: objectIds?.length ?? 0 }
});

appRoot.append(shell.root);
// Outside the shell's six-row grid - they're fixed overlays.
document.body.append(projectChooser.element, authDialog.element);

sceneManager.current = new SceneManager(
  shell.viewportContainer,
  wallStore,
  pillarStore,
  beamStore,
  slabStore,
  doorStore,
  windowStore,
  elementStore,
  assetStore,
  selectionStore,
  commandExecutor,
  history,
  snapSettings,
  visibilityStore
);
sceneManager.current.start();
// The startup wall (or a restored project's whole model, once loaded)
// framed on first paint, rather than the camera's fixed default
// position - which, for anything bigger than the single startup wall,
// left the building looking like a small object adrift in a mostly
// empty viewport. See SceneManager.fitToScene().
sceneManager.current.fitToScene();
// Same reasoning for a project that gets replaced after startup: opening
// a saved project (or an AI response building a whole house - see
// AiPromptController's onCreated wiring in ui/commandBar.ts) should show
// the result, not leave the camera wherever it happened to be.
persistence.subscribe((state) => {
  if (state.status === "opened") {
    sceneManager.current?.fitToScene();
  }
});

// The ribbon shows which tool is armed (RibbonTool.isActive), and the
// status bar shows the placement banner and its Cancel button - both
// re-derived from PlacementController, not duplicated state of their own.
sceneManager.current.placementController.subscribe((tool) => {
  shell.refreshRibbon();
  shell.refreshAssetLibrary();
  shell.setPlacementStatus(tool ? { label: tool.label, onCancel: () => sceneManager.current?.placementController.disarm() } : null);
});

// Phase 5A: a real, translucent GLTF preview + pre-placement rotation +
// a contextual dimension/rotation HUD for asset placement specifically -
// entirely additive to PlacementController's own generic ghost/arm/
// disarm/click/Escape lifecycle. Needs the real scene/camera/canvas to
// render an actual model in the viewport, which only SceneManager can
// hand out - see its getViewportContext() and PlacementController's own
// setGhostVisible() for the two small, additive exceptions this required.
const placementHud = createPlacementHud();
document.body.append(placementHud.element);
assetPlacementPreview = createAssetPlacementPreview({
  ...sceneManager.current.getViewportContext(),
  placementController: sceneManager.current.placementController,
  // Phase 6: initial-placement snapping against the real construction
  // elements already in the project - see engine/snapping/
  // assetPlacementSnapper.ts for why this is a separate adapter from
  // the manipulation-time createStoreSnapper(), not a change to it.
  snapper: createAssetPlacementSnapper(objectStores, snapSettings),
  onHudChange: placementHud.update
});

// Phase 6: the same compact placement HUD, extended to every other
// placement tool (wall/pillar/beam/slab/door/window/roof/stair/room/...) -
// the two modules never both claim the same armed tool (see
// elementPlacementHud.ts's own ASSET_TOOL_PREFIX check), so sharing one
// HUD element between them is safe.
createElementPlacementHud({
  ...sceneManager.current.getViewportContext(),
  placementController: sceneManager.current.placementController,
  onHudChange: placementHud.update
});

// Restore a stored session, if any, and confirm it with the backend.
void auth.start();

// The workspace is running: the Eavara startup screen (index.html) can
// hand over to it - see ui/splash.ts.
releaseSplash();
