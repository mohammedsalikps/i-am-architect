import { el } from "./dom";
import { eavaraMarkSvg } from "./brandMark";
import { MAX_PROJECT_NAME_LENGTH } from "../engine/project/projectDocument";
import type { HistoryManager } from "../engine/history/HistoryManager";
import type { ProjectMetaStore } from "../engine/project/ProjectMetaStore";
import type { ProjectPersistenceController } from "../engine/project/ProjectPersistenceController";
import type { AuthController } from "../engine/auth/AuthController";
import { themeToggleLabel } from "./theme";
import type { ThemeStore } from "./theme";
import { createMenu } from "./menus";
import { SHELL_ICONS } from "./shellIcons";

export type TopBarOptions = {
  projectMeta: ProjectMetaStore;
  persistence: ProjectPersistenceController;
  /** Who is signed in - the account menu at the right of the bar, or Sign in. */
  auth: AuthController;
  onSaveProject: () => void;
  onSignIn: () => void;
  onSignOut: () => void;
  onUndo: () => void;
  onRedo: () => void;
  history: HistoryManager;
  /** File / Edit / View / Build (ui/menus.ts) - built by the shell, which knows what each runs. */
  menuBar?: HTMLElement;
  /** The search box: each change searches the project (the Project tree shows the matches); Enter picks the first. Without these the box stays disabled. */
  onSearch?: (query: string) => void;
  onSearchPick?: () => boolean;
  /** The light/dark switch - see ui/theme.ts. */
  theme?: ThemeStore;
};

/** An icon (aria-hidden) and a word, so a button explains itself - the word is the button's text and name. */
function iconButton(className: string, icon: string, label: string, title: string): HTMLButtonElement {
  const glyph = el("span", { className: "toolbar-button__icon", attrs: { "aria-hidden": "true" } });
  glyph.innerHTML = icon;
  return el("button", { className: `toolbar-button ${className}`, attrs: { type: "button", title } }, [glyph, el("span", { className: "toolbar-button__text", text: label })]);
}

/**
 * The application bar, one compact row: the EAVARA identity, the File /
 * Edit / View / Build menus, the project's name (edited in place) and save
 * status; then the project search, Undo / Redo / Save, the theme switch,
 * and the account - "Sign in", or a round avatar whose menu shows the
 * signed-in email and Sign out.
 *
 * New Project, Open… and Export live in the File menu; Save stays on the
 * bar too, since it is used all the time. The name renames the project on
 * Enter or blur (a blank name is reverted); neither renaming nor saving is
 * an undo step.
 */
export function createTopBar(options: TopBarOptions): HTMLElement {
  // The product identity: the EAVARA mark (the same pine glyph the
  // startup splash draws - see brandMark.ts), "i am Architect", and the
  // small "EAVARA · THE SCHOOL OF ARCHITECTURE" lockup under it - never the
  // old "Eavara Estates" (guarded by src/ui/verify.ts). Quiet attribution,
  // not a second logo.
  const brandMark = el("span", { className: "app-header__brand-mark", attrs: { "aria-hidden": "true" } });
  brandMark.innerHTML = eavaraMarkSvg();
  const branding = el("div", { className: "app-header__brand" }, [
    brandMark,
    el("div", { className: "app-header__brand-text" }, [
      el("span", { className: "app-header__brand-name", text: "i am Architect" }),
      el("span", { className: "app-header__brand-eavara", text: "EAVARA · THE SCHOOL OF ARCHITECTURE" })
    ])
  ]);

  const undoButton = iconButton("toolbar-button--icon app-header__undo", SHELL_ICONS.undo, "Undo", "Undo the last change");
  undoButton.addEventListener("click", options.onUndo);
  const redoButton = iconButton("toolbar-button--icon app-header__redo", SHELL_ICONS.redo, "Redo", "Redo the change just undone");
  redoButton.addEventListener("click", options.onRedo);
  options.history.subscribe(() => {
    undoButton.disabled = !options.history.canUndo();
    redoButton.disabled = !options.history.canRedo();
  });

  const saveText = el("span", { className: "toolbar-button__text", text: "Save" });
  const saveIcon = el("span", { className: "toolbar-button__icon", attrs: { "aria-hidden": "true" } });
  saveIcon.innerHTML = SHELL_ICONS.save;
  const saveButton = el("button", { className: "toolbar-button app-header__save", attrs: { type: "button", title: "Save this project" } }, [saveIcon, saveText]);
  saveButton.addEventListener("click", options.onSaveProject);

  const quickAccess = el("div", { className: "app-header__actions", attrs: { role: "group", "aria-label": "History and saving" } }, [undoButton, redoButton, el("span", { className: "app-header__divider", attrs: { "aria-hidden": "true" } }), saveButton]);

  const nameInput = el("input", {
    className: "app-header__project-name",
    attrs: { type: "text", "aria-label": "Project name", maxlength: String(MAX_PROJECT_NAME_LENGTH), spellcheck: "false" }
  });
  options.projectMeta.subscribe((meta) => {
    // Never overwrite what the user is in the middle of typing.
    if (document.activeElement !== nameInput) {
      nameInput.value = meta.name;
    }
    nameInput.title = meta.id === null ? "Not saved yet - click to rename" : `Saved project - last saved ${new Date(meta.updatedAt ?? "").toLocaleString()}. Click to rename.`;
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
    saveButton.disabled = options.persistence.isBusy();
    saveText.textContent = state.status === "saving" ? "Saving…" : "Save";
    saveStatus.textContent = state.message ?? "";
    saveStatus.title = state.message ?? "";
    saveStatus.className = `app-header__save-status app-header__save-status--${state.status}`;
  });

  const projectArea = el("div", { className: "app-header__project" }, [nameInput, saveStatus]);

  const searchIcon = el("span", { className: "app-header__search-icon", attrs: { "aria-hidden": "true" } });
  searchIcon.innerHTML = SHELL_ICONS.search;
  const search = el("input", {
    className: "app-header__search",
    attrs: options.onSearch
      ? { type: "search", placeholder: "Search project", "aria-label": "Search the project", autocomplete: "off", spellcheck: "false", title: "Name, id, material or room - matches show in the Project browser; Enter selects and frames the first" }
      : { type: "search", placeholder: "Search", disabled: "true", title: "Coming soon" }
  }) as HTMLInputElement;
  if (options.onSearch) {
    const onSearch = options.onSearch;
    search.addEventListener("input", () => onSearch(search.value));
    search.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        // The tree's own box may have been changed since: pick from what this box shows.
        onSearch(search.value);
        options.onSearchPick?.();
      } else if (event.key === "Escape" && search.value) {
        // Clearing the search: don't let that Escape also disarm a placement tool or cancel a drag.
        // An Escape in an empty box goes on to them as usual.
        event.stopPropagation();
        search.value = "";
        onSearch("");
      }
    });
  }
  const searchBox = el("label", { className: "app-header__search-box" }, [searchIcon, search]);

  // One click switches the whole workspace (chrome and viewport) between light and dark; the choice is remembered.
  const themeIcon = el("span", { className: "app-header__theme-icon", attrs: { "aria-hidden": "true" } });
  const themeText = el("span", { className: "app-header__theme-text" });
  const themeButton = el("button", { className: "app-header__theme", attrs: { type: "button", "aria-label": "Dark theme" } }, [themeIcon, themeText]);
  themeButton.hidden = !options.theme;
  if (options.theme) {
    const store = options.theme;
    themeButton.addEventListener("click", () => store.toggle());
    store.subscribe((theme) => {
      const face = themeToggleLabel(theme);
      themeIcon.textContent = face.icon;
      themeText.textContent = face.text;
      themeButton.title = face.title;
      themeButton.setAttribute("aria-pressed", String(theme === "dark"));
    });
  }

  // The account: "Sign in" when signed out; signed in, a round avatar (the
  // email's first letter) whose menu shows the email and Sign out - the
  // email no longer takes a permanent slice of the bar. Sign out asks
  // first when the workspace holds a model (main.ts's signOut).
  const signInButton = el("button", {
    className: "toolbar-button toolbar-button--primary app-header__sign-in",
    text: "Sign in",
    attrs: { type: "button", title: "Sign in to save and open projects" }
  });
  signInButton.addEventListener("click", options.onSignIn);
  let email = "";
  const initial = el("span", { className: "app-header__avatar-initial", attrs: { "aria-hidden": "true" } });
  // The email, kept in the bar for assistive technology (and readable by tests) - the avatar shows only its initial.
  const accountName = el("span", { className: "app-header__account-name visually-hidden" });
  const accountMenu = createMenu({
    buttonClassName: "app-header__avatar",
    buttonContent: [initial, accountName],
    ariaLabel: "Account",
    align: "end",
    className: "app-header__account-menu",
    items: () => [
      { kind: "info", text: "Signed in as", className: "menu__info--caption" },
      { kind: "info", text: email, className: "app-header__account-email", title: email },
      { kind: "separator" },
      { label: "Sign out…", run: options.onSignOut, title: "Sign out of this account - you're asked first if the workspace holds a model" }
    ]
  });
  const account = el("div", { className: "app-header__account", attrs: { role: "group", "aria-label": "Account" } }, [signInButton, accountMenu.element]);
  options.auth.subscribe((state) => {
    email = state.status === "signed-in" ? (state.user?.email ?? "") : "";
    const restoring = state.status === "restoring";
    accountName.textContent = restoring ? "Checking sign-in…" : email;
    initial.textContent = restoring ? "…" : (email.trim()[0] ?? "?").toUpperCase();
    accountMenu.button.title = restoring ? "Checking sign-in…" : `Account - signed in as ${email}`;
    accountMenu.button.setAttribute("aria-label", restoring ? "Checking sign-in" : `Account menu, signed in as ${email}`);
    accountMenu.button.disabled = restoring;
    accountMenu.element.hidden = !(state.status === "signed-in" || restoring);
    if (accountMenu.element.hidden) accountMenu.close(false);
    signInButton.hidden = state.status === "signed-in" || restoring;
    signInButton.disabled = state.status === "working";
  });

  return el("header", { className: "app-header" }, [
    branding,
    ...(options.menuBar ? [options.menuBar] : []),
    projectArea,
    el("span", { className: "app-header__spacer" }),
    searchBox,
    quickAccess,
    themeButton,
    account
  ]);
}
