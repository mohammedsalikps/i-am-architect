import { el } from "./dom";

// Mirrors ObjectType (src/engine/objects/types.ts) plus a few not yet
// modeled at all (Brick, Concrete, Stairs, Flooring, Plumbing,
// Electrical). Only "Wall", "Pillar", and "Beam" have an engine behind
// them today.
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
 * Construction ribbon: one button per buildable element type. "Wall",
 * "Pillar", and "Beam" are wired up (to the onAddWall/onAddPillar/
 * onAddBeam callbacks - the same ones the Manual Build tab uses) since
 * those are the only three object types the engine implements - every
 * other item is a disabled placeholder rather than a click that does
 * nothing, per the "disabled states for unavailable actions"
 * requirement.
 */
export function createConstructionRibbon(
  onAddWall: () => void,
  onAddPillar: () => void,
  onAddBeam: () => void
): HTMLElement {
  const handlers: Partial<Record<string, () => void>> = {
    Wall: onAddWall,
    Pillar: onAddPillar,
    Beam: onAddBeam
  };

  return el(
    "div",
    { className: "app-ribbon" },
    RIBBON_ITEMS.map((label) => {
      const handler = handlers[label];
      const isEnabled = !!handler;
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
      if (handler) {
        button.addEventListener("click", handler);
      }
      return button;
    })
  );
}
