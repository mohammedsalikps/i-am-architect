import { el } from "./dom";
import { ProjectAuthError } from "../engine/project/ProjectRepository";
import type { ProjectSummary } from "../engine/project/ProjectRepository";

export type ProjectOpenResult = { opened: boolean; error?: string };
/** `deleted: false` with no `error` means the user changed their mind. */
export type ProjectDeleteResult = { deleted: boolean; error?: string };

export type ProjectChooserOptions = {
  /** The signed-in user's saved projects - ProjectPersistenceController.listProjects in the app. */
  listProjects: () => Promise<ProjectSummary[]>;
  /** Opens one. The chooser closes when it opened, and shows `error` when it didn't. */
  onOpen: (id: string, name: string) => Promise<ProjectOpenResult>;
  /** Deletes one, after the user confirms (main.ts asks). The list refreshes when it's gone. */
  onDelete: (id: string, name: string) => Promise<ProjectDeleteResult>;
  /** Projects belong to an account - signed out, the chooser asks the user to sign in instead. */
  isSignedIn: () => boolean;
  /** Shows the sign-in dialog. Resolves true once the user is signed in. */
  onSignIn: () => Promise<boolean>;
};

export type ProjectChooser = {
  /** The overlay - main.ts appends it to document.body, outside the shell's grid. */
  element: HTMLElement;
  open: () => void;
  close: () => void;
};

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatUpdated(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

function plural(count: number, singular: string, pluralForm: string): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

/**
 * The "Open…" dialog: the signed-in user's saved projects, most recently
 * updated first, each with Open and Delete. Signed out (or once the
 * session has expired) it offers Sign in instead. Deliberately minimal -
 * no search, rename, or sharing. It reads the list through the injected
 * listProjects() and acts through onOpen()/onDelete(); it never touches
 * the model or a repository itself.
 */
export function createProjectChooser(options: ProjectChooserOptions): ProjectChooser {
  const list = el("div", { className: "project-chooser__list" });
  const message = el("p", { className: "project-chooser__message" });
  const closeButton = el("button", { className: "toolbar-button", text: "Close", attrs: { type: "button" } });

  const panel = el(
    "div",
    { className: "project-chooser__panel", attrs: { role: "dialog", "aria-modal": "true", "aria-labelledby": "project-chooser-title" } },
    [
      el("div", { className: "project-chooser__header" }, [
        el("h2", { className: "project-chooser__title", text: "Open project", attrs: { id: "project-chooser-title" } }),
        closeButton
      ]),
      message,
      list
    ]
  );
  const overlay = el("div", { className: "project-chooser" }, [panel]);
  overlay.hidden = true;

  // Bumped on every open/close/refresh, so a slow list request can't
  // repaint a chooser that has since been closed or reopened.
  let generation = 0;

  const showMessage = (text: string) => {
    message.textContent = text;
    message.hidden = text.length === 0;
  };

  const close = () => {
    overlay.hidden = true;
    generation += 1;
  };

  function showSignIn(text: string): void {
    const signInButton = el("button", { className: "toolbar-button toolbar-button--primary", text: "Sign in", attrs: { type: "button" } });
    signInButton.addEventListener("click", async () => {
      const signedIn = await options.onSignIn();
      if (signedIn && !overlay.hidden) {
        void refresh();
      }
    });
    showMessage(text);
    list.replaceChildren(el("div", { className: "project-chooser__sign-in" }, [signInButton]));
  }

  function renderProjects(projects: ProjectSummary[]): void {
    list.replaceChildren(
      ...projects.map((project) => {
        const openButton = el("button", {
          className: "toolbar-button toolbar-button--primary",
          text: "Open",
          attrs: { type: "button", "aria-label": `Open ${project.name}` }
        });
        const deleteButton = el("button", {
          className: "toolbar-button toolbar-button--danger",
          text: "Delete",
          attrs: { type: "button", "aria-label": `Delete ${project.name}` }
        });
        const setBusy = (busy: boolean) => {
          openButton.disabled = busy;
          deleteButton.disabled = busy;
        };

        openButton.addEventListener("click", async () => {
          setBusy(true);
          const result = await options.onOpen(project.id, project.name);
          if (result.opened) {
            close();
            return;
          }
          setBusy(false);
          showMessage(result.error ?? "");
        });

        deleteButton.addEventListener("click", async () => {
          setBusy(true);
          const result = await options.onDelete(project.id, project.name);
          if (result.deleted) {
            void refresh();
            return;
          }
          setBusy(false);
          if (result.error) {
            showMessage(result.error);
          }
        });

        return el("div", { className: "project-chooser__item" }, [
          el("div", { className: "project-chooser__item-text" }, [
            el("span", { className: "project-chooser__item-name", text: project.name, attrs: { title: project.name } }),
            el("span", {
              className: "project-chooser__item-meta",
              text: `${plural(project.objectCount, "object", "objects")} · ${plural(project.assemblyCount, "assembly", "assemblies")} · updated ${formatUpdated(project.updatedAt)}`
            })
          ]),
          el("div", { className: "project-chooser__item-actions" }, [openButton, deleteButton])
        ]);
      })
    );
  }

  async function refresh(): Promise<void> {
    const current = ++generation;
    list.replaceChildren();
    if (!options.isSignedIn()) {
      showSignIn("Sign in to see your saved projects.");
      return;
    }
    showMessage("Loading saved projects…");

    let projects: ProjectSummary[];
    try {
      projects = await options.listProjects();
    } catch (error) {
      if (current !== generation) {
        return;
      }
      if (error instanceof ProjectAuthError) {
        showSignIn(error.message);
      } else {
        showMessage(`Could not load saved projects: ${describeError(error)}`);
      }
      return;
    }
    if (current !== generation) {
      return;
    }
    if (projects.length === 0) {
      showMessage("No saved projects yet. Use Save to store this one.");
      return;
    }
    showMessage("");
    renderProjects(projects);
  }

  closeButton.addEventListener("click", close);
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) {
      close(); // a click on the backdrop, not the panel
    }
  });
  overlay.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      close();
    }
  });

  return {
    element: overlay,
    open: () => {
      overlay.hidden = false;
      closeButton.focus();
      void refresh();
    },
    close
  };
}
