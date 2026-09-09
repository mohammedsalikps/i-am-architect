import { el } from "./dom";

export type TabDefinition = {
  id: string;
  label: string;
  /** Builds this tab's panel content. Called once, lazily, the first time the tab becomes active. */
  build: () => HTMLElement;
  /** Disabled tabs render but cannot be activated - used for "Coming soon" sections. */
  disabled?: boolean;
};

export type TabStrip = {
  /** The tab-button row - mount this above `panel`. */
  strip: HTMLElement;
  /** The content container - swaps its single child as the active tab changes. */
  panel: HTMLElement;
};

/**
 * Shared building block for the three "row of buttons, one active,
 * content swapped below" panels this milestone introduces (left rail,
 * right sidebar tabs, bottom workspace tabs) - kept in one place so
 * the switching behavior (and its class names) stay consistent instead
 * of being reimplemented three times.
 *
 * Panel content is built lazily and cached per tab id, so an expensive
 * or side-effecting `build()` (e.g. one that subscribes to a store)
 * only runs once even if the user switches tabs back and forth.
 */
export function createTabStrip(tabs: TabDefinition[], stripClassName: string, buttonClassName: string): TabStrip {
  if (tabs.length === 0) {
    throw new Error("createTabStrip requires at least one tab");
  }

  const strip = el("div", { className: stripClassName });
  const panel = el("div", { className: "tab-strip__panel" });
  const buttons = new Map<string, HTMLButtonElement>();
  const built = new Map<string, HTMLElement>();

  function activate(id: string): void {
    for (const [tabId, button] of buttons) {
      button.classList.toggle(`${buttonClassName}--active`, tabId === id);
    }
    let content = built.get(id);
    if (!content) {
      const tab = tabs.find((t) => t.id === id);
      if (!tab) return;
      content = tab.build();
      built.set(id, content);
    }
    panel.replaceChildren(content);
  }

  for (const tab of tabs) {
    const button = el("button", {
      className: buttonClassName,
      text: tab.label,
      attrs: { type: "button", ...(tab.disabled ? { title: "Coming soon" } : {}) }
    });
    button.disabled = !!tab.disabled;
    if (!tab.disabled) {
      button.addEventListener("click", () => activate(tab.id));
    }
    buttons.set(tab.id, button);
    strip.append(button);
  }

  const initial = tabs.find((t) => !t.disabled) ?? tabs[0];
  activate(initial.id);

  return { strip, panel };
}

/** Shared "not built yet" panel content for a disabled/placeholder tab or rail item. */
export function comingSoon(label: string): HTMLElement {
  return el("div", { className: "sidebar__section" }, [
    el("p", { className: "sidebar__placeholder", text: `${label} is coming in a future milestone.` })
  ]);
}
