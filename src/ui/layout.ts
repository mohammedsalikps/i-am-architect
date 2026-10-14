import { el } from "./dom";
import { createTopBar } from "./topBar";
import { createMainNav } from "./mainNav";
import { createConstructionRibbon } from "./constructionRibbon";
import { buildRibbonTabs, type RibbonActions } from "./ribbonTabs";
import { createLeftSidebar } from "./leftSidebar";
import { createRightSidebar, type RoomEditHandler } from "./rightSidebar";
import { createCommandBar } from "./commandBar";
import type { AiInstructionSubmitter } from "../engine/ai/AiPromptController";
import { createStatusBar, type PlacementStatusInfo } from "./statusBar";
import { createViewControls, type ViewPreset } from "./viewControls";
import type { WallStore } from "../engine/wall/WallStore";
import type { PillarStore } from "../engine/pillar/PillarStore";
import type { BeamStore } from "../engine/beam/BeamStore";
import type { SlabStore } from "../engine/slab/SlabStore";
import type { DoorStore } from "../engine/door/DoorStore";
import type { WindowStore } from "../engine/window/WindowStore";
import type { ElementStore } from "../engine/elements/ElementStore";
import type { AssetStore } from "../engine/assets/AssetStore";
import type { AssemblyStore } from "../engine/assemblies/AssemblyStore";
import type { SelectionStore } from "../engine/selection/SelectionStore";
import type { HistoryManager } from "../engine/history/HistoryManager";
import type { CommandExecutor } from "../engine/commands/CommandExecutor";
import type { ProjectMetaStore } from "../engine/project/ProjectMetaStore";
import type { ProjectPersistenceController } from "../engine/project/ProjectPersistenceController";
import type { SnapSettings } from "../engine/snapping/SnapSettings";
import { formatSpacing, type WorkspaceState } from "../engine/workspace/workspaceSettings";
import type { AuthController } from "../engine/auth/AuthController";
import type { VisibilityStore } from "../scene/visibility/VisibilityStore";
import { buildAIProjectSnapshot } from "../engine/ai/types.ts";
import type { HighlightConstructionObjects } from "./constructionMethodPanel.ts";
import type { ThemeStore } from "./theme";
import type { ArchitectActivity } from "./architectPanel";
import { COMPANION_STATE_LABEL } from "./copilotState";
import { createMenu, createMenuBar, type MenuItem } from "./menus";
import { createSplitter } from "./splitter";
import { SHELL_ICONS } from "./shellIcons";
import { DOCK_HEIGHT, PANEL_WIDTHS, RAIL_WIDTH, clampDockHeight, columnWidths, createLayoutStore, isCompact, type LayoutStorage, type LayoutStore, type SidePanelId, type WorkspaceLayout } from "./workspaceLayout";

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
  /** Frames every visible object ("Fit House") - see SceneManager.fitToScene(). */
  onFitToScene: () => void;
  /** Frames the selected object ("Focus Selected") - see SceneManager.focusOn(). */
  onFocusSelected: () => void;
  /** Frames a specific set of object ids ("Focus Room", from the left sidebar's hierarchy) - see SceneManager.focusOn(). */
  onFocusObjects: (objectIds: string[]) => void;
  /** Which objects are hidden right now - shared with SceneManager's layers. See VisibilityStore's own docs. */
  visibilityStore: VisibilityStore;
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
  assetStore: AssetStore;
  assemblyStore: AssemblyStore;
  selectionStore: SelectionStore;
  history: HistoryManager;
  commandExecutor: CommandExecutor;
  /** Whether drags snap - shown and toggled by the viewport's Snap button. */
  snapSettings: SnapSettings;
  /** Select / Measure / Annotate (ui/viewportTools.ts), shown in the Snap button's row. */
  viewportTools?: HTMLElement[];
  /** Arms pick-and-place for one catalog design asset - see ui/assetLibrary.ts and main.ts's addAsset(). */
  onAddAsset: (assetId: string) => void;
  /** The Construction Method tab's viewport highlight - see SceneManager.highlightConstructionObjects() and constructionMethodPanel.ts. */
  onHighlightConstructionObjects: HighlightConstructionObjects;
  /** A close-up of one point - a pipe fitting picked in the record book. See SceneManager.focusOnPoint(). */
  onFocusPoint?: (point: { x: number; y: number; z: number }) => void;
  /** Light/dark - the top bar's switch (ui/theme.ts). */
  theme?: ThemeStore;
  /**
   * The EAVARA Architect conversation (ui/architectPanel.ts), in the
   * assistant drawer beside the inspector - opened from its button at the
   * viewport's bottom-right. Build it with `onClose` calling the shell's
   * closeAssistant(), so its header button closes the drawer.
   */
  architect?: { element: HTMLElement; focusInput: () => void; subscribeActivity?: (listener: (activity: ArchitectActivity) => void) => () => void };
  /** The workspace's grid and snapping (engine/workspace/workspaceSettings.ts), shown live in the status bar. */
  workspace?: { subscribe(listener: (state: WorkspaceState) => void): () => void };
  /** The "Grid & plot" control (ui/workspacePanel.ts), after the Snap button. */
  workspaceControl?: HTMLElement;
  /** Extra overlays drawn over the viewport - the scale bar (ui/scaleBar.ts). */
  viewportOverlays?: HTMLElement[];
  /** Moves or resizes a room with its walls - the inspector's room rows (ArchitectSession.editRoom). */
  onRoomEdit?: RoomEditHandler;
  /** Interior Explore (ui/interiorNavigator.ts) - the View menu's entry for it. */
  interiorExplore?: { isActive(): boolean; toggle(): void };
  /** Where the panel layout is kept for the browser session (sessionStorage); null: this page only. */
  layoutStorage?: LayoutStorage | null;
};

/** The records dock leaves the viewport at least this tall, px - unless the centre is too short to fit the dock at DOCK_HEIGHT.min too (then the dock keeps its minimum). */
const VIEWPORT_MIN_HEIGHT = 300;
/** The open dock's chrome: its 1px top border, the 32px tab row and that row's 1px bottom border. */
const DOCK_CHROME = 34;

/** The tallest the dock may be in a centre this tall: its share of it, leaving the viewport at least VIEWPORT_MIN_HEIGHT - never below DOCK_HEIGHT.min, which wins in a centre shorter than DOCK_HEIGHT.min + DOCK_CHROME + VIEWPORT_MIN_HEIGHT (474px). */
function dockCeiling(centerHeight: number): number {
  return Math.max(DOCK_HEIGHT.min, Math.min(Math.floor(centerHeight * DOCK_HEIGHT.maxShare), centerHeight - DOCK_CHROME - VIEWPORT_MIN_HEIGHT));
}

/** The dock's height on screen for the stored one - what the drag handle starts from and announces, too. */
function shownDockHeight(stored: number, centerHeight: number): number {
  return clampDockHeight(Math.min(stored, dockCeiling(centerHeight)), centerHeight);
}

/** The viewport's Snap on/off button - drags snap to endpoints, corners, walls, and the grid while it's on - after the viewport tools, when there are any. */
function createSnapToggle(snapSettings: SnapSettings, tools: HTMLElement[] = [], after: HTMLElement[] = []): HTMLElement {
  const button = el("button", {
    className: "view-controls__button snap-toggle",
    attrs: { type: "button" }
  });
  button.addEventListener("click", () => snapSettings.toggle());
  // The step is told on every change too (SnapSettings.setStep), so the label always shows the live increment.
  snapSettings.subscribe((enabled) => {
    const step = formatSpacing(snapSettings.getStep());
    button.textContent = enabled ? `Snap: ${step}` : "Snap: Off";
    button.title = enabled
      ? `Dragged objects snap to ends, corners and walls, and to a ${step} grid. Click to turn snapping off; change the step in Grid & plot.`
      : "Snapping is off - dragged objects move freely. Click to turn it on.";
    button.setAttribute("aria-pressed", String(enabled));
    button.classList.toggle("snap-toggle--on", enabled);
  });
  return el("div", { className: "view-controls" }, [...tools, ...(tools.length > 0 ? [el("span", { className: "view-controls__divider" })] : []), button, ...after]);
}

/** True once every construction store is empty - a fresh "New Project" or a signed-out reset, before the first wall exists. */
function isProjectEmpty(options: AppShellOptions): boolean {
  return (
    options.wallStore.getAll().length === 0 &&
    options.pillarStore.getAll().length === 0 &&
    options.beamStore.getAll().length === 0 &&
    options.slabStore.getAll().length === 0 &&
    options.doorStore.getAll().length === 0 &&
    options.windowStore.getAll().length === 0 &&
    options.elementStore.getAll().length === 0 &&
    options.assetStore.getAll().length === 0
  );
}

/**
 * The viewport's own empty state: a small card over the bare grid until
 * the first object exists, hidden the moment one does (see
 * updateEmptyState() in createAppShell). Three real actions, not a
 * welcome screen: "Build Manually" arms the Wall tool exactly like the
 * palette's own Wall button, "Ask AI to Design" opens the assistant and
 * focuses its input, "Open Project" opens the project chooser - the same
 * as File ▸ Open….
 */
function buildEmptyState(options: AppShellOptions, focusAiInput: () => void): HTMLElement {
  const buildButton = el("button", {
    className: "toolbar-button toolbar-button--primary empty-state__button",
    text: "Build Manually",
    attrs: { type: "button" }
  });
  buildButton.addEventListener("click", () => options.ribbonActions.addWall());

  const aiButton = el("button", {
    className: "toolbar-button empty-state__button",
    text: "Ask AI to Design",
    attrs: { type: "button" }
  });
  aiButton.addEventListener("click", focusAiInput);

  const openButton = el("button", { className: "toolbar-button empty-state__button", text: "Open Project", attrs: { type: "button" } });
  openButton.addEventListener("click", options.onOpenProject);

  return el("div", { className: "empty-state" }, [
    el("div", { className: "empty-state__panel" }, [
      el("p", { className: "empty-state__eyebrow", text: "EAVARA · THE SCHOOL OF ARCHITECTURE" }),
      el("h2", { className: "empty-state__title", text: "Start Building" }),
      el("p", {
        className: "empty-state__hint",
        text: "Place your first wall, or describe the house you want and let AI lay it out."
      }),
      el("div", { className: "empty-state__actions" }, [buildButton, aiButton, openButton])
    ])
  ]);
}

/** A chrome button: an icon (aria-hidden) and a name - as visible text, or as aria-label and tooltip when only the icon shows. */
function chromeButton(className: string, icon: string, label: string, showLabel: boolean): HTMLButtonElement {
  const glyph = el("span", { className: "chrome-button__icon", attrs: { "aria-hidden": "true" } });
  glyph.innerHTML = icon;
  return el("button", { className: `chrome-button ${className}`, attrs: { type: "button", ...(showLabel ? {} : { "aria-label": label }), title: label } }, [
    glyph,
    ...(showLabel ? [el("span", { className: "chrome-button__label", text: label })] : [])
  ]);
}

export type AppShell = {
  /** Root element to mount into #app. */
  root: HTMLElement;
  /** Empty container the 3D renderer should be mounted into. */
  viewportContainer: HTMLElement;
  /** Re-checks every ribbon tool's enabled/active state - call after anything that could change one (e.g. PlacementController arming/disarming). */
  refreshRibbon: () => void;
  /** Re-checks the Assets tab's own card active-state, the same "call after anything that could change it" contract as refreshRibbon - see AssetLibrary.refresh()'s own docs. */
  refreshAssetLibrary: () => void;
  /** Shows/clears the status bar's pick-and-place banner and Cancel button - see PlacementController. */
  setPlacementStatus: (info: PlacementStatusInfo | null) => void;
  /** Which panels are open, and how big - see workspaceLayout.ts. */
  layout: LayoutStore;
  /** Opens the assistant drawer and puts the cursor in its input. */
  openAssistant: () => void;
  /** Closes the assistant drawer (the conversation is kept) and returns focus to its button. */
  closeAssistant: () => void;
};

/**
 * Builds the application shell and returns it along with an empty
 * container for the Three.js renderer. Contains no Three.js code -
 * SceneManager is mounted into `viewportContainer` from main.ts.
 *
 * Four stacked rows (one child per `.app-shell` grid row, in this order -
 * src/ui/verify.ts checks the two stay in step): the application bar
 * (menus, project, history, account), the tool bar (category tabs over the
 * chosen category's tool palette), the body, and the status bar. The body
 * is the workspace itself:
 *
 *   rail + project browser | viewport over the records dock | assistant | inspector
 *
 * Every panel but the viewport can be closed - the browser to its icon
 * rail, the inspector to a slim tab, the dock to its tab row, the
 * assistant to its round button over the viewport, the palette under its
 * category tabs - and the side panels and the dock resize by their edges.
 * Which panels are open and their sizes live in a LayoutStore
 * (workspaceLayout.ts), kept for the browser session; the viewport
 * reclaims whatever a closed panel gives up (SceneManager follows its
 * container's size). The shell is exactly one viewport tall: a panel
 * whose content is too tall scrolls inside itself.
 */
export function createAppShell(options: AppShellOptions): AppShell {
  const body = el("div", { className: "app-body" });
  const center = el("div", { className: "app-center" });
  const layout = createLayoutStore(options.layoutStorage ?? null, () => ({
    windowWidth: window.innerWidth,
    // Before the first layout the body has no width yet: the window's is the best guess.
    bodyWidth: body.clientWidth || window.innerWidth
  }));

  // --- Tool bar: category tabs over the tool palette ---
  const ribbonTabs = buildRibbonTabs(options.ribbonActions);
  const ribbonControl = createConstructionRibbon(ribbonTabs, "home");
  const ribbon = ribbonControl.element;
  ribbon.id = "tool-palette";
  const showCategory = (id: string): void => {
    ribbonControl.show(id);
    mainNav.setActive(id);
    layout.setOpen("ribbon", true);
  };
  const mainNav = createMainNav(
    ribbonTabs.map((tab) => ({ id: tab.id, label: tab.label })),
    (id, wasActive) => {
      if (wasActive) layout.toggle("ribbon");
      else showCategory(id);
    },
    "home",
    () => layout.toggle("ribbon")
  );
  const toolbar = el("div", { className: "app-toolbar" }, [mainNav.element, ribbon]);
  // Tools that need a selection (Paint) re-check whenever it - or the
  // selected object - may have changed.
  const refreshRibbon = (): void => ribbonControl.refresh();
  options.selectionStore.subscribe(refreshRibbon);
  options.elementStore.subscribe(refreshRibbon);
  options.wallStore.subscribe(refreshRibbon);

  // --- Left: the icon rail and the project browser ---
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
    options.elementStore,
    options.assetStore,
    options.visibilityStore,
    options.onFocusObjects,
    options.onAddAsset,
    options.ribbonActions.isPlacementActive,
    // The open tab again folds the browser to its rail; another tab opens it there.
    (_id, wasActive) => layout.setOpen("left", wasActive ? !layout.get().left.open : true)
  );
  const leftToggle = chromeButton("sidebar-rail__toggle", SHELL_ICONS.chevronLeft, "Hide the project browser", false);
  leftToggle.addEventListener("click", () => layout.toggle("left"));
  leftSidebar.rail.append(el("span", { className: "sidebar-rail__spacer" }), leftToggle);
  const showBrowserTab = (id: string): void => {
    leftSidebar.showTab(id);
    layout.setOpen("left", true);
  };

  // --- Right: the inspector, folding to a slim tab ---
  const inspectorCollapse = chromeButton("sidebar-tabs__collapse", SHELL_ICONS.chevronRight, "Hide the inspector", false);
  // Focus moves to the control that takes the hidden one's place, never dropping to the page.
  inspectorCollapse.addEventListener("click", () => {
    layout.setOpen("right", false);
    inspectorTab.focus();
  });
  const rightSidebar = createRightSidebar({
    wallStore: options.wallStore,
    pillarStore: options.pillarStore,
    beamStore: options.beamStore,
    slabStore: options.slabStore,
    doorStore: options.doorStore,
    windowStore: options.windowStore,
    elementStore: options.elementStore,
    assetStore: options.assetStore,
    selectionStore: options.selectionStore,
    commandExecutor: options.commandExecutor,
    onDuplicateSelected: options.onDuplicateSelected,
    onDeleteSelected: options.onDeleteSelected,
    onRoomEdit: options.onRoomEdit,
    headerExtras: [inspectorCollapse]
  });
  const inspectorTab = chromeButton("inspector-tab", SHELL_ICONS.sliders, "Inspector", true);
  inspectorTab.title = "Show the inspector - the selected object's properties and materials";
  inspectorTab.addEventListener("click", () => {
    layout.setOpen("right", true);
    if (!rightSidebar.hidden) inspectorCollapse.focus();
  });
  // Something selected while the inspector is folded away: the tab says so.
  options.selectionStore.subscribe((id) => inspectorTab.classList.toggle("has-selection", id !== null));
  const inspector = el("div", { className: "app-inspector" }, [inspectorTab, rightSidebar]);

  // --- The viewport, with its overlays ---
  const viewportContainer = el("div", { className: "viewport-container" });
  const viewControls = createViewControls(options.onViewChange, options.onFitToScene, options.onFocusSelected);
  const viewControlsOverlay = el("div", { className: "viewport-area__controls" }, [viewControls, createSnapToggle(options.snapSettings, options.viewportTools, options.workspaceControl ? [options.workspaceControl] : [])]);

  // --- The records dock under the viewport ---
  /** The dock tab on show - switched only when the layout names another, so its content (and focus in it) is never re-inserted needlessly. */
  let shownDockTab = "measurements";
  /** Whether the dock was open at the last render - folding it clears what its tab showed over the viewport. */
  let dockWasOpen = false;
  const commandBar = createCommandBar(
    options.ribbonActions.addWall,
    options.onSubmitAiInstruction,
    options.onFocusObjects,
    (objectId) => options.selectionStore.select(objectId),
    options.onUndo,
    options.onSaveProject,
    // Fresh snapshot on every call (never cached) - the same
    // buildAIProjectSnapshot() the AI layer itself reads the project
    // through (see ai/types.ts), so the Construction Method tab classifies
    // the actual current objects, never a duplicate object model.
    () =>
      buildAIProjectSnapshot({
        wallStore: options.wallStore,
        pillarStore: options.pillarStore,
        beamStore: options.beamStore,
        slabStore: options.slabStore,
        doorStore: options.doorStore,
        windowStore: options.windowStore,
        elementStore: options.elementStore,
        assetStore: options.assetStore,
        assemblyStore: options.assemblyStore,
        selectionStore: options.selectionStore
      }).objects,
    () => options.projectMeta.get().id,
    options.onHighlightConstructionObjects,
    options.onFocusPoint,
    // A tab opens the dock on it - never closes it (its chevron and View ▸ Records dock do), so a second click is harmless.
    (id) => {
      shownDockTab = id; // the strip has switched already
      layout.setDockTab(id);
      layout.setOpen("dock", true);
    }
  );
  const dockToggle = chromeButton("command-bar__toggle", SHELL_ICONS.chevronUp, "Show the records dock", false);
  dockToggle.addEventListener("click", () => layout.toggle("dock"));
  commandBar.tabs.append(el("span", { className: "command-bar__spacer" }), dockToggle);
  const showDockTab = (id: string): void => {
    layout.setDockTab(id);
    layout.setOpen("dock", true);
  };
  const centerSize = (): number => center.clientHeight || window.innerHeight * 0.6;
  const dockSplitter = createSplitter({
    edge: "top",
    label: "Resize the records dock",
    // The height on screen (a shorter window clamps the stored one) - so a drag moves the edge at once - and the same ceiling.
    getSize: () => shownDockHeight(layout.get().dock.height, centerSize()),
    setSize: (size) => layout.setSize("dock", Math.min(size, dockCeiling(centerSize()))),
    min: DOCK_HEIGHT.min,
    max: () => dockCeiling(centerSize())
  });
  commandBar.element.prepend(dockSplitter);

  // --- The assistant: a drawer beside the inspector, opened from a round button over the viewport ---
  const assistantFab = chromeButton("assistant-fab", SHELL_ICONS.spark, "Open the EAVARA Architect assistant", false);
  assistantFab.setAttribute("aria-controls", "assistant-drawer");
  const assistantDrawer = el("section", { className: "assistant-drawer", attrs: { id: "assistant-drawer", "aria-label": "EAVARA Architect assistant" } });
  let repliesSeen = 0;
  let latestActivity: ArchitectActivity | null = null;
  // A reply that arrives while the drawer is closed is announced here (the drawer's own live regions are hidden with it).
  const assistantNews = el("span", { className: "visually-hidden", attrs: { role: "status", "aria-live": "polite" } });
  const labelFab = (): void => {
    const busy = assistantFab.classList.contains("is-busy");
    const unread = assistantFab.classList.contains("has-unread");
    const state = latestActivity?.state;
    const label = `Open the EAVARA Architect assistant${unread ? " - new reply" : busy && state ? ` - ${COMPANION_STATE_LABEL[state].toLowerCase()}` : ""}`;
    assistantFab.setAttribute("aria-label", label);
    assistantFab.title = label;
  };
  const openAssistant = (): void => {
    layout.setOpen("assistant", true);
    options.architect?.focusInput();
  };
  const closeAssistant = (): void => {
    layout.setOpen("assistant", false);
    assistantFab.focus();
  };
  assistantFab.addEventListener("click", openAssistant);
  if (options.architect) {
    assistantDrawer.append(
      createSplitter({
        edge: "left",
        label: "Resize the assistant",
        getSize: () => layout.get().assistant.width,
        setSize: (size) => layout.setSize("assistant", size),
        min: PANEL_WIDTHS.assistant.min,
        max: PANEL_WIDTHS.assistant.max
      }),
      options.architect.element
    );
    // The button says when the assistant is working, or has answered while closed.
    options.architect.subscribeActivity?.((activity) => {
      if (!latestActivity) repliesSeen = activity.replies; // the greeting is not news
      const newReply = latestActivity !== null && activity.replies > latestActivity.replies;
      latestActivity = activity;
      const open = layout.get().assistant.open;
      if (open) repliesSeen = activity.replies;
      assistantFab.dataset.state = activity.state;
      assistantFab.classList.toggle("is-busy", ["thinking", "listening", "speaking", "waiting"].includes(activity.state));
      assistantFab.classList.toggle("has-unread", activity.replies > repliesSeen);
      labelFab();
      if (!open && newReply) assistantNews.textContent = "The EAVARA Architect replied - open the assistant to read it.";
    });
  } else {
    assistantFab.hidden = true;
  }

  // The viewport's own "nothing built yet" state - a quiet call to action
  // over the grid, not a splash screen. Its own panel captures clicks
  // (pointer-events) so the grid behind it stays orbitable.
  const emptyState = buildEmptyState(
    options,
    options.architect
      ? openAssistant
      : () => {
          showDockTab("ai-prompt");
          commandBar.focusAiInput();
        }
  );
  const updateEmptyState = (): void => {
    emptyState.hidden = !isProjectEmpty(options);
  };
  updateEmptyState();
  // The Measurements record book follows the scene - coalesced to one
  // rebuild per frame, since a build stage changes dozens of objects.
  let recordRefreshQueued = false;
  const refreshRecordBook = (): void => {
    if (recordRefreshQueued) return;
    recordRefreshQueued = true;
    requestAnimationFrame(() => {
      recordRefreshQueued = false;
      commandBar.refreshRecordBook();
    });
  };
  for (const store of [
    options.wallStore,
    options.pillarStore,
    options.beamStore,
    options.slabStore,
    options.doorStore,
    options.windowStore,
    options.elementStore,
    options.assetStore
  ]) {
    store.subscribe(updateEmptyState);
    store.subscribe(refreshRecordBook);
  }

  const viewportArea = el("main", { className: "viewport-area", attrs: { "aria-label": "3D workspace" } }, [
    viewportContainer,
    viewControlsOverlay,
    ...(options.viewportOverlays ?? []),
    emptyState,
    assistantFab,
    assistantNews
  ]);
  center.append(viewportArea, commandBar.element);

  // The project browser's and inspector's resize handles, on their inner edges.
  leftSidebar.element.append(
    createSplitter({ edge: "right", label: "Resize the project browser", getSize: () => layout.get().left.width, setSize: (size) => layout.setSize("left", size), min: PANEL_WIDTHS.left.min, max: PANEL_WIDTHS.left.max })
  );
  rightSidebar.append(
    createSplitter({ edge: "left", label: "Resize the inspector", getSize: () => layout.get().right.width, setSize: (size) => layout.setSize("right", size), min: PANEL_WIDTHS.right.min, max: PANEL_WIDTHS.right.max })
  );
  body.append(leftSidebar.element, center, assistantDrawer, inspector);

  // --- Menus ---
  const hasSelection = (): boolean => options.selectionStore.get() !== null;
  const needsSelection = "Select an object first - in the viewport or the Project browser";
  const panelItem = (panel: SidePanelId | "dock" | "ribbon", label: string, title: string): MenuItem => ({
    kind: "check",
    label,
    title,
    isChecked: () => layout.get()[panel].open,
    run: () => (panel === "assistant" ? (layout.get().assistant.open ? closeAssistant() : openAssistant()) : layout.toggle(panel))
  });
  const fileMenu = createMenu({
    label: "File",
    items: () => [
      { label: "New project", run: options.onNewProject, isEnabled: () => !options.persistence.isBusy(), title: "Start an empty project - you're asked first if this one has unsaved work" },
      { label: "Open…", run: options.onOpenProject, isEnabled: () => !options.persistence.isBusy(), title: "Open a saved project" },
      { label: "Save", run: options.onSaveProject, isEnabled: () => !options.persistence.isBusy(), title: "Save this project" },
      { kind: "separator" },
      { label: "Export record book (CSV)", run: () => commandBar.exportRecordBook(), title: "Download the construction record book - every element with its dimensions - as a spreadsheet file" }
    ]
  });
  const editMenu = createMenu({
    label: "Edit",
    items: () => [
      { label: "Undo", run: options.onUndo, isEnabled: () => options.history.canUndo(), disabledTitle: "Nothing to undo" },
      { label: "Redo", run: options.onRedo, isEnabled: () => options.history.canRedo(), disabledTitle: "Nothing to redo" },
      { kind: "separator" },
      { label: "Duplicate selected", run: options.onDuplicateSelected, isEnabled: hasSelection, disabledTitle: needsSelection },
      { label: "Delete selected", run: options.onDeleteSelected, isEnabled: hasSelection, disabledTitle: needsSelection },
      { label: "Clear selection", run: () => options.selectionStore.clear(), isEnabled: hasSelection, disabledTitle: "Nothing is selected" }
    ]
  });
  const viewMenu = createMenu({
    label: "View",
    items: () => [
      { label: "Perspective", run: () => options.onViewChange("perspective") },
      { label: "Top", run: () => options.onViewChange("top") },
      { label: "Front", run: () => options.onViewChange("front") },
      { label: "Side", run: () => options.onViewChange("side") },
      { kind: "separator" },
      { label: "Fit house", run: options.onFitToScene, title: "Frame everything that's built" },
      { label: "Focus selected", run: options.onFocusSelected, isEnabled: hasSelection, disabledTitle: needsSelection },
      ...(options.interiorExplore
        ? [{ kind: "check" as const, label: "Interior Explore", isChecked: () => options.interiorExplore?.isActive() ?? false, run: () => options.interiorExplore?.toggle(), title: "Walk through the rooms at eye height" }]
        : []),
      { kind: "separator" },
      panelItem("left", "Project browser", "The project tree, assemblies and the furniture library"),
      panelItem("right", "Inspector", "The selected object's properties and materials"),
      ...(options.architect ? [panelItem("assistant", "AI assistant", "The EAVARA Architect conversation")] : []),
      panelItem("dock", "Records dock", "Measurements, construction method, manual build and AI prompt"),
      panelItem("ribbon", "Tool palette", "The chosen category's tools under the category tabs"),
      ...(options.theme
        ? [{ kind: "separator" as const }, { kind: "check" as const, label: "Dark theme", isChecked: () => options.theme?.get() === "dark", run: () => options.theme?.toggle() }]
        : [])
    ]
  });
  const buildMenu = createMenu({
    label: "Build",
    items: () => [
      ...ribbonTabs.map((tab): MenuItem => ({ kind: "check", label: tab.label, isChecked: () => ribbon.dataset.category === tab.id && layout.get().ribbon.open, run: () => showCategory(tab.id), title: `Show the ${tab.label} tools` })),
      { kind: "separator" },
      { label: "Furniture library", run: () => showBrowserTab("assets"), title: "Pick and place furniture and fittings" },
      { label: "Assemblies", run: () => showBrowserTab("assemblies"), title: "Group objects into assemblies" },
      ...(options.architect ? [{ label: "Ask the Architect…", run: openAssistant, title: "Describe a site, a house or a change in words" }] : []),
      { label: "Records dock", run: () => showDockTab("measurements"), title: "The construction record book, method and manual build" }
    ]
  });
  const menuBar = createMenuBar([fileMenu, editMenu, viewMenu, buildMenu], "Application");

  const topBar = createTopBar({
    // The top bar's search drives the Project browser's own search.
    onSearch: (query) => {
      if (query.trim()) layout.setOpen("left", true);
      leftSidebar.searchProject(query);
    },
    onSearchPick: () => leftSidebar.pickFirstSearchResult(),
    theme: options.theme,
    projectMeta: options.projectMeta,
    persistence: options.persistence,
    auth: options.auth,
    onSaveProject: options.onSaveProject,
    onSignIn: options.onSignIn,
    onSignOut: options.onSignOut,
    onUndo: options.onUndo,
    onRedo: options.onRedo,
    history: options.history,
    menuBar
  });

  const statusBar = createStatusBar({ projectMeta: options.projectMeta, selectionStore: options.selectionStore, workspace: options.workspace });

  const root = el("div", { className: "app-shell" }, [topBar, toolbar, body, statusBar.element]);

  // --- Rendering the layout ---
  const render = (state: WorkspaceLayout): void => {
    const compact = isCompact(window.innerWidth);
    const columns = columnWidths(state);
    body.classList.toggle("is-compact", compact);
    // Compact: the open panels draw over the viewport, so their columns keep only the rail and the tab.
    body.style.setProperty("--col-left", `${compact ? RAIL_WIDTH : columns.left}px`);
    body.style.setProperty("--col-assistant", `${compact ? 0 : columns.assistant}px`);
    body.style.setProperty("--col-right", `${compact && state.right.open ? 0 : columns.right}px`);
    body.style.setProperty("--left-width", `${state.left.width}px`);
    body.style.setProperty("--right-width", `${state.right.width}px`);
    body.style.setProperty("--assistant-width", `${state.assistant.width}px`);
    // The palette first: it changes the centre's height, which the dock's clamp reads.
    toolbar.classList.toggle("is-palette-closed", !state.ribbon.open);
    mainNav.setPaletteOpen(state.ribbon.open);
    center.style.setProperty("--dock-height", `${shownDockHeight(state.dock.height, centerSize())}px`);

    leftSidebar.element.classList.toggle("is-collapsed", !state.left.open);
    leftToggle.innerHTML = "";
    const leftIcon = el("span", { className: "chrome-button__icon", attrs: { "aria-hidden": "true" } });
    leftIcon.innerHTML = state.left.open ? SHELL_ICONS.chevronLeft : SHELL_ICONS.chevronRight;
    leftToggle.append(leftIcon);
    const leftLabel = state.left.open ? "Hide the project browser" : "Show the project browser";
    leftToggle.title = leftLabel;
    leftToggle.setAttribute("aria-label", leftLabel);
    leftToggle.setAttribute("aria-expanded", String(state.left.open));
    for (const item of leftSidebar.rail.querySelectorAll<HTMLElement>(".sidebar-rail__item")) {
      item.setAttribute("aria-expanded", String(state.left.open));
    }

    inspector.classList.toggle("is-collapsed", !state.right.open);
    rightSidebar.hidden = !state.right.open;
    inspectorTab.hidden = state.right.open;
    inspectorTab.setAttribute("aria-expanded", String(state.right.open));

    assistantDrawer.hidden = !state.assistant.open;
    assistantFab.hidden = !options.architect || state.assistant.open;
    assistantFab.setAttribute("aria-expanded", String(state.assistant.open));
    if (state.assistant.open && latestActivity) {
      repliesSeen = latestActivity.replies;
      assistantFab.classList.remove("has-unread");
      assistantNews.textContent = "";
      labelFab();
    }

    commandBar.element.classList.toggle("is-collapsed", !state.dock.open);
    if (dockWasOpen && !state.dock.open) commandBar.dockClosed();
    dockWasOpen = state.dock.open;
    if (state.dock.tab !== shownDockTab) {
      shownDockTab = state.dock.tab;
      commandBar.showTab(shownDockTab);
    }
    const dockIcon = el("span", { className: "chrome-button__icon", attrs: { "aria-hidden": "true" } });
    dockIcon.innerHTML = state.dock.open ? SHELL_ICONS.chevronDown : SHELL_ICONS.chevronUp;
    dockToggle.replaceChildren(dockIcon);
    const dockLabel = state.dock.open ? "Hide the records dock" : "Show the records dock";
    dockToggle.title = dockLabel;
    dockToggle.setAttribute("aria-label", dockLabel);
    dockToggle.setAttribute("aria-expanded", String(state.dock.open));
    dockSplitter.hidden = !state.dock.open;

  };
  layout.subscribe(render);
  // Once mounted (main.ts appends the root right after this returns), fit the panels to the body's real width.
  requestAnimationFrame(() => {
    layout.fit(body.clientWidth);
    render(layout.get());
  });
  // A narrower window may leave the viewport too little room: close panels (or, compact, draw them over it).
  window.addEventListener("resize", () => {
    layout.fit(body.clientWidth);
    render(layout.get());
  });
  // Escape closes a panel drawn over the viewport on a compact window (the browser, inspector or assistant).
  body.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !body.classList.contains("is-compact")) return;
    const target = event.target as HTMLElement;
    const panel = target.closest(".sidebar--left .tab-strip__panel") ? "left" : target.closest(".sidebar--right") ? "right" : target.closest(".assistant-drawer") ? "assistant" : null;
    if (panel && layout.get()[panel].open) {
      event.stopPropagation(); // closing the overlay is all this Escape does - not a placement disarm or an Interior Explore exit too
      if (panel === "assistant") {
        closeAssistant(); // focus back on the assistant's button
      } else {
        layout.setOpen(panel, false);
        (panel === "left" ? leftToggle : inspectorTab).focus();
      }
    }
  });

  return {
    root,
    viewportContainer,
    refreshRibbon,
    refreshAssetLibrary: leftSidebar.refreshAssetLibrary,
    setPlacementStatus: statusBar.setPlacementStatus,
    layout,
    openAssistant,
    closeAssistant
  };
}
