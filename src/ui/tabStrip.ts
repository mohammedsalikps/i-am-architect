import { el } from "./dom";

export type TabDefinition = {
  id: string;
  label: string;
  /** Builds this tab's panel content. Called once, lazily, the first time the tab becomes active. */
  build: () => HTMLElement;
  /** Disabled tabs render but cannot be activated - used for "Coming soon" sections. */
  disabled?: boolean;
  /** Runs when the user switches away from this tab to another one - e.g. clearing a temporary viewport highlight. Never called for the tab's own initial build. */
  onDeactivate?: () => void;
  /** An icon (SVG markup, shellIcons.ts) shown above the label - the left rail's tabs. */
  icon?: string;
};

export type TabStripOptions = {
  /** A click on a tab button - `wasActive` when it was already the open tab (the rail collapses its panel then). Runs after the tab is activated. */
  onSelect?: (id: string, wasActive: boolean) => void;
  /** The strip's accessible name ("Project browser", "Records"). */
  label?: string;
};

export type TabStrip = {
  /** The tab-button row - mount this above `panel`. */
  strip: HTMLElement;
  /** The content container - swaps its single child as the active tab changes. */
  panel: HTMLElement;
  /** Activates a tab by id programmatically - same effect as clicking its button. A no-op for an unknown or disabled id. */
  activate: (id: string) => void;
  /** The open tab's id. */
  activeId: () => string | null;
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
/**
 * Whether disabled ("Coming soon") tabs are shown at all. Off for the demo
 * workspace: an unfinished section is left out of the UI rather than shown
 * as a dead button. Their definitions (and builders) stay in place - flip
 * this to show them again.
 */
export const SHOW_COMING_SOON = false;

export function createTabStrip(tabs: TabDefinition[], stripClassName: string, buttonClassName: string, options: TabStripOptions = {}): TabStrip {
  if (tabs.length === 0) {
    throw new Error("createTabStrip requires at least one tab");
  }

  // The row (which a caller may extend with a collapse button) holds the tablist, so only tabs are in the tablist.
  const strip = el("div", { className: stripClassName });
  const tabList = el("div", { className: "tab-strip__tabs", attrs: { role: "tablist", ...(options.label ? { "aria-label": options.label } : {}) } });
  strip.append(tabList);
  const panel = el("div", { className: "tab-strip__panel" });
  const buttons = new Map<string, HTMLButtonElement>();
  const built = new Map<string, HTMLElement>();
  let activeId: string | null = null;

  function activate(id: string): void {
    if (activeId && activeId !== id) {
      tabs.find((t) => t.id === activeId)?.onDeactivate?.();
    }
    activeId = id;
    for (const [tabId, button] of buttons) {
      button.classList.toggle(`${buttonClassName}--active`, tabId === id);
      button.setAttribute("aria-selected", String(tabId === id));
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
    if (tab.disabled && !SHOW_COMING_SOON) continue;
    const button = el("button", {
      className: buttonClassName,
      attrs: { type: "button", role: "tab", "aria-selected": "false", "data-tab": tab.id, ...(tab.disabled ? { title: "Coming soon" } : {}) }
    });
    if (tab.icon) {
      const icon = el("span", { className: "tab-strip__icon", attrs: { "aria-hidden": "true" } });
      icon.innerHTML = tab.icon;
      button.append(icon, el("span", { className: "tab-strip__label", text: tab.label }));
    } else {
      button.textContent = tab.label;
    }
    button.disabled = !!tab.disabled;
    if (!tab.disabled) {
      button.addEventListener("click", () => {
        const wasActive = activeId === tab.id;
        activate(tab.id);
        options.onSelect?.(tab.id, wasActive);
      });
    }
    buttons.set(tab.id, button);
    tabList.append(button);
  }

  const initial = tabs.find((t) => !t.disabled) ?? tabs[0];
  activate(initial.id);

  return {
    strip,
    panel,
    activate: (id: string) => {
      const tab = tabs.find((t) => t.id === id);
      if (tab && !tab.disabled) {
        activate(id);
      }
    },
    activeId: () => activeId
  };
}

/** Shared "not built yet" panel content for a disabled/placeholder tab or rail item. */
export function comingSoon(label: string): HTMLElement {
  return el("div", { className: "sidebar__section" }, [
    el("p", { className: "sidebar__placeholder", text: `${label} is coming in a future milestone.` })
  ]);
}
