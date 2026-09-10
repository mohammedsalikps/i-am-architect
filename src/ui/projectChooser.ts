import { el } from "./dom";
import type { ProjectSummary } from "../engine/project/ProjectRepository";

export type ProjectOpenResult = { opened: boolean; error?: string };

export type ProjectChooserOptions = {
  /** The saved projects - ProjectPersistenceController.listProjects in the app. */
  listProjects: () => Promise<ProjectSummary[]>;
  /** Opens one. The chooser closes when it opened, and shows `error` when it didn't. */
  onOpen: (id: string, name: string) => Promise<ProjectOpenResult>;
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
 * The "Open…" dialog: the saved projects, newest first, each with an Open
 * button. Deliberately minimal - no search, rename, delete, or sharing.
 * It reads the list through the injected listProjects() and opens through
 * onOpen(); it never touches the model or a repository itself.
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

  // Bumped on every open/close, so a slow list request can't repaint a
  // chooser that has since been closed or reopened.
  let generation = 0;

  const showMessage = (text: string) => {
    message.textContent = text;
    message.hidden = text.length === 0;
  };

  const close = () => {
    overlay.hidden = true;
    generation += 1;
  };

  function renderProjects(projects: ProjectSummary[]): void {
    list.replaceChildren(
      ...projects.map((project) => {
        const openButton = el("button", {
          className: "toolbar-button toolbar-button--primary",
          text: "Open",
          attrs: { type: "button", "aria-label": `Open ${project.name}` }
        });
        openButton.addEventListener("click", async () => {
          openButton.disabled = true;
          const result = await options.onOpen(project.id, project.name);
          if (result.opened) {
            close();
            return;
          }
          openButton.disabled = false;
          showMessage(result.error ?? "");
        });

        return el("div", { className: "project-chooser__item" }, [
          el("div", { className: "project-chooser__item-text" }, [
            el("span", { className: "project-chooser__item-name", text: project.name }),
            el("span", {
              className: "project-chooser__item-meta",
              text: `${plural(project.objectCount, "object", "objects")} · ${plural(project.assemblyCount, "assembly", "assemblies")} · updated ${formatUpdated(project.updatedAt)}`
            })
          ]),
          openButton
        ]);
      })
    );
  }

  async function refresh(): Promise<void> {
    const current = ++generation;
    list.replaceChildren();
    showMessage("Loading saved projects…");

    let projects: ProjectSummary[];
    try {
      projects = await options.listProjects();
    } catch (error) {
      if (current === generation) {
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
