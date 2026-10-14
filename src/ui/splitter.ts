import { el } from "./dom";

export interface SplitterOptions {
  /** Which edge of its panel the handle sits on - so which way a drag grows the panel. */
  edge: "left" | "right" | "top";
  /** Read out by screen readers: "Resize the project browser". */
  label: string;
  /** The panel's size now, px. */
  getSize(): number;
  /** Asks for a new size; the layout clamps it. */
  setSize(size: number): void;
  min: number;
  /** The largest size, px - a function where it depends on the window. */
  max: number | (() => number);
}

/** A keyboard step, px (Shift for a bigger one). */
const STEP = 16;
const BIG_STEP = 64;

/**
 * A drag handle on a panel's edge: drag it to resize the panel, or focus
 * it and use the arrow keys (Home/End for the smallest and largest). It
 * is a focusable role="separator" with its current value announced. The
 * pointer is captured for the drag, and the page shows a resize cursor
 * and stops selecting text until it ends.
 */
export function createSplitter(options: SplitterOptions): HTMLElement {
  const vertical = options.edge !== "top"; // a left/right edge is a vertical line
  const max = (): number => (typeof options.max === "function" ? options.max() : options.max);
  const handle = el("div", {
    className: `splitter splitter--${options.edge}`,
    attrs: {
      role: "separator",
      tabindex: "0",
      "aria-label": options.label,
      "aria-orientation": vertical ? "vertical" : "horizontal",
      title: `${options.label} - drag, or use the arrow keys`
    }
  });
  const announce = (): void => {
    handle.setAttribute("aria-valuenow", String(Math.round(options.getSize())));
    handle.setAttribute("aria-valuemin", String(options.min));
    handle.setAttribute("aria-valuemax", String(Math.round(max())));
  };
  announce();

  /** +1 when moving the pointer right (or down) grows the panel, -1 when it shrinks it. */
  const growth = options.edge === "right" ? 1 : -1;
  let drag: { pointerId: number; start: number; size: number } | null = null;

  handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    drag = { pointerId: event.pointerId, start: vertical ? event.clientX : event.clientY, size: options.getSize() };
    handle.setPointerCapture?.(event.pointerId);
    document.body.classList.add(vertical ? "is-resizing-x" : "is-resizing-y");
    handle.classList.add("is-dragging");
  });
  handle.addEventListener("pointermove", (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const moved = (vertical ? event.clientX : event.clientY) - drag.start;
    options.setSize(drag.size + growth * moved);
    announce();
  });
  const end = (event: PointerEvent): void => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    drag = null;
    document.body.classList.remove("is-resizing-x", "is-resizing-y");
    handle.classList.remove("is-dragging");
    announce();
  };
  handle.addEventListener("pointerup", end);
  handle.addEventListener("pointercancel", end);

  handle.addEventListener("keydown", (event) => {
    const step = event.shiftKey ? BIG_STEP : STEP;
    // The arrow pointing away from the panel grows it.
    const grow = vertical ? (options.edge === "right" ? "ArrowRight" : "ArrowLeft") : "ArrowUp";
    const shrink = vertical ? (options.edge === "right" ? "ArrowLeft" : "ArrowRight") : "ArrowDown";
    let size: number | null = null;
    if (event.key === grow) size = options.getSize() + step;
    else if (event.key === shrink) size = options.getSize() - step;
    else if (event.key === "Home") size = options.min;
    else if (event.key === "End") size = max();
    if (size === null) return;
    event.preventDefault();
    options.setSize(size);
    announce();
  });
  return handle;
}
