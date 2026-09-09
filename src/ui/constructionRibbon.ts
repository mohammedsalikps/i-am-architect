import { el } from "./dom";

// Mirrors ObjectType (src/engine/objects/types.ts) plus a few not yet
// modeled at all (Brick, Concrete, Stairs, Flooring, Plumbing,
// Electrical). Only "Wall" has an engine behind it today.
const RIBBON_ITEMS = [
  "Wall",
  "Brick",
  "Concrete",
  "Pillar",
  "Beam",
  "Slab",
  "Door",
  "Window",
  "Stairs",
  "Roof",
  "Flooring",
  "Plumbing",
  "Electrical",
  "Furniture",
  "Landscape",
  "More"
];

/**
 * Construction ribbon: one button per buildable element type. Only
 * "Wall" is wired up (to the same onAddWall callback the Manual Build
 * tab uses) since it's the only object type the engine implements -
 * every other item is a disabled placeholder rather than a click that
 * does nothing, per the "disabled states for unavailable actions"
 * requirement.
 */
export function createConstructionRibbon(onAddWall: () => void): HTMLElement {
  return el(
    "div",
    { className: "app-ribbon" },
    RIBBON_ITEMS.map((label) => {
      const isEnabled = label === "Wall";
      const button = el(
        "button",
        {
          className: "app-ribbon__item",
          attrs: { type: "button", ...(isEnabled ? {} : { title: "Coming soon" }) }
        },
        [
          el("span", { className: "app-ribbon__icon", text: label.charAt(0) }),
          el("span", { className: "app-ribbon__label", text: label })
        ]
      );
      button.disabled = !isEnabled;
      if (isEnabled) {
        button.addEventListener("click", onAddWall);
      }
      return button;
    })
  );
}
