import { el } from "./dom";
import { createTabStrip, comingSoon } from "./tabStrip";
import type { WallData } from "../engine/wall/types";
import type { WallStore } from "../engine/wall/WallStore";
import type { SelectionStore } from "../engine/selection/SelectionStore";
import type { CommandExecutor } from "../engine/commands/CommandExecutor";
import type { UpdateWallCommand } from "../engine/commands/types";

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

function buildWallPanels(
  wall: WallData,
  commandExecutor: CommandExecutor,
  onDuplicateWall: () => void,
  onDeleteWall: () => void
): HTMLElement[] {
  const duplicateButton = el("button", {
    className: "toolbar-button",
    text: "Duplicate",
    attrs: { type: "button" }
  });
  duplicateButton.addEventListener("click", onDuplicateWall);

  const deleteButton = el("button", {
    className: "toolbar-button toolbar-button--danger",
    text: "Delete",
    attrs: { type: "button" }
  });
  deleteButton.addEventListener("click", onDeleteWall);

  const actions = el("div", { className: "property-panel__actions" }, [duplicateButton, deleteButton]);

  const properties = section("Properties", [readOnlyRow("Name", "Wall"), readOnlyRow("Type", wall.type)]);

  // Rounded for display only - onChange still converts the raw typed value,
  // this just avoids showing float noise like "44.99999999999999".
  const rotationDegrees = Math.round(radiansToDegrees(wall.rotation) * 100) / 100;

  const updateWall = (changes: UpdateWallCommand["changes"]): void => {
    commandExecutor.execute({ type: "wall.update", id: wall.id, changes });
  };

  const transform = section("Transform", [
    numberInputRow(
      "Position X",
      wall.position.x,
      (value) => updateWall({ position: { ...wall.position, x: value } }),
      { step: 0.1 }
    ),
    readOnlyRow("Position Y", formatMeters(wall.position.y)),
    numberInputRow(
      "Position Z",
      wall.position.z,
      (value) => updateWall({ position: { ...wall.position, z: value } }),
      { step: 0.1 }
    ),
    numberInputRow("Rotation Y", rotationDegrees, (value) => updateWall({ rotation: degreesToRadians(value) }), {
      step: 1
    })
  ]);

  const dimensions = section("Dimensions", [
    numberInputRow(
      "Length",
      wall.dimensions.length,
      (value) => updateWall({ dimensions: { ...wall.dimensions, length: value } }),
      { min: 0.1, step: 0.1 }
    ),
    numberInputRow(
      "Height",
      wall.dimensions.height,
      (value) => updateWall({ dimensions: { ...wall.dimensions, height: value } }),
      { min: 0.1, step: 0.1 }
    ),
    numberInputRow(
      "Thickness",
      wall.dimensions.thickness,
      (value) => updateWall({ dimensions: { ...wall.dimensions, thickness: value } }),
      { min: 0.05, step: 0.05 }
    )
  ]);

  const material = section("Material", [readOnlyRow("Material", wall.material)]);

  const color = section("Color", [colorInputRow("Color", wall.color, (value) => updateWall({ color: value }))]);

  return [actions, properties, transform, dimensions, material, color];
}

function buildEmptyState(): HTMLElement {
  return el("div", { className: "sidebar__section" }, [
    el("p", { className: "sidebar__placeholder", text: "Select a wall to view and edit its properties." })
  ]);
}

export type RightSidebarOptions = {
  wallStore: WallStore;
  selectionStore: SelectionStore;
  commandExecutor: CommandExecutor;
  onDuplicateWall: () => void;
  onDeleteWall: () => void;
};

/**
 * Right sidebar / inspector. Tabbed: Properties/Materials/Blocks/
 * Colors. Properties is the existing wall editor - reactive, subscribes
 * to both stores and re-renders whenever the selection or the selected
 * wall's data changes, plus Duplicate/Delete (moved in from the old
 * header, same callbacks). Materials/Blocks/Colors are "Coming soon" -
 * this milestone doesn't add material libraries or block catalogs.
 *
 * Reads come straight from wallStore; edits go through
 * commandExecutor.execute() (a "wall.update" command) rather than
 * touching wallStore or WallHistoryController directly - this module
 * never touches Three.js directly either.
 */
export function createRightSidebar(options: RightSidebarOptions): HTMLElement {
  const properties = el("div", { className: "property-panel" });

  const render = (): void => {
    const selectedId = options.selectionStore.get();
    const wall = selectedId ? options.wallStore.get(selectedId) : undefined;

    properties.replaceChildren(
      ...(wall
        ? buildWallPanels(wall, options.commandExecutor, options.onDuplicateWall, options.onDeleteWall)
        : [buildEmptyState()])
    );
  };

  options.wallStore.subscribe(render);
  options.selectionStore.subscribe(render);

  const { strip, panel } = createTabStrip(
    [
      { id: "properties", label: "Properties", build: () => properties },
      { id: "materials", label: "Materials", build: () => comingSoon("The material library"), disabled: true },
      { id: "blocks", label: "Blocks", build: () => comingSoon("Reusable blocks"), disabled: true },
      { id: "colors", label: "Colors", build: () => comingSoon("Saved color palettes"), disabled: true }
    ],
    "sidebar-tabs",
    "sidebar-tabs__item"
  );

  return el("aside", { className: "sidebar sidebar--right" }, [strip, panel]);
}
