import { el } from "./dom";
import { createViewControls, type ViewPreset } from "./viewControls";

export type HeaderOptions = {
  projectName: string;
  onViewChange: (preset: ViewPreset) => void;
  onAddWall: () => void;
};

/**
 * Top toolbar: branding, primary project actions, construction actions,
 * view controls, and the current project name. Only "Add Wall" and the
 * view controls are functional this milestone - the rest are placeholders.
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
  const constructionActions = el("div", { className: "app-header__actions" }, [addWallButton]);

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
