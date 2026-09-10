import { el } from "./dom";
import type { HistoryManager } from "../engine/history/HistoryManager";

export type TopBarOptions = {
  projectName: string;
  onNewProject: () => void;
  onUndo: () => void;
  onRedo: () => void;
  history: HistoryManager;
};

/**
 * Title bar: branding, a quick-access cluster (New Project/Save/Undo/
 * Redo - the same document-level actions the old header exposed,
 * relocated here), the project name, a search field, and a
 * notifications/settings/profile icon cluster.
 *
 * "New Project" empties the in-memory model (see main.ts's newProject).
 * "Save" is disabled - there is no persistence yet - as are search and
 * the icon cluster (styled-but-inert, the same pattern already used for
 * the AI command input) rather than clickable no-ops.
 */
export function createTopBar(options: TopBarOptions): HTMLElement {
  const branding = el("div", { className: "app-header__brand" }, [
    el("span", { className: "app-header__brand-mark", text: "iA" }),
    el("span", { className: "app-header__brand-name", text: "iArchitect" })
  ]);

  const undoButton = el("button", {
    className: "toolbar-button toolbar-button--icon",
    text: "Undo",
    attrs: { type: "button" }
  });
  undoButton.addEventListener("click", options.onUndo);

  const redoButton = el("button", {
    className: "toolbar-button toolbar-button--icon",
    text: "Redo",
    attrs: { type: "button" }
  });
  redoButton.addEventListener("click", options.onRedo);

  options.history.subscribe(() => {
    undoButton.disabled = !options.history.canUndo();
    redoButton.disabled = !options.history.canRedo();
  });

  const newProjectButton = el("button", { className: "toolbar-button", text: "New Project", attrs: { type: "button" } });
  newProjectButton.addEventListener("click", options.onNewProject);

  const quickAccess = el("div", { className: "app-header__actions" }, [
    newProjectButton,
    el("button", {
      className: "toolbar-button",
      text: "Save",
      attrs: { type: "button", disabled: "true", title: "Coming soon" }
    }),
    undoButton,
    redoButton
  ]);

  const projectArea = el("div", { className: "app-header__project" }, [
    el("span", { className: "app-header__project-label", text: "Project" }),
    el("span", { className: "app-header__project-name", text: options.projectName })
  ]);

  const search = el("input", {
    className: "app-header__search",
    attrs: { type: "search", placeholder: "Search commands, tools, objects...", disabled: "true" }
  });

  const iconCluster = el("div", { className: "app-header__icons" }, [
    el("button", {
      className: "toolbar-button toolbar-button--icon",
      text: "\u{1F514}", // bell
      attrs: { type: "button", disabled: "true", title: "Coming soon", "aria-label": "Notifications" }
    }),
    el("button", {
      className: "toolbar-button toolbar-button--icon",
      text: "⚙", // gear
      attrs: { type: "button", disabled: "true", title: "Coming soon", "aria-label": "Settings" }
    }),
    el("button", {
      className: "toolbar-button toolbar-button--icon app-header__profile",
      text: "iA",
      attrs: { type: "button", disabled: "true", title: "Coming soon", "aria-label": "Profile" }
    })
  ]);

  return el("header", { className: "app-header" }, [
    branding,
    quickAccess,
    projectArea,
    search,
    iconCluster
  ]);
}
