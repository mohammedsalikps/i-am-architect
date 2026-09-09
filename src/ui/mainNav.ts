import { el } from "./dom";

const NAV_ITEMS = [
  "Home",
  "Insert",
  "Build",
  "Materials",
  "Tools",
  "View",
  "AI Assistant",
  "Estimate",
  "Collaborate",
  "Export"
];

// Only "Home" leads anywhere today - the rest have no distinct content
// to switch to yet (this milestone doesn't add per-tab pages), so they
// render disabled rather than as clicks that silently do nothing.
const ENABLED_ITEM = "Home";

/**
 * Primary application navigation row, between the top bar and the
 * construction ribbon. Purely a navigation affordance - it does not
 * gate or change what the ribbon/body show; see mainNav's doc in
 * layout.ts for why.
 */
export function createMainNav(): HTMLElement {
  return el(
    "nav",
    { className: "app-mainnav" },
    NAV_ITEMS.map((label) => {
      const isEnabled = label === ENABLED_ITEM;
      const button = el("button", {
        className: `app-mainnav__item${isEnabled ? " app-mainnav__item--active" : ""}`,
        text: label,
        attrs: { type: "button", ...(isEnabled ? {} : { title: "Coming soon" }) }
      });
      button.disabled = !isEnabled;
      return button;
    })
  );
}
