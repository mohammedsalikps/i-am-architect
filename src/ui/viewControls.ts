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
 * Perspective / Top / Front / Side view switcher. Reports the chosen
 * preset via `onSelect` - it does not touch Three.js itself, so it
 * stays decoupled from the scene layer.
 */
export function createViewControls(onSelect: (preset: ViewPreset) => void): HTMLElement {
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
      attrs: { type: "button" }
    });
    button.addEventListener("click", () => {
      setActive(preset);
      onSelect(preset);
    });
    buttons.set(preset, button);
    container.append(button);
  }

  setActive("perspective");

  return container;
}
