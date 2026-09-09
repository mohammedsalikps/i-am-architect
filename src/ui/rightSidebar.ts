import { el } from "./dom";
import type { WallData } from "../engine/wall/types";
import type { WallStore } from "../engine/wall/WallStore";
import type { SelectionStore } from "../engine/selection/SelectionStore";
import type { WallHistoryController } from "../engine/history/wallHistory";

function section(title: string, rows: HTMLElement[]): HTMLElement {
  return el("div", { className: "sidebar__section" }, [
    el("h3", { className: "sidebar__section-title", text: title }),
    ...rows
  ]);
}

function readOnlyRow(label: string, value: string): HTMLElement {
  return el("div", { className: "property-row" }, [
    el("span", { className: "property-row__label", text: label }),
    el("span", { className: "property-row__value", text: value })
  ]);
}

/**
 * A numeric field that commits on blur/Enter and reverts on invalid
 * input. `min` is optional: dimensions pass a positive floor, while
 * position/rotation fields omit it (negative values are valid there) -
 * either way NaN/non-finite input is always rejected.
 */
function numberInputRow(
  label: string,
  value: number,
  onChange: (value: number) => void,
  options: { min?: number; step: number }
): HTMLElement {
  const input = el("input", {
    className: "property-row__input",
    attrs: {
      type: "number",
      value: String(value),
      step: String(options.step),
      ...(options.min !== undefined ? { min: String(options.min) } : {})
    }
  });

  input.addEventListener("change", () => {
    const parsed = Number(input.value);
    const isValid = Number.isFinite(parsed) && (options.min === undefined || parsed >= options.min);
    if (isValid) {
      onChange(parsed);
    } else {
      input.value = String(value); // revert invalid input
    }
  });

  return el("div", { className: "property-row" }, [
    el("span", { className: "property-row__label", text: label }),
    input
  ]);
}

function colorInputRow(label: string, value: string, onChange: (value: string) => void): HTMLElement {
  const input = el("input", {
    className: "property-row__color-input",
    attrs: { type: "color", value }
  });
  // "change" (fires when the picker closes) rather than "input" (fires on every
  // drag tick) - the latter would trigger a re-render mid-interaction and could
  // close the native color picker by replacing its own input element.
  input.addEventListener("change", () => onChange(input.value));

  return el("div", { className: "property-row" }, [
    el("span", { className: "property-row__label", text: label }),
    input
  ]);
}

function formatMeters(value: number): string {
  return `${value.toFixed(2)} m`;
}

function radiansToDegrees(radians: number): number {
  return (radians * 180) / Math.PI;
}

function degreesToRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

function buildWallPanels(wall: WallData, wallHistory: WallHistoryController): HTMLElement[] {
  const properties = section("Properties", [readOnlyRow("Name", "Wall"), readOnlyRow("Type", wall.type)]);

  // Rounded for display only - onChange still converts the raw typed value,
  // this just avoids showing float noise like "44.99999999999999".
  const rotationDegrees = Math.round(radiansToDegrees(wall.rotation) * 100) / 100;

  const transform = section("Transform", [
    numberInputRow(
      "Position X",
      wall.position.x,
      (value) => wallHistory.update(wall.id, { position: { ...wall.position, x: value } }),
      { step: 0.1 }
    ),
    readOnlyRow("Position Y", formatMeters(wall.position.y)),
    numberInputRow(
      "Position Z",
      wall.position.z,
      (value) => wallHistory.update(wall.id, { position: { ...wall.position, z: value } }),
      { step: 0.1 }
    ),
    numberInputRow(
      "Rotation Y",
      rotationDegrees,
      (value) => wallHistory.update(wall.id, { rotation: degreesToRadians(value) }),
      { step: 1 }
    )
  ]);

  const dimensions = section("Dimensions", [
    numberInputRow("Length", wall.length, (value) => wallHistory.update(wall.id, { length: value }), {
      min: 0.1,
      step: 0.1
    }),
    numberInputRow("Height", wall.height, (value) => wallHistory.update(wall.id, { height: value }), {
      min: 0.1,
      step: 0.1
    }),
    numberInputRow("Thickness", wall.thickness, (value) => wallHistory.update(wall.id, { thickness: value }), {
      min: 0.05,
      step: 0.05
    })
  ]);

  const material = section("Material", [readOnlyRow("Material", wall.material)]);

  const color = section("Color", [
    colorInputRow("Color", wall.color, (value) => wallHistory.update(wall.id, { color: value }))
  ]);

  return [properties, transform, dimensions, material, color];
}

function buildEmptyState(): HTMLElement {
  return el("div", { className: "sidebar__section" }, [
    el("p", { className: "sidebar__placeholder", text: "Select a wall to view and edit its properties." })
  ]);
}

/**
 * Right sidebar / inspector. Reactive: subscribes to both stores and
 * re-renders whenever the selection or the selected wall's data
 * changes. Edits write back through wallHistory.update() (so every
 * edit is undoable) rather than wallStore directly - this module never
 * touches Three.js directly.
 */
export function createRightSidebar(
  wallStore: WallStore,
  selectionStore: SelectionStore,
  wallHistory: WallHistoryController
): HTMLElement {
  const panel = el("aside", { className: "sidebar sidebar--right" });

  const render = (): void => {
    const selectedId = selectionStore.get();
    const wall = selectedId ? wallStore.get(selectedId) : undefined;

    panel.replaceChildren(...(wall ? buildWallPanels(wall, wallHistory) : [buildEmptyState()]));
  };

  wallStore.subscribe(render);
  selectionStore.subscribe(render);

  return panel;
}
