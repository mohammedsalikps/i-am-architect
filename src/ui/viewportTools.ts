import { el } from "./dom";

/** What a viewport click does right now: select an object, measure, or place the armed ribbon tool. */
export type ViewportToolMode = "select" | "measure" | "placing";

export interface ViewportToolActions {
  /** Back to plain selection: puts away whatever tool is armed (the same as Escape). */
  onSelect(): void;
  /** Arms the Measure tool, or puts it away if it's already armed. */
  onMeasure(): void;
}

export interface ViewportTools {
  /** The buttons, for the viewport's tool row. */
  elements: HTMLElement[];
  setMode(mode: ViewportToolMode): void;
}

const ICONS = {
  select: '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M6 3l12 9-5.2 1.1 3 6.2-2.3 1.1-3-6.3L6 17.5z" fill="currentColor"/></svg>',
  measure:
    '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M3 15.5L15.5 3 21 8.5 8.5 21z"/><path d="M7 11.5l2 2M9.8 8.7l1.5 1.5M12.6 5.9l2 2" stroke-linecap="round"/></g></svg>',
  annotate:
    '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M4 5h16v11H10l-4 4v-4H4z"/><path d="M8 9h8M8 12h5" stroke-linecap="round"/></g></svg>'
} as const;

function toolButton(icon: string, label: string, title: string, disabled = false): HTMLButtonElement {
  const button = el("button", {
    className: "view-controls__button viewport-tool",
    attrs: { type: "button", title, "aria-label": label, ...(disabled ? { disabled: "true" } : {}) }
  });
  button.innerHTML = `${icon}<span class="viewport-tool__label">${label}</span>`;
  return button;
}

/**
 * Select / Measure / Annotate, sharing the Snap toggle's row. Select and
 * Measure are real: Select puts away any armed tool so a click selects
 * again, and Measure is scene/measureTool.ts. Annotate is shown disabled
 * and says so - there is no annotation model yet, and a button that
 * looked usable but did nothing would mislead.
 */
export function createViewportTools(actions: ViewportToolActions): ViewportTools {
  const select = toolButton(ICONS.select, "Select", "Select objects - click one in the viewport. Puts away any armed tool (Esc does the same).");
  const measure = toolButton(
    ICONS.measure,
    "Measure",
    "Measure a plan distance: click two points on the ground. Points snap to object ends, corners and centres, or the snap grid (Grid & plot sets its step), while Snap is on. Nothing is changed or recorded."
  );
  const annotate = toolButton(ICONS.annotate, "Annotate", "Annotations aren't available yet", true);
  annotate.classList.add("viewport-tool--unavailable");
  select.addEventListener("click", () => actions.onSelect());
  measure.addEventListener("click", () => actions.onMeasure());

  return {
    // Annotate stays built (disabled) but out of the demo toolbar until there's an annotation model behind it.
    elements: [select, measure],
    setMode(mode) {
      select.classList.toggle("is-active", mode === "select");
      select.setAttribute("aria-pressed", String(mode === "select"));
      measure.classList.toggle("is-active", mode === "measure");
      measure.setAttribute("aria-pressed", String(mode === "measure"));
    }
  };
}
