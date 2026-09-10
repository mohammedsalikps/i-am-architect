import { el } from "./dom";

export interface MainNavItem {
  id: string;
  label: string;
}

/**
 * Primary navigation row, between the top bar and the construction
 * ribbon: one tab per tool category (Home, Structure, Openings, Rooms,
 * Finish, Plumbing, Electrical, Interior, Exterior). Choosing one switches
 * which tools the ribbon shows - see constructionRibbon.ts. Every item
 * leads somewhere; there are no placeholder entries.
 */
export function createMainNav(items: readonly MainNavItem[], onSelect: (id: string) => void, initialId: string): HTMLElement {
  const buttons = new Map<string, HTMLButtonElement>();

  const setActive = (id: string): void => {
    for (const [itemId, button] of buttons) {
      const active = itemId === id;
      button.classList.toggle("app-mainnav__item--active", active);
      button.setAttribute("aria-selected", String(active));
    }
  };

  const nav = el(
    "nav",
    { className: "app-mainnav", attrs: { role: "tablist", "aria-label": "Tool categories" } },
    items.map((item) => {
      const button = el("button", {
        className: "app-mainnav__item",
        text: item.label,
        attrs: { type: "button", role: "tab", "data-category": item.id }
      });
      button.addEventListener("click", () => {
        setActive(item.id);
        onSelect(item.id);
      });
      buttons.set(item.id, button);
      return button;
    })
  );

  setActive(initialId);
  return nav;
}
