import { el } from "./dom";
import { createViewControls, type ViewPreset } from "./viewControls";
import type { SelectionStore } from "../engine/selection/SelectionStore";
import type { HistoryManager } from "../engine/history/HistoryManager";

export type HeaderOptions = {
  projectName: string;
  onViewChange: (preset: ViewPreset) => void;
  onAddWall: () => void;
  onDuplicateWall: () => void;
  onDeleteWall: () => void;
  onUndo: () => void;
  onRedo: () => void;
  selectionStore: SelectionStore;
  history: HistoryManager;
};

/**
 * Top toolbar: branding, primary project actions, construction actions,
 * view controls, and the current project name. "Add Wall", "Duplicate
 * Wall", "Delete Wall", "Undo", "Redo" and the view controls are
 * functional - "New Project" and "Save" remain placeholders. Duplicate/
 * Delete disable themselves when nothing is selected (selectionStore);
 * Undo/Redo disable themselves when there's nothing to undo/redo
 * (history) - both by subscribing directly rather than via main.ts.
 */
export function createHeader(options: HeaderOptions): HTMLElement {
  const branding = el("div", { className: "app-header__brand" }, [
    el("span", { className: "app-header__brand-mark", text: "iA" }),
    el("span", { className: "app-header__brand-name", text: "i am Architect" })
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

  const actions = el("div", { className: "app-header__actions" }, [
    el("button", { className: "toolbar-button", text: "New Project", attrs: { type: "button" } }),
    el("button", { className: "toolbar-button", text: "Save", attrs: { type: "button" } }),
    undoButton,
    redoButton
  ]);

  const addWallButton = el("button", {
    className: "toolbar-button toolbar-button--primary",
    text: "Add Wall",
    attrs: { type: "button" }
  });
  addWallButton.addEventListener("click", options.onAddWall);

  const duplicateWallButton = el("button", {
    className: "toolbar-button",
    text: "Duplicate Wall",
    attrs: { type: "button" }
  });
  duplicateWallButton.addEventListener("click", options.onDuplicateWall);

  const deleteWallButton = el("button", {
    className: "toolbar-button toolbar-button--danger",
    text: "Delete Wall",
    attrs: { type: "button" }
  });
  deleteWallButton.addEventListener("click", options.onDeleteWall);

  // Both act on the current selection, so both disable themselves when there isn't one.
  options.selectionStore.subscribe((selectedId) => {
    const hasSelection = selectedId !== null;
    duplicateWallButton.disabled = !hasSelection;
    deleteWallButton.disabled = !hasSelection;
  });

  const constructionActions = el("div", { className: "app-header__actions" }, [
    addWallButton,
    duplicateWallButton,
    deleteWallButton
  ]);

  const viewControls = createViewControls(options.onViewChange);

  const projectArea = el("div", { className: "app-header__project" }, [
    el("span", { className: "app-header__project-label", text: "Project" }),
    el("span", { className: "app-header__project-name", text: options.projectName })
  ]);

  return el("header", { className: "app-header" }, [
    branding,
    actions,
    constructionActions,
    viewControls,
    projectArea
  ]);
}
