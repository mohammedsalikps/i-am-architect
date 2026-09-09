import { el } from "./dom";
import { createTopBar } from "./topBar";
import { createMainNav } from "./mainNav";
import { createConstructionRibbon } from "./constructionRibbon";
import { createLeftSidebar } from "./leftSidebar";
import { createRightSidebar } from "./rightSidebar";
import { createCommandBar } from "./commandBar";
import { createStatusBar } from "./statusBar";
import { createViewControls, type ViewPreset } from "./viewControls";
import type { WallStore } from "../engine/wall/WallStore";
import type { AssemblyStore } from "../engine/assemblies/AssemblyStore";
import type { SelectionStore } from "../engine/selection/SelectionStore";
import type { HistoryManager } from "../engine/history/HistoryManager";
import type { CommandExecutor } from "../engine/commands/CommandExecutor";

export type AppShellOptions = {
  projectName: string;
  onViewChange: (preset: ViewPreset) => void;
  onAddWall: () => void;
  onDuplicateWall: () => void;
  onDeleteWall: () => void;
  onUndo: () => void;
  onRedo: () => void;
  wallStore: WallStore;
  assemblyStore: AssemblyStore;
  selectionStore: SelectionStore;
  history: HistoryManager;
  commandExecutor: CommandExecutor;
};

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
 * Six stacked rows: top bar, main nav, construction ribbon, body
 * (left workspace / viewport / right sidebar), bottom workspace,
 * status bar. See styles.css's "Shell layout" section for how this
 * collapses at narrow widths.
 */
export function createAppShell(options: AppShellOptions): AppShell {
  const topBar = createTopBar({
    projectName: options.projectName,
    onUndo: options.onUndo,
    onRedo: options.onRedo,
    history: options.history
  });

  const mainNav = createMainNav();

  const ribbon = createConstructionRibbon(options.onAddWall);

  const leftSidebar = createLeftSidebar(
    options.assemblyStore,
    options.commandExecutor,
    options.selectionStore,
    options.wallStore
  );
  const rightSidebar = createRightSidebar({
    wallStore: options.wallStore,
    selectionStore: options.selectionStore,
    commandExecutor: options.commandExecutor,
    onDuplicateWall: options.onDuplicateWall,
    onDeleteWall: options.onDeleteWall
  });

  const viewportContainer = el("div", { className: "viewport-container" });
  // Perspective/Top/Front/Side used to live in the header - they're
  // purely a viewport concern, so they're now an overlay on the
  // viewport itself instead of competing for header space.
  const viewControls = createViewControls(options.onViewChange);
  const viewControlsOverlay = el("div", { className: "viewport-area__controls" }, [viewControls]);
  const viewportArea = el("main", { className: "viewport-area" }, [viewportContainer, viewControlsOverlay]);

  const body = el("div", { className: "app-body" }, [leftSidebar, viewportArea, rightSidebar]);

  const commandBar = createCommandBar(options.onAddWall);

  const statusBar = createStatusBar({ projectName: options.projectName, selectionStore: options.selectionStore });

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
