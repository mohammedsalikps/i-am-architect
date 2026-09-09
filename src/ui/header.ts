import { el } from "./dom";
import { createViewControls, type ViewPreset } from "./viewControls";
import type { SelectionStore } from "../engine/selection/SelectionStore";

export type HeaderOptions = {
  projectName: string;
  onViewChange: (preset: ViewPreset) => void;
  onAddWall: () => void;
  onDuplicateWall: () => void;
  onDeleteWall: () => void;
  selectionStore: SelectionStore;
};

/**
 * Top toolbar: branding, primary project actions, construction actions,
 * view controls, and the current project name. "Add Wall", "Duplicate
 * Wall", "Delete Wall" and the view controls are functional - the rest
 * are placeholders. Duplicate/Delete disable themselves when nothing is
 * selected by subscribing to selectionStore directly.
 */
export function createHeader(options: HeaderOptions): HTMLElement {
  const branding = el("div", { className: "app-header__brand" }, [
    el("span", { className: "app-header__brand-mark", text: "iA" }),
    el("span", { className: "app-header__brand-name", text: "i am Architect" })
  ]);

  const actions = el("div", { className: "app-header__actions" }, [
    el("button", { className: "toolbar-button", text: "New Project", attrs: { type: "button" } }),
    el("button", { className: "toolbar-button", text: "Save", attrs: { type: "button" } }),
    el("button", { className: "toolbar-button toolbar-button--icon", text: "Undo", attrs: { type: "button" } }),
    el("button", { className: "toolbar-button toolbar-button--icon", text: "Redo", attrs: { type: "button" } })
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
