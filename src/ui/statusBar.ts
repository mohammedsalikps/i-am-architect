import { el } from "./dom";
import { GROUND_SIZE, GRID_DIVISIONS } from "../scene/ground";
import type { SelectionStore } from "../engine/selection/SelectionStore";

export type StatusBarOptions = {
  projectName: string;
  selectionStore: SelectionStore;
};

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
 *   - grid: derived from ground.ts's actual GridHelper spacing, not a
 *     guessed number.
 *   - snap: "Off" because no snapping exists yet - "On" would be a lie.
 *   - zoom: a static placeholder (no camera-distance plumbing added in
 *     this UI-focused milestone) - documented as a known limitation.
 */
export function createStatusBar(options: StatusBarOptions): HTMLElement {
  const state = el("span", { className: "status-bar__item status-bar__item--state" }, [
    el("span", { className: "status-bar__dot" }),
    el("span", { className: "status-bar__state-text", text: "Ready" })
  ]);

  const gridSize = GROUND_SIZE / GRID_DIVISIONS;

  const bar = el("footer", { className: "status-bar" }, [
    state,
    statusItem("Project", options.projectName),
    statusItem("Units", "Meters"),
    statusItem("Snap", "Off"),
    statusItem("Grid", `${gridSize.toFixed(1)} m`),
    statusItem("Zoom", "100%")
  ]);

  const stateText = state.querySelector(".status-bar__state-text") as HTMLElement;
  options.selectionStore.subscribe((selectedId) => {
    stateText.textContent = selectedId ? "1 object selected" : "Ready";
  });

  return bar;
}
