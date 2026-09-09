import { el } from "./dom";

/** One label/value row, e.g. "Position X" / "0.00". Value is a placeholder. */
function propertyRow(label: string, value: string): HTMLElement {
  return el("div", { className: "property-row" }, [
    el("span", { className: "property-row__label", text: label }),
    el("span", { className: "property-row__value", text: value })
  ]);
}

function section(title: string, rows: HTMLElement[]): HTMLElement {
  return el("div", { className: "sidebar__section" }, [
    el("h3", { className: "sidebar__section-title", text: title }),
    ...rows
  ]);
}

/**
 * Right sidebar: inspector-style panels (Properties, Transform,
 * Dimensions, Material, Color). Nothing is wired to real scene data
 * yet - all values are static placeholders until object selection
 * exists.
 */
export function createRightSidebar(): HTMLElement {
  const properties = section("Properties", [
    propertyRow("Name", "—"),
    propertyRow("Type", "—")
  ]);

  const transform = section("Transform", [
    propertyRow("Position X", "0.00"),
    propertyRow("Position Y", "0.00"),
    propertyRow("Position Z", "0.00"),
    propertyRow("Rotation", "0.00°"),
    propertyRow("Scale", "1.00")
  ]);

  const dimensions = section("Dimensions", [
    propertyRow("Width", "—"),
    propertyRow("Height", "—"),
    propertyRow("Depth", "—")
  ]);

  const material = section("Material", [propertyRow("Material", "None")]);

  const color = section("Color", [
    el("div", { className: "property-row" }, [
      el("span", { className: "property-row__label", text: "Color" }),
      el("span", { className: "color-swatch color-swatch--placeholder" })
    ])
  ]);

  return el("aside", { className: "sidebar sidebar--right" }, [properties, transform, dimensions, material, color]);
}
