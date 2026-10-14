import { el } from "./dom";
import { DEFAULT_WORKSPACE, formatSpacing } from "../engine/workspace/workspaceSettings";
import type { WorkspaceState } from "../engine/workspace/workspaceSettings";
import type { SelectionStore } from "../engine/selection/SelectionStore";
import type { ProjectMetaStore } from "../engine/project/ProjectMetaStore";

export type StatusBarOptions = {
  projectMeta: ProjectMetaStore;
  selectionStore: SelectionStore;
  /** The workspace's grid spacing and snapping, shown live (engine/workspace/workspaceSettings.ts). */
  workspace?: { subscribe(listener: (state: WorkspaceState) => void): () => void };
};

/** One armed placement tool's label plus a way to end it - see PlacementController.disarm(). */
export interface PlacementStatusInfo {
  label: string;
  onCancel: () => void;
  /** Replaces the "click to place" sentence - for a tool that doesn't place anything (Measure). */
  text?: string;
}

export interface StatusBar {
  element: HTMLElement;
  /** Shows the pick-and-place banner and its Cancel button, or clears it (null) when nothing is armed - see PlacementController. */
  setPlacementStatus(info: PlacementStatusInfo | null): void;
}

function statusItem(label: string, value: string): HTMLElement {
  return el("span", { className: "status-bar__item" }, [
    el("span", { className: "status-bar__item-label", text: `${label}:` }),
    el("span", { className: "status-bar__item-value", text: value })
  ]);
}

/**
 * Bottom status bar. Mostly read-only informational text, not
 * interactive controls, so it's not subject to the "no decorative
 * controls that do nothing" rule the way a button would be - each
 * value here is either genuinely reactive (state) or an honest static
 * fact about the current engine/scene (units), never a fabricated one:
 *   - state: reflects selectionStore, so it's real.
 *   - project: reflects projectMeta, so it follows renames and opens.
 *   - grid: the workspace's minor grid spacing, live (the same value
 *     ground.ts draws - engine/workspace/workspaceSettings.ts).
 *   - snap: the workspace's snap step - the increment drags move by and
 *     the grid points snap to - or Off, live.
 *   - zoom: a static placeholder (no camera-distance plumbing added in
 *     this UI-focused milestone) - documented as a known limitation.
 *
 * Also shows the pick-and-place state (set by setPlacementStatus(), from
 * main.ts's PlacementController subscription) in the same state slot -
 * "Placement mode: Wall — click to place, Esc or Cancel to exit" replaces
 * "Ready"/"N selected" while a tool is armed, together with a real Cancel
 * button (wired to PlacementController.disarm()) so leaving placement
 * mode is never Escape-or-nothing. The selection text returns the moment
 * it's disarmed, by any of the three ways: Escape, this button, or
 * clicking the same ribbon tool again.
 */
export function createStatusBar(options: StatusBarOptions): StatusBar {
  const stateText = el("span", { className: "status-bar__state-text", text: "Ready" });
  const cancelButton = el("button", { className: "status-bar__cancel", text: "Cancel", attrs: { type: "button", title: "Exit placement mode" } });
  cancelButton.hidden = true;

  const state = el("span", { className: "status-bar__item status-bar__item--state" }, [
    el("span", { className: "status-bar__dot" }),
    stateText,
    cancelButton
  ]);

  const projectItem = statusItem("Project", options.projectMeta.get().name);
  // Live: the workspace's snap step (or Off) and minor grid spacing.
  const snapItem = statusItem("Snap", `${formatSpacing(DEFAULT_WORKSPACE.snapStep)}`);
  const gridItem = statusItem("Grid", `${formatSpacing(DEFAULT_WORKSPACE.gridSpacing)}`);
  options.workspace?.subscribe((state) => {
    snapItem.querySelector(".status-bar__item-value")!.textContent = state.snapping ? formatSpacing(state.snapStep) : "Off";
    gridItem.querySelector(".status-bar__item-value")!.textContent = formatSpacing(state.gridSpacing);
  });

  const bar = el("footer", { className: "status-bar" }, [
    state,
    projectItem,
    statusItem("Units", "Meters"),
    snapItem,
    gridItem,
    statusItem("Zoom", "100%")
  ]);

  let placementInfo: PlacementStatusInfo | null = null;
  const renderState = (): void => {
    if (placementInfo) {
      stateText.textContent = placementInfo.text
        ? `${placementInfo.text} Esc or Cancel to exit.`
        : `Placement mode: ${placementInfo.label} — click to place, Esc or Cancel to exit`;
      state.classList.add("status-bar__item--placing");
      cancelButton.hidden = false;
      return;
    }
    state.classList.remove("status-bar__item--placing");
    cancelButton.hidden = true;
    stateText.textContent = options.selectionStore.get() ? "1 object selected" : "Ready";
  };
  cancelButton.addEventListener("click", () => placementInfo?.onCancel());
  options.selectionStore.subscribe(renderState);

  const projectName = projectItem.querySelector(".status-bar__item-value") as HTMLElement;
  options.projectMeta.subscribe((meta) => {
    projectName.textContent = meta.name;
  });

  return {
    element: bar,
    setPlacementStatus(info: PlacementStatusInfo | null): void {
      placementInfo = info;
      renderState();
    }
  };
}
