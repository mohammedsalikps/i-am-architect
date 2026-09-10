import { el } from "./dom";
import { createTopBar } from "./topBar";
import { createMainNav } from "./mainNav";
import { createConstructionRibbon } from "./constructionRibbon";
import { buildRibbonTabs, type RibbonActions } from "./ribbonTabs";
import { createLeftSidebar } from "./leftSidebar";
import { createRightSidebar } from "./rightSidebar";
import { createCommandBar } from "./commandBar";
import type { AiInstructionSubmitter } from "../engine/ai/AiPromptController";
import { createStatusBar } from "./statusBar";
import { createViewControls, type ViewPreset } from "./viewControls";
import type { WallStore } from "../engine/wall/WallStore";
import type { PillarStore } from "../engine/pillar/PillarStore";
import type { BeamStore } from "../engine/beam/BeamStore";
import type { SlabStore } from "../engine/slab/SlabStore";
import type { DoorStore } from "../engine/door/DoorStore";
import type { WindowStore } from "../engine/window/WindowStore";
import type { ElementStore } from "../engine/elements/ElementStore";
import type { AssemblyStore } from "../engine/assemblies/AssemblyStore";
import type { SelectionStore } from "../engine/selection/SelectionStore";
import type { HistoryManager } from "../engine/history/HistoryManager";
import type { CommandExecutor } from "../engine/commands/CommandExecutor";
import type { ProjectMetaStore } from "../engine/project/ProjectMetaStore";
import type { ProjectPersistenceController } from "../engine/project/ProjectPersistenceController";
import type { SnapSettings } from "../engine/snapping/SnapSettings";
import type { AuthController } from "../engine/auth/AuthController";

export type AppShellOptions = {
  /** The project's identity - its name is shown and edited in the top bar, and shown in the status bar. */
  projectMeta: ProjectMetaStore;
  /** Save/Open state, rendered by the top bar - see ProjectPersistenceController. */
  persistence: ProjectPersistenceController;
  /** Who is signed in - rendered by the top bar's account control. */
  auth: AuthController;
  /** Shows the sign-in dialog - see ui/authDialog.ts. */
  onSignIn: () => void;
  /** Signs out - see main.ts's signOut. */
  onSignOut: () => void;
  onViewChange: (preset: ViewPreset) => void;
  /** What every ribbon tool does - see ribbonTabs.ts and main.ts. */
  ribbonActions: RibbonActions;
  onDuplicateSelected: () => void;
  onDeleteSelected: () => void;
  /** Empties the project - see main.ts's newProject. */
  onNewProject: () => void;
  /** Shows the project chooser - see ui/projectChooser.ts. */
  onOpenProject: () => void;
  /** Saves the project - see main.ts's saveProject. */
  onSaveProject: () => void;
  onUndo: () => void;
  onRedo: () => void;
  /** Sends one command-bar AI instruction through AICommandPipeline - see main.ts (constructed from AIService.submit) and commandBar.ts's "AI Prompt" tab. */
  onSubmitAiInstruction: AiInstructionSubmitter;
  wallStore: WallStore;
  pillarStore: PillarStore;
  beamStore: BeamStore;
  slabStore: SlabStore;
  doorStore: DoorStore;
  windowStore: WindowStore;
  elementStore: ElementStore;
  assemblyStore: AssemblyStore;
  selectionStore: SelectionStore;
  history: HistoryManager;
  commandExecutor: CommandExecutor;
  /** Whether drags snap - shown and toggled by the viewport's Snap button. */
  snapSettings: SnapSettings;
};

/** The viewport's Snap on/off button - drags snap to endpoints, corners, walls, and the grid while it's on. */
function createSnapToggle(snapSettings: SnapSettings): HTMLElement {
  const button = el("button", {
    className: "view-controls__button snap-toggle",
    attrs: { type: "button", title: "Snap to endpoints, corners, walls, and the 0.1 m grid while dragging" }
  });
  button.addEventListener("click", () => snapSettings.toggle());
  snapSettings.subscribe((enabled) => {
    button.textContent = enabled ? "Snap: On" : "Snap: Off";
    button.setAttribute("aria-pressed", String(enabled));
    button.classList.toggle("snap-toggle--on", enabled);
  });
  return el("div", { className: "view-controls" }, [button]);
}

export type AppShell = {
  /** Root element to mount into #app. */
  root: HTMLElement;
  /** Empty container the 3D renderer should be mounted into. */
  viewportContainer: HTMLElement;
};

/**
 * Builds the full iArchitect application shell and returns it along
 * with an empty container for the Three.js renderer. Contains no
 * Three.js code - SceneManager is mounted into `viewportContainer`
 * from main.ts.
 *
 * Six stacked rows: top bar, main nav (the tool categories), construction
 * ribbon (the chosen category's tools), body (left workspace / viewport /
 * right sidebar), bottom workspace, status bar - one child per
 * `.app-shell` grid row, in the same order (src/ui/verify.ts checks the
 * two stay in step). The shell is exactly one viewport tall: a panel
 * whose content is too tall scrolls inside itself rather than growing
 * the page. See styles.css's "Shell layout" section for details, and for
 * how this collapses at narrow widths.
 */
export function createAppShell(options: AppShellOptions): AppShell {
  const topBar = createTopBar({
    projectMeta: options.projectMeta,
    persistence: options.persistence,
    auth: options.auth,
    onNewProject: options.onNewProject,
    onOpenProject: options.onOpenProject,
    onSaveProject: options.onSaveProject,
    onSignIn: options.onSignIn,
    onSignOut: options.onSignOut,
    onUndo: options.onUndo,
    onRedo: options.onRedo,
    history: options.history
  });

  const ribbonTabs = buildRibbonTabs(options.ribbonActions);
  const ribbonControl = createConstructionRibbon(ribbonTabs, "home");
  const mainNav = createMainNav(
    ribbonTabs.map((tab) => ({ id: tab.id, label: tab.label })),
    (id) => ribbonControl.show(id),
    "home"
  );
  const ribbon = ribbonControl.element;
  // Tools that need a selection (Paint) re-check whenever it - or the
  // selected object - may have changed.
  const refreshRibbon = (): void => ribbonControl.refresh();
  options.selectionStore.subscribe(refreshRibbon);
  options.elementStore.subscribe(refreshRibbon);
  options.wallStore.subscribe(refreshRibbon);

  const leftSidebar = createLeftSidebar(
    options.assemblyStore,
    options.commandExecutor,
    options.selectionStore,
    options.wallStore,
    options.pillarStore,
    options.beamStore,
    options.slabStore,
    options.doorStore,
    options.windowStore,
    options.elementStore
  );
  const rightSidebar = createRightSidebar({
    wallStore: options.wallStore,
    pillarStore: options.pillarStore,
    beamStore: options.beamStore,
    slabStore: options.slabStore,
    doorStore: options.doorStore,
    windowStore: options.windowStore,
    elementStore: options.elementStore,
    selectionStore: options.selectionStore,
    commandExecutor: options.commandExecutor,
    onDuplicateSelected: options.onDuplicateSelected,
    onDeleteSelected: options.onDeleteSelected
  });

  const viewportContainer = el("div", { className: "viewport-container" });
  // Perspective/Top/Front/Side used to live in the header - they're
  // purely a viewport concern, so they're now an overlay on the
  // viewport itself instead of competing for header space.
  const viewControls = createViewControls(options.onViewChange);
  const viewControlsOverlay = el("div", { className: "viewport-area__controls" }, [viewControls, createSnapToggle(options.snapSettings)]);
  const viewportArea = el("main", { className: "viewport-area" }, [viewportContainer, viewControlsOverlay]);

  const body = el("div", { className: "app-body" }, [leftSidebar, viewportArea, rightSidebar]);

  const commandBar = createCommandBar(options.ribbonActions.addWall, options.onSubmitAiInstruction);

  const statusBar = createStatusBar({ projectMeta: options.projectMeta, selectionStore: options.selectionStore });

  const root = el("div", { className: "app-shell" }, [
    topBar,
    mainNav,
    ribbon,
    body,
    commandBar,
    statusBar
  ]);

  return { root, viewportContainer };
}
