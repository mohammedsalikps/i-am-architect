import { el } from "./dom";
import { MAX_PROJECT_NAME_LENGTH } from "../engine/project/projectDocument";
import type { HistoryManager } from "../engine/history/HistoryManager";
import type { ProjectMetaStore } from "../engine/project/ProjectMetaStore";
import type { ProjectPersistenceController } from "../engine/project/ProjectPersistenceController";
import type { AuthController } from "../engine/auth/AuthController";

export type TopBarOptions = {
  projectMeta: ProjectMetaStore;
  persistence: ProjectPersistenceController;
  /** Who is signed in - shown at the right of the bar, with Sign in / Sign out. */
  auth: AuthController;
  onNewProject: () => void;
  onOpenProject: () => void;
  onSaveProject: () => void;
  onSignIn: () => void;
  onSignOut: () => void;
  onUndo: () => void;
  onRedo: () => void;
  history: HistoryManager;
};

/**
 * Title bar: branding, a quick-access cluster (New Project/Open/Save/
 * Undo/Redo), the project's name and save status, a search field, a
 * notifications/settings icon cluster, and the account control.
 *
 * "New Project" starts an empty project (see main.ts's newProject), "Open…"
 * shows the project chooser (ui/projectChooser.ts), and "Save" saves the
 * model through ProjectPersistenceController. The name is an ordinary
 * text field: it renames the project on Enter or blur, and a blank name
 * is reverted. Neither renaming nor saving is an undo step. The account
 * control shows "Sign in" when signed out, and the user's email with
 * "Sign out" when signed in. Search and the icon cluster stay disabled
 * (styled-but-inert, the same pattern used elsewhere) rather than
 * clickable no-ops.
 */
export function createTopBar(options: TopBarOptions): HTMLElement {
  // The product identity (i am Architect) plus a small, understated Eavara
  // lockup - the school of architecture this product is associated with.
  // Not a splash screen: two quiet text lines, no logo graphic, so it
  // reads as attribution/identity rather than competing with the
  // workspace for attention - see UI milestone notes.
  const branding = el("div", { className: "app-header__brand" }, [
    el("span", { className: "app-header__brand-mark", text: "iA" }),
    el("div", { className: "app-header__brand-text" }, [
      el("span", { className: "app-header__brand-name", text: "i am Architect" }),
      el("span", { className: "app-header__brand-eavara", text: "EAVARA · THE SCHOOL OF ARCHITECTURE" })
    ])
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

  const openButton = el("button", {
    className: "toolbar-button",
    text: "Open…",
    attrs: { type: "button", title: "Open a saved project" }
  });
  openButton.addEventListener("click", options.onOpenProject);

  const saveButton = el("button", {
    className: "toolbar-button",
    text: "Save",
    attrs: { type: "button", title: "Save this project" }
  });
  saveButton.addEventListener("click", options.onSaveProject);

  const quickAccess = el("div", { className: "app-header__actions" }, [
    newProjectButton,
    openButton,
    saveButton,
    undoButton,
    redoButton
  ]);

  const nameInput = el("input", {
    className: "app-header__project-name",
    attrs: { type: "text", "aria-label": "Project name", maxlength: String(MAX_PROJECT_NAME_LENGTH), spellcheck: "false" }
  });
  options.projectMeta.subscribe((meta) => {
    // Never overwrite what the user is in the middle of typing.
    if (document.activeElement !== nameInput) {
      nameInput.value = meta.name;
    }
    nameInput.title = meta.id === null ? "Not saved yet" : `Saved project - last saved ${new Date(meta.updatedAt ?? "").toLocaleString()}`;
  });
  nameInput.addEventListener("change", () => {
    options.projectMeta.rename(nameInput.value); // refuses a blank name
    nameInput.value = options.projectMeta.get().name;
  });
  nameInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      nameInput.blur(); // commits through "change"
    } else if (event.key === "Escape") {
      nameInput.value = options.projectMeta.get().name;
      nameInput.blur();
    }
  });

  const saveStatus = el("span", {
    className: "app-header__save-status",
    attrs: { role: "status", "aria-live": "polite" }
  });
  options.persistence.subscribe((state) => {
    const busy = options.persistence.isBusy();
    saveButton.disabled = busy;
    openButton.disabled = busy;
    newProjectButton.disabled = busy;
    saveButton.textContent = state.status === "saving" ? "Saving…" : "Save";
    newProjectButton.textContent = state.status === "creating" ? "Creating…" : "New Project";
    saveStatus.textContent = state.message ?? "";
    saveStatus.title = state.message ?? "";
    saveStatus.className = `app-header__save-status app-header__save-status--${state.status}`;
  });

  const projectArea = el("div", { className: "app-header__project" }, [
    el("span", { className: "app-header__project-label", text: "Project" }),
    nameInput,
    saveStatus
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
    })
  ]);

  const accountName = el("span", { className: "app-header__account-name" });
  const signInButton = el("button", {
    className: "toolbar-button toolbar-button--primary",
    text: "Sign in",
    attrs: { type: "button", title: "Sign in to save and open projects" }
  });
  signInButton.addEventListener("click", options.onSignIn);
  const signOutButton = el("button", { className: "toolbar-button", text: "Sign out", attrs: { type: "button" } });
  signOutButton.addEventListener("click", options.onSignOut);
  const account = el("div", { className: "app-header__account", attrs: { role: "group", "aria-label": "Account" } }, [
    accountName,
    signInButton,
    signOutButton
  ]);
  options.auth.subscribe((state) => {
    const email = state.status === "signed-in" ? (state.user?.email ?? "") : "";
    accountName.textContent = state.status === "restoring" ? "Checking sign-in…" : email;
    accountName.title = email ? `Signed in as ${email}` : "";
    accountName.hidden = accountName.textContent === "";
    signInButton.hidden = state.status === "signed-in" || state.status === "restoring";
    signInButton.disabled = state.status === "working";
    signOutButton.hidden = state.status !== "signed-in";
  });

  return el("header", { className: "app-header" }, [
    branding,
    quickAccess,
    projectArea,
    search,
    iconCluster,
    account
  ]);
}
