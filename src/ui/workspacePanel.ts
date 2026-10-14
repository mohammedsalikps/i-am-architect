import { el } from "./dom";
import { formatSpacing, GRID_SPACINGS, SNAP_STEPS, type WorkspaceState } from "../engine/workspace/workspaceSettings";

/** What the panel changes - WorkspaceSettings (engine/workspace/workspaceSettings.ts). */
export interface WorkspacePanelSettings {
  get(): WorkspaceState;
  subscribe(listener: (state: WorkspaceState) => void): () => void;
  setGridSpacing(metres: number): string | null;
  setSnapping(on: boolean): void;
  setSnapStep(metres: number): string | null;
  setShowAxes(on: boolean): void;
  setShowDimensions(on: boolean): void;
}

export interface WorkspacePanelOptions {
  settings: WorkspacePanelSettings;
  /**
   * Lays out (or resizes) the plot - the site, a real model element - the
   * same way "set the plot to 30 by 40 metres" does (ArchitectSession.setPlot):
   * one undo step, validated, never rescaling anything already built.
   */
  onSetPlot?: (length: number, width: number) => { ok: boolean; message: string };
}

export interface WorkspacePanel {
  /** The "Grid & plot" button and its popover, for the viewport's Snap row. */
  element: HTMLElement;
  /** The current plot (length east-west, width north-south) - or null - shown in the plot fields. */
  setPlot(plot: { length: number; width: number } | null): void;
  /** "Dimensions shown: 1 room, 4 walls." - from the dimension layer. */
  setDimensionSummary(text: string): void;
}

/** The plot size the milestone brief asks for: 30 m east-west by 40 m north-south. */
export const PLOT_PRESET = { length: 30, width: 40 } as const;

function select(label: string, values: readonly number[], onChange: (value: number) => void): { row: HTMLElement; input: HTMLSelectElement } {
  const input = el("select", { className: "workspace-panel__select", attrs: { "aria-label": label } });
  for (const value of values) {
    input.append(el("option", { text: formatSpacing(value), attrs: { value: String(value) } }));
  }
  input.addEventListener("change", () => onChange(Number(input.value)));
  return { row: el("label", { className: "workspace-panel__row" }, [el("span", { text: label }), input]), input };
}

function checkbox(label: string, onChange: (on: boolean) => void): { row: HTMLElement; input: HTMLInputElement } {
  const input = el("input", { attrs: { type: "checkbox" } });
  input.addEventListener("change", () => onChange(input.checked));
  return { row: el("label", { className: "workspace-panel__check" }, [input, el("span", { text: label })]), input };
}

function numberField(label: string): { row: HTMLElement; input: HTMLInputElement } {
  const input = el("input", { className: "workspace-panel__number", attrs: { type: "number", min: "6", max: "200", step: "0.5", "aria-label": label } });
  return { row: el("label", { className: "workspace-panel__row" }, [el("span", { text: label }), input]), input };
}

/**
 * The workspace's "Grid & plot" controls, in a popover by the Snap button:
 * the plot (the site's size - a model change, undoable), and the view
 * settings that are never part of the model - grid spacing, snapping and
 * its step, the axes and the dimension labels. Every control is live and
 * goes through the same WorkspaceSettings / ArchitectSession paths the
 * conversation uses, so a value said aloud and a value picked here can
 * never disagree.
 */
export function createWorkspacePanel(options: WorkspacePanelOptions): WorkspacePanel {
  const { settings } = options;
  const panelId = "workspace-panel";
  const button = el("button", {
    className: "view-controls__button workspace-panel__toggle",
    text: "Grid & plot",
    attrs: { type: "button", "aria-expanded": "false", "aria-controls": panelId, title: "Plot size, grid spacing, snapping, axes and dimension labels" }
  });

  const note = el("p", { className: "workspace-panel__note", attrs: { role: "status", "aria-live": "polite" } });
  const length = numberField("Plot length X (m)");
  const width = numberField("Plot width Z (m)");
  const apply = el("button", { className: "toolbar-button workspace-panel__apply", text: "Apply plot", attrs: { type: "button" } });
  const preset = el("button", { className: "toolbar-button", text: `${PLOT_PRESET.length} × ${PLOT_PRESET.width} m`, attrs: { type: "button", title: "Set the plot to 30 m (east-west) by 40 m (north-south)" } });
  const setPlot = (plotLength: number, plotWidth: number): void => {
    if (!options.onSetPlot) return;
    if (!Number.isFinite(plotLength) || !Number.isFinite(plotWidth) || plotLength <= 0 || plotWidth <= 0) {
      note.textContent = "Give the plot a length and a width in metres.";
      note.dataset.tone = "error";
      return;
    }
    const result = options.onSetPlot(plotLength, plotWidth);
    note.textContent = result.message;
    note.dataset.tone = result.ok ? "success" : "error";
  };
  apply.addEventListener("click", () => setPlot(Number(length.input.value), Number(width.input.value)));
  preset.addEventListener("click", () => setPlot(PLOT_PRESET.length, PLOT_PRESET.width));
  const plotSection = options.onSetPlot
    ? [el("h4", { className: "workspace-panel__heading", text: "Plot" }), length.row, width.row, el("div", { className: "workspace-panel__actions" }, [apply, preset])]
    : [];

  const grid = select("Grid spacing", GRID_SPACINGS, (value) => {
    const problem = settings.setGridSpacing(value);
    if (problem) note.textContent = problem;
  });
  const snapping = checkbox("Snap while dragging", (on) => settings.setSnapping(on));
  const step = select("Snap every", SNAP_STEPS, (value) => {
    const problem = settings.setSnapStep(value);
    if (problem) note.textContent = problem;
  });
  const axes = checkbox("Axes and origin", (on) => settings.setShowAxes(on));
  const dimensions = checkbox("Dimension labels", (on) => settings.setShowDimensions(on));
  const summary = el("p", { className: "workspace-panel__summary", attrs: { "data-dimension-summary": "" } });

  const panel = el(
    "div",
    { className: "workspace-panel", attrs: { id: panelId, role: "dialog", "aria-label": "Grid and plot" } },
    [
      el("p", { className: "workspace-panel__convention", text: "X runs east, Z south (the plan's Y), Y up. 0, 0 is the world centre. Metres." }),
      ...plotSection,
      el("h4", { className: "workspace-panel__heading", text: "Grid and snapping" }),
      grid.row,
      snapping.row,
      step.row,
      el("h4", { className: "workspace-panel__heading", text: "Show" }),
      axes.row,
      dimensions.row,
      summary,
      note
    ]
  );
  panel.hidden = true;

  settings.subscribe((state) => {
    grid.input.value = String(state.gridSpacing);
    // A value off the list (an older or spoken setting) still shows as itself.
    if (grid.input.value !== String(state.gridSpacing)) {
      grid.input.append(el("option", { text: formatSpacing(state.gridSpacing), attrs: { value: String(state.gridSpacing) } }));
      grid.input.value = String(state.gridSpacing);
    }
    snapping.input.checked = state.snapping;
    step.input.value = String(state.snapStep);
    if (step.input.value !== String(state.snapStep)) {
      step.input.append(el("option", { text: formatSpacing(state.snapStep), attrs: { value: String(state.snapStep) } }));
      step.input.value = String(state.snapStep);
    }
    step.input.disabled = !state.snapping;
    axes.input.checked = state.showAxes;
    dimensions.input.checked = state.showDimensions;
  });

  const open = (next: boolean): void => {
    panel.hidden = !next;
    button.setAttribute("aria-expanded", String(next));
    button.classList.toggle("is-active", next);
    if (next) note.textContent = "";
  };
  button.addEventListener("click", () => open(panel.hidden));
  panel.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      open(false);
      button.focus();
    }
  });
  document.addEventListener("pointerdown", (event) => {
    if (!panel.hidden && !element.contains(event.target as Node)) open(false);
  });

  const element = el("div", { className: "workspace-control" }, [button, panel]);
  return {
    element,
    setPlot(plot) {
      // Never overwrite what the user is typing.
      if (panel.contains(document.activeElement) && (document.activeElement === length.input || document.activeElement === width.input)) return;
      length.input.value = plot ? String(Number(plot.length.toFixed(3))) : "";
      width.input.value = plot ? String(Number(plot.width.toFixed(3))) : "";
      length.input.placeholder = plot ? "" : "e.g. 30";
      width.input.placeholder = plot ? "" : "e.g. 40";
    },
    setDimensionSummary(text) {
      summary.textContent = text;
    }
  };
}
