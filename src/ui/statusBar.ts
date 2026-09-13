import { el } from "./dom";
import { GROUND_SIZE, GRID_DIVISIONS } from "../scene/ground";
import { MOVE_STEP } from "../engine/manipulation/manipulationMath";
import type { SelectionStore } from "../engine/selection/SelectionStore";
import type { ProjectMetaStore } from "../engine/project/ProjectMetaStore";

export type StatusBarOptions = {
  projectMeta: ProjectMetaStore;
  selectionStore: SelectionStore;
};

/** One armed placement tool's label plus a way to end it - see PlacementController.disarm(). */
export interface PlacementStatusInfo {
  label: string;
  onCancel: () => void;
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
 * fact about the current engine/scene (units/snap/grid), never a
 * fabricated one:
 *   - state: reflects selectionStore, so it's real.
 *   - project: reflects projectMeta, so it follows renames and opens.
 *   - grid: derived from ground.ts's actual GridHelper spacing, not a
 *     guessed number.
 *   - snap: the increment mouse moves and resizes change by - see
 *     MOVE_STEP/RESIZE_STEP in engine/manipulation/manipulationMath.ts.
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

  const gridSize = GROUND_SIZE / GRID_DIVISIONS;
  const projectItem = statusItem("Project", options.projectMeta.get().name);

  const bar = el("footer", { className: "status-bar" }, [
    state,
    projectItem,
    statusItem("Units", "Meters"),
    statusItem("Snap", `${MOVE_STEP} m`),
    statusItem("Grid", `${gridSize.toFixed(1)} m`),
    statusItem("Zoom", "100%")
  ]);

  let placementInfo: PlacementStatusInfo | null = null;
  const renderState = (): void => {
    if (placementInfo) {
      stateText.textContent = `Placement mode: ${placementInfo.label} — click to place, Esc or Cancel to exit`;
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
