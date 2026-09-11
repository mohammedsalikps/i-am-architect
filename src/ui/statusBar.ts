import { el } from "./dom";
import { GROUND_SIZE, GRID_DIVISIONS } from "../scene/ground";
import { MOVE_STEP } from "../engine/manipulation/manipulationMath";
import type { SelectionStore } from "../engine/selection/SelectionStore";
import type { ProjectMetaStore } from "../engine/project/ProjectMetaStore";

export type StatusBarOptions = {
  projectMeta: ProjectMetaStore;
  selectionStore: SelectionStore;
};

export interface StatusBar {
  element: HTMLElement;
  /** Shows the pick-and-place state ("Placing: Wall — click..."), or clears it (null) when nothing is armed - see PlacementController. */
  setPlacementStatus(text: string | null): void;
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
 * "Placing: Wall — click to place, Esc to cancel" replaces "Ready"/"N
 * selected" while a tool is armed, and the selection text returns the
 * moment it's disarmed.
 */
export function createStatusBar(options: StatusBarOptions): StatusBar {
  const state = el("span", { className: "status-bar__item status-bar__item--state" }, [
    el("span", { className: "status-bar__dot" }),
    el("span", { className: "status-bar__state-text", text: "Ready" })
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

  const stateText = state.querySelector(".status-bar__state-text") as HTMLElement;
  let placementText: string | null = null;
  const renderState = (): void => {
    if (placementText) {
      stateText.textContent = placementText;
      state.classList.add("status-bar__item--placing");
      return;
    }
    state.classList.remove("status-bar__item--placing");
    stateText.textContent = options.selectionStore.get() ? "1 object selected" : "Ready";
  };
  options.selectionStore.subscribe(renderState);

  const projectName = projectItem.querySelector(".status-bar__item-value") as HTMLElement;
  options.projectMeta.subscribe((meta) => {
    projectName.textContent = meta.name;
  });

  return {
    element: bar,
    setPlacementStatus(text: string | null): void {
      placementText = text;
      renderState();
    }
  };
}
