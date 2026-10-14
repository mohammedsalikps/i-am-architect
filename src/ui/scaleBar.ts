import { el } from "./dom";
import type { ScaleBar } from "../engine/workspace/scaleBar";

/**
 * The viewport's scale indicator: a bar of a round length ("2 m") drawn
 * to the current zoom at the camera's look-at point, bottom-right over
 * the scene. SceneManager.onViewChange reports the zoom; this only draws.
 */
export function createScaleBarOverlay(): { element: HTMLElement; update(bar: ScaleBar | null): void } {
  const bar = el("span", { className: "scale-bar__bar" });
  const label = el("span", { className: "scale-bar__label" });
  const element = el("div", { className: "scale-bar", attrs: { role: "img", "aria-label": "Scale" } }, [bar, label]);
  return {
    element,
    update(next) {
      element.hidden = next === null;
      if (!next) return;
      bar.style.width = `${Math.round(next.pixels)}px`;
      label.textContent = next.label;
      element.setAttribute("aria-label", `Scale: this bar is ${next.label} at the view's centre`);
      element.dataset.metres = String(next.metres);
    }
  };
}
