import { el } from "./dom";
import { SHELL_ICONS } from "./shellIcons";

export interface MainNavItem {
  id: string;
  label: string;
}

export interface MainNav {
  element: HTMLElement;
  /** Marks a category as the open one (the Build menu picks categories too). */
  setActive(id: string): void;
  /** Shows whether the tool palette under the tabs is open (the toggle's label and state). */
  setPaletteOpen(open: boolean): void;
}

/**
 * The tool categories, above the tool palette: one tab per category
 * (Build, Structure, Openings, Rooms, Finish, Plumbing, Electrical,
 * Interior, Exterior). Choosing one shows its tools in the palette below
 * (constructionRibbon.ts); choosing the open one again - or the toggle at
 * the end of the row - folds the palette away, leaving the viewport more
 * room. `onSelect` gets whether the tab was already the open one.
 */
export function createMainNav(
  items: readonly MainNavItem[],
  onSelect: (id: string, wasActive: boolean) => void,
  initialId: string,
  onTogglePalette?: () => void
): MainNav {
  const buttons = new Map<string, HTMLButtonElement>();
  let activeId = initialId;

  const setActive = (id: string): void => {
    activeId = id;
    for (const [itemId, button] of buttons) {
      const active = itemId === id;
      button.classList.toggle("app-mainnav__item--active", active);
      button.setAttribute("aria-selected", String(active));
    }
  };

  const tabs = el(
    "div",
    { className: "app-mainnav__tabs", attrs: { role: "tablist", "aria-label": "Tool categories" } },
    items.map((item) => {
      const button = el("button", {
        className: "app-mainnav__item",
        text: item.label,
        attrs: { type: "button", role: "tab", "data-category": item.id, "aria-controls": "tool-palette" }
      });
      button.addEventListener("click", () => {
        const wasActive = activeId === item.id;
        setActive(item.id);
        onSelect(item.id, wasActive);
      });
      buttons.set(item.id, button);
      return button;
    })
  );

  const toggleIcon = el("span", { className: "app-mainnav__toggle-icon", attrs: { "aria-hidden": "true" } });
  const toggleText = el("span", { className: "app-mainnav__toggle-text" });
  const toggle = el("button", { className: "app-mainnav__toggle", attrs: { type: "button", "aria-controls": "tool-palette" } }, [toggleIcon, toggleText]);
  toggle.hidden = !onTogglePalette;
  if (onTogglePalette) toggle.addEventListener("click", onTogglePalette);

  const setPaletteOpen = (open: boolean): void => {
    toggleIcon.innerHTML = open ? SHELL_ICONS.chevronUp : SHELL_ICONS.chevronDown;
    toggleText.textContent = open ? "Hide tools" : "Show tools";
    toggle.title = open ? "Fold the tool palette away - choose a category to bring it back" : "Show the tools of the chosen category";
    toggle.setAttribute("aria-expanded", String(open));
  };

  setActive(initialId);
  setPaletteOpen(true);
  return { element: el("nav", { className: "app-mainnav", attrs: { "aria-label": "Tools" } }, [tabs, toggle]), setActive, setPaletteOpen };
}
