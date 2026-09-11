import { el } from "./dom";

/** Camera view presets. Mirrored (by value) in SceneManager.ViewPreset. */
export type ViewPreset = "perspective" | "top" | "front" | "side";

const VIEW_OPTIONS: { preset: ViewPreset; label: string }[] = [
  { preset: "perspective", label: "Perspective" },
  { preset: "top", label: "Top" },
  { preset: "front", label: "Front" },
  { preset: "side", label: "Side" }
];

/**
 * Perspective / Top / Front / Side view switcher, plus Fit House and
 * Focus Selected - real camera actions (SceneManager.fitToScene()/
 * focusOn(), via the onFit/onFocusSelected callbacks main.ts supplies),
 * not simulated ones. Reports the chosen preset via `onSelect` - it does
 * not touch Three.js itself, so it stays decoupled from the scene layer.
 */
export function createViewControls(
  onSelect: (preset: ViewPreset) => void,
  onFit: () => void,
  onFocusSelected: () => void
): HTMLElement {
  const container = el("div", { className: "view-controls" });
  const buttons = new Map<ViewPreset, HTMLButtonElement>();

  const setActive = (active: ViewPreset): void => {
    for (const [preset, button] of buttons) {
      button.classList.toggle("is-active", preset === active);
    }
  };

  for (const { preset, label } of VIEW_OPTIONS) {
    const button = el("button", {
      className: "view-controls__button",
      text: label,
      attrs: { type: "button", title: `${label} view` }
    });
    button.addEventListener("click", () => {
      setActive(preset);
      onSelect(preset);
    });
    buttons.set(preset, button);
    container.append(button);
  }

  setActive("perspective");

  const divider = el("span", { className: "view-controls__divider" });
  const fitButton = el("button", {
    className: "view-controls__button",
    text: "Fit House",
    attrs: { type: "button", title: "Frame every visible object" }
  });
  fitButton.addEventListener("click", onFit);

  const focusButton = el("button", {
    className: "view-controls__button",
    text: "Focus Selected",
    attrs: { type: "button", title: "Frame the selected object" }
  });
  focusButton.addEventListener("click", onFocusSelected);

  container.append(divider, fitButton, focusButton);

  return container;
}
