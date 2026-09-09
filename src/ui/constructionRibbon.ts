import { el } from "./dom";

// Mirrors ObjectType (src/engine/objects/types.ts) plus a few not yet
// modeled at all (Brick, Concrete, Stairs, Flooring, Plumbing,
// Electrical). Only "Wall", "Pillar", "Beam", and "Slab" have an
// engine behind them today.
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
 * "Pillar", "Beam", and "Slab" are wired up (to the onAddWall/
 * onAddPillar/onAddBeam/onAddSlab callbacks - the same ones the Manual
 * Build tab uses) since those are the only four object types the
 * engine implements - every other item is a disabled placeholder
 * rather than a click that does nothing, per the "disabled states for
 * unavailable actions" requirement.
 */
export function createConstructionRibbon(
  onAddWall: () => void,
  onAddPillar: () => void,
  onAddBeam: () => void,
  onAddSlab: () => void
): HTMLElement {
  const handlers: Partial<Record<string, () => void>> = {
    Wall: onAddWall,
    Pillar: onAddPillar,
    Beam: onAddBeam,
    Slab: onAddSlab
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
