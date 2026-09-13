import { el } from "./dom";
import { createTabStrip, comingSoon } from "./tabStrip";
import { ELEMENT_CATEGORIES, getElementKind } from "../engine/elements/catalog";
import type { ElementKindDefinition, ParamSpec } from "../engine/elements/catalog";
import { MATERIAL_LIBRARY, getMaterial, materialsFor } from "../engine/materials/materialLibrary";
import type { MaterialDefinition } from "../engine/materials/materialLibrary";
import { materialSwatchStyle } from "./materialSwatches";
import { isRoom, objectsInRoom, roomArea } from "../engine/elements/rooms";
import { isConnectable, kindsConnect } from "../engine/connections/connections";
import { resolveConstructionObject } from "../engine/objects/resolveConstructionObject";
import type { WallData } from "../engine/wall/types";
import type { WallStore } from "../engine/wall/WallStore";
import type { PillarData } from "../engine/pillar/types";
import type { PillarStore } from "../engine/pillar/PillarStore";
import type { BeamData } from "../engine/beam/types";
import type { BeamStore } from "../engine/beam/BeamStore";
import type { SlabData } from "../engine/slab/types";
import type { SlabStore } from "../engine/slab/SlabStore";
import type { DoorData } from "../engine/door/types";
import type { DoorStore } from "../engine/door/DoorStore";
import type { WindowData } from "../engine/window/types";
import type { WindowStore } from "../engine/window/WindowStore";
import type { ElementData } from "../engine/elements/types";
import type { ElementStore } from "../engine/elements/ElementStore";
import { getAssetDefinition } from "../engine/assets/catalog";
import type { AssetData } from "../engine/assets/types";
import type { AssetStore } from "../engine/assets/AssetStore";
import type { SelectionStore } from "../engine/selection/SelectionStore";
import type { CommandExecutor } from "../engine/commands/CommandExecutor";
import type {
  UpdateWallCommand,
  UpdatePillarCommand,
  UpdateBeamCommand,
  UpdateSlabCommand,
  UpdateDoorCommand,
  UpdateWindowCommand,
  UpdateElementCommand,
  UpdateAssetCommand
} from "../engine/commands/types";

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
 * Makes Enter commit a field. A number input doesn't fire "change" on
 * Enter by itself - only on blur - which left an edit pending until the
 * next click, and that click's commit re-rendered the UI under it and
 * swallowed it. Blurring on Enter fires the ordinary "change".
 */
function commitOnEnter(input: HTMLInputElement): void {
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      input.blur();
    }
  });
}

interface NumberInputOptions {
  min?: number;
  max?: number;
  step: number;
  /** Only whole numbers are accepted. */
  integer?: boolean;
}

/**
 * A numeric field that commits on blur/Enter and reverts on invalid
 * input. `min` is optional: dimensions pass a positive floor, while
 * position/rotation fields omit it (negative values are valid there) -
 * either way NaN/non-finite input is always rejected. An `onChange` that
 * returns false (its command was rejected) also reverts the field.
 */
function numberInputRow(
  label: string,
  value: number,
  onChange: (value: number) => void | boolean,
  options: NumberInputOptions
): HTMLElement {
  // Shown to 4 decimals - a derived value (a hosted door's position in a
  // turned wall) would otherwise show float noise. Display only: the model
  // changes only when a new value is typed.
  const shown = String(Math.round(value * 10000) / 10000);
  const input = el("input", {
    className: "property-row__input",
    attrs: {
      type: "number",
      value: shown,
      step: String(options.step),
      "aria-label": label,
      ...(options.min !== undefined ? { min: String(options.min) } : {}),
      ...(options.max !== undefined ? { max: String(options.max) } : {})
    }
  });

  input.addEventListener("change", () => {
    const parsed = Number(input.value);
    const isValid =
      Number.isFinite(parsed) &&
      (options.min === undefined || parsed >= options.min) &&
      (options.max === undefined || parsed <= options.max) &&
      (!options.integer || Number.isInteger(parsed));
    if (isValid && onChange(parsed) !== false) {
      return;
    }
    input.value = shown; // revert invalid (or rejected) input
  });
  commitOnEnter(input);

  return el("div", { className: "property-row" }, [
    el("span", { className: "property-row__label", text: label }),
    input
  ]);
}

function colorInputRow(label: string, value: string, onChange: (value: string) => void): HTMLElement {
  const input = el("input", {
    className: "property-row__color-input",
    attrs: { type: "color", value, "aria-label": label }
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

/** A free-text field (e.g. an element's name) that commits on blur/Enter. Blank input is reverted rather than stored. */
function textInputRow(label: string, value: string, onChange: (value: string) => void): HTMLElement {
  const input = el("input", {
    className: "property-row__input property-row__input--text",
    attrs: { type: "text", value, "aria-label": label }
  });
  input.addEventListener("change", () => {
    const next = input.value.trim();
    if (next.length > 0 && next !== value) {
      onChange(next);
    } else {
      input.value = value; // revert blank (or unchanged) input
    }
  });
  commitOnEnter(input);

  return el("div", { className: "property-row" }, [
    el("span", { className: "property-row__label", text: label }),
    input
  ]);
}

/** A drop-down that commits as soon as a different option is chosen. */
function selectRow(label: string, value: string, choices: readonly { value: string; label: string }[], onChange: (value: string) => void): HTMLElement {
  const select = el(
    "select",
    { className: "property-row__input property-row__select", attrs: { "aria-label": label } },
    choices.map((choice) => el("option", { text: choice.label, attrs: { value: choice.value } }))
  );
  select.value = value;
  select.addEventListener("change", () => {
    if (select.value !== value) {
      onChange(select.value);
    }
  });

  return el("div", { className: "property-row" }, [
    el("span", { className: "property-row__label", text: label }),
    select
  ]);
}

/**
 * The material drop-down: library materials suited to the object. A value
 * that isn't among them - a free-text material saved on one of the six
 * original types, or a library material outside the suggested categories -
 * stays listed, so showing the panel never changes the object.
 */
function materialSelectRow(value: string, choices: readonly MaterialDefinition[], onChange: (value: string) => void): HTMLElement {
  const options = choices.map((material) => ({ value: material.id, label: material.label }));
  if (!choices.some((material) => material.id === value)) {
    const library = getMaterial(value);
    options.unshift({ value, label: library ? library.label : `${value} (custom)` });
  }
  return selectRow("Material", value, options, onChange);
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

/** Rounded for display only - avoids showing float noise like "44.99999999999999". */
function displayDegrees(radians: number): number {
  return Math.round(radiansToDegrees(radians) * 100) / 100;
}

function displayNumber(value: number): number {
  return Math.round(value * 1000) / 1000;
}

let cachedActionsRow: { onDuplicateSelected: () => void; onDeleteSelected: () => void; row: HTMLElement } | null = null;

/**
 * The Duplicate/Delete action row every type's panel starts with. Built
 * once and reused by every re-render: pressing Delete while a field edit
 * is still pending commits that edit (blur), which re-renders the panel
 * mid-click - a freshly built button would then swallow the click.
 */
function buildActionsRow(onDuplicateSelected: () => void, onDeleteSelected: () => void): HTMLElement {
  if (
    cachedActionsRow &&
    cachedActionsRow.onDuplicateSelected === onDuplicateSelected &&
    cachedActionsRow.onDeleteSelected === onDeleteSelected
  ) {
    return cachedActionsRow.row;
  }

  const duplicateButton = el("button", {
    className: "toolbar-button",
    text: "Duplicate",
    attrs: { type: "button" }
  });
  duplicateButton.addEventListener("click", onDuplicateSelected);

  const deleteButton = el("button", {
    className: "toolbar-button toolbar-button--danger",
    text: "Delete",
    attrs: { type: "button" }
  });
  deleteButton.addEventListener("click", onDeleteSelected);

  const row = el("div", { className: "property-panel__actions" }, [duplicateButton, deleteButton]);
  cachedActionsRow = { onDuplicateSelected, onDeleteSelected, row };
  return row;
}

function buildWallPanels(
  wall: WallData,
  commandExecutor: CommandExecutor,
  onDuplicateSelected: () => void,
  onDeleteSelected: () => void
): HTMLElement[] {
  const actions = buildActionsRow(onDuplicateSelected, onDeleteSelected);

  const properties = section("Properties", [readOnlyRow("Name", "Wall"), readOnlyRow("Type", wall.type)]);

  const rotationDegrees = displayDegrees(wall.rotation);

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

  const material = section("Material", [materialSelectRow(wall.material, materialsFor(), (value) => updateWall({ material: value }))]);

  const color = section("Color", [colorInputRow("Color", wall.color, (value) => updateWall({ color: value }))]);

  return [actions, properties, transform, dimensions, material, color];
}

/**
 * Pillar's own panel builder - deliberately separate from
 * buildWallPanels rather than a shared generic-over-dimensions version:
 * a wall's fields (length/height/thickness) and a pillar's
 * (width/depth/height) aren't interchangeable, and keeping them as two
 * concrete, type-safe functions means neither one has to guess which
 * fields the other actually has. Structurally near-identical by
 * design - see rightSidebar's module doc.
 */
function buildPillarPanels(
  pillar: PillarData,
  commandExecutor: CommandExecutor,
  onDuplicateSelected: () => void,
  onDeleteSelected: () => void
): HTMLElement[] {
  const actions = buildActionsRow(onDuplicateSelected, onDeleteSelected);

  const properties = section("Properties", [readOnlyRow("Name", "Pillar"), readOnlyRow("Type", pillar.type)]);

  const rotationDegrees = displayDegrees(pillar.rotation);

  const updatePillar = (changes: UpdatePillarCommand["changes"]): void => {
    commandExecutor.execute({ type: "pillar.update", id: pillar.id, changes });
  };

  const transform = section("Transform", [
    numberInputRow(
      "Position X",
      pillar.position.x,
      (value) => updatePillar({ position: { ...pillar.position, x: value } }),
      { step: 0.1 }
    ),
    numberInputRow(
      "Position Y",
      pillar.position.y,
      (value) => updatePillar({ position: { ...pillar.position, y: value } }),
      { step: 0.1 }
    ),
    numberInputRow(
      "Position Z",
      pillar.position.z,
      (value) => updatePillar({ position: { ...pillar.position, z: value } }),
      { step: 0.1 }
    ),
    numberInputRow(
      "Rotation Y",
      rotationDegrees,
      (value) => updatePillar({ rotation: degreesToRadians(value) }),
      { step: 1 }
    )
  ]);

  const dimensions = section("Dimensions", [
    numberInputRow(
      "Width",
      pillar.dimensions.width,
      (value) => updatePillar({ dimensions: { ...pillar.dimensions, width: value } }),
      { min: 0.05, step: 0.05 }
    ),
    numberInputRow(
      "Depth",
      pillar.dimensions.depth,
      (value) => updatePillar({ dimensions: { ...pillar.dimensions, depth: value } }),
      { min: 0.05, step: 0.05 }
    ),
    numberInputRow(
      "Height",
      pillar.dimensions.height,
      (value) => updatePillar({ dimensions: { ...pillar.dimensions, height: value } }),
      { min: 0.1, step: 0.1 }
    )
  ]);

  const material = section("Material", [materialSelectRow(pillar.material, materialsFor(), (value) => updatePillar({ material: value }))]);

  const color = section("Color", [colorInputRow("Color", pillar.color, (value) => updatePillar({ color: value }))]);

  return [actions, properties, transform, dimensions, material, color];
}

/**
 * Beam's own panel builder - deliberately separate from
 * buildWallPanels/buildPillarPanels for the same reason pillar's is:
 * a beam's fields (length/width/height) aren't interchangeable with
 * either sibling's, and two concrete, type-safe functions mean neither
 * has to guess which fields the other actually has.
 */
function buildBeamPanels(
  beam: BeamData,
  commandExecutor: CommandExecutor,
  onDuplicateSelected: () => void,
  onDeleteSelected: () => void
): HTMLElement[] {
  const actions = buildActionsRow(onDuplicateSelected, onDeleteSelected);

  const properties = section("Properties", [readOnlyRow("Name", "Beam"), readOnlyRow("Type", beam.type)]);

  const rotationDegrees = displayDegrees(beam.rotation);

  const updateBeam = (changes: UpdateBeamCommand["changes"]): void => {
    commandExecutor.execute({ type: "beam.update", id: beam.id, changes });
  };

  const transform = section("Transform", [
    numberInputRow(
      "Position X",
      beam.position.x,
      (value) => updateBeam({ position: { ...beam.position, x: value } }),
      { step: 0.1 }
    ),
    numberInputRow(
      "Position Y",
      beam.position.y,
      (value) => updateBeam({ position: { ...beam.position, y: value } }),
      { step: 0.1 }
    ),
    numberInputRow(
      "Position Z",
      beam.position.z,
      (value) => updateBeam({ position: { ...beam.position, z: value } }),
      { step: 0.1 }
    ),
    numberInputRow("Rotation Y", rotationDegrees, (value) => updateBeam({ rotation: degreesToRadians(value) }), {
      step: 1
    })
  ]);

  const dimensions = section("Dimensions", [
    numberInputRow(
      "Length",
      beam.dimensions.length,
      (value) => updateBeam({ dimensions: { ...beam.dimensions, length: value } }),
      { min: 0.1, step: 0.1 }
    ),
    numberInputRow(
      "Width",
      beam.dimensions.width,
      (value) => updateBeam({ dimensions: { ...beam.dimensions, width: value } }),
      { min: 0.05, step: 0.05 }
    ),
    numberInputRow(
      "Height",
      beam.dimensions.height,
      (value) => updateBeam({ dimensions: { ...beam.dimensions, height: value } }),
      { min: 0.05, step: 0.05 }
    )
  ]);

  const material = section("Material", [materialSelectRow(beam.material, materialsFor(), (value) => updateBeam({ material: value }))]);

  const color = section("Color", [colorInputRow("Color", beam.color, (value) => updateBeam({ color: value }))]);

  return [actions, properties, transform, dimensions, material, color];
}

/**
 * Slab's own panel builder - deliberately separate from the other
 * three for the same reason each of theirs is: a slab's fields
 * (length/width/thickness) aren't interchangeable with any sibling's,
 * and a concrete, type-safe function means it never has to guess which
 * fields another type actually has.
 */
function buildSlabPanels(
  slab: SlabData,
  commandExecutor: CommandExecutor,
  onDuplicateSelected: () => void,
  onDeleteSelected: () => void
): HTMLElement[] {
  const actions = buildActionsRow(onDuplicateSelected, onDeleteSelected);

  const properties = section("Properties", [readOnlyRow("Name", "Slab"), readOnlyRow("Type", slab.type)]);

  const rotationDegrees = displayDegrees(slab.rotation);

  const updateSlab = (changes: UpdateSlabCommand["changes"]): void => {
    commandExecutor.execute({ type: "slab.update", id: slab.id, changes });
  };

  const transform = section("Transform", [
    numberInputRow(
      "Position X",
      slab.position.x,
      (value) => updateSlab({ position: { ...slab.position, x: value } }),
      { step: 0.1 }
    ),
    numberInputRow(
      "Position Y",
      slab.position.y,
      (value) => updateSlab({ position: { ...slab.position, y: value } }),
      { step: 0.1 }
    ),
    numberInputRow(
      "Position Z",
      slab.position.z,
      (value) => updateSlab({ position: { ...slab.position, z: value } }),
      { step: 0.1 }
    ),
    numberInputRow("Rotation Y", rotationDegrees, (value) => updateSlab({ rotation: degreesToRadians(value) }), {
      step: 1
    })
  ]);

  const dimensions = section("Dimensions", [
    numberInputRow(
      "Length",
      slab.dimensions.length,
      (value) => updateSlab({ dimensions: { ...slab.dimensions, length: value } }),
      { min: 0.1, step: 0.1 }
    ),
    numberInputRow(
      "Width",
      slab.dimensions.width,
      (value) => updateSlab({ dimensions: { ...slab.dimensions, width: value } }),
      { min: 0.1, step: 0.1 }
    ),
    numberInputRow(
      "Thickness",
      slab.dimensions.thickness,
      (value) => updateSlab({ dimensions: { ...slab.dimensions, thickness: value } }),
      { min: 0.02, step: 0.02 }
    )
  ]);

  const material = section("Material", [materialSelectRow(slab.material, materialsFor(), (value) => updateSlab({ material: value }))]);

  const color = section("Color", [colorInputRow("Color", slab.color, (value) => updateSlab({ color: value }))]);

  return [actions, properties, transform, dimensions, material, color];
}

/**
 * Door's own panel builder - deliberately separate from every sibling
 * for the same reason each of theirs is: a door's fields (width/
 * height/thickness) aren't interchangeable with any sibling's, and a
 * concrete, type-safe function means it never has to guess which
 * fields another type actually has. (Door and window happen to share
 * the same dimensions shape, but stay two separate functions anyway -
 * see rightSidebar's module doc.) `hostLabel` says which wall, if any,
 * the door belongs to.
 */
function buildDoorPanels(
  door: DoorData,
  hostLabel: string,
  commandExecutor: CommandExecutor,
  onDuplicateSelected: () => void,
  onDeleteSelected: () => void
): HTMLElement[] {
  const actions = buildActionsRow(onDuplicateSelected, onDeleteSelected);

  const properties = section("Properties", [readOnlyRow("Name", "Door"), readOnlyRow("Type", door.type)]);

  const rotationDegrees = displayDegrees(door.rotation);

  const updateDoor = (changes: UpdateDoorCommand["changes"]): void => {
    commandExecutor.execute({ type: "door.update", id: door.id, changes });
  };

  const transform = section("Transform", [
    numberInputRow(
      "Position X",
      door.position.x,
      (value) => updateDoor({ position: { ...door.position, x: value } }),
      { step: 0.1 }
    ),
    numberInputRow(
      "Position Y",
      door.position.y,
      (value) => updateDoor({ position: { ...door.position, y: value } }),
      { step: 0.1 }
    ),
    numberInputRow(
      "Position Z",
      door.position.z,
      (value) => updateDoor({ position: { ...door.position, z: value } }),
      { step: 0.1 }
    ),
    // A door in a wall turns with the wall - its rotation isn't its own.
    door.hostId
      ? readOnlyRow("Rotation Y", `${rotationDegrees}° (turns with ${hostLabel})`)
      : numberInputRow("Rotation Y", rotationDegrees, (value) => updateDoor({ rotation: degreesToRadians(value) }), {
          step: 1
        })
  ]);

  const dimensions = section("Dimensions", [
    numberInputRow(
      "Width",
      door.dimensions.width,
      (value) => updateDoor({ dimensions: { ...door.dimensions, width: value } }),
      { min: 0.1, step: 0.05 }
    ),
    numberInputRow(
      "Height",
      door.dimensions.height,
      (value) => updateDoor({ dimensions: { ...door.dimensions, height: value } }),
      { min: 0.1, step: 0.05 }
    ),
    numberInputRow(
      "Thickness",
      door.dimensions.thickness,
      (value) => updateDoor({ dimensions: { ...door.dimensions, thickness: value } }),
      { min: 0.01, step: 0.01 }
    )
  ]);

  const material = section("Material", [materialSelectRow(door.material, materialsFor(), (value) => updateDoor({ material: value }))]);

  const color = section("Color", [colorInputRow("Color", door.color, (value) => updateDoor({ color: value }))]);

  return [actions, properties, transform, dimensions, material, color];
}

/**
 * Window's own panel builder - see buildDoorPanels' doc for why this
 * stays separate from it despite the identical dimensions shape.
 */
function buildWindowPanels(
  windowData: WindowData,
  hostLabel: string,
  commandExecutor: CommandExecutor,
  onDuplicateSelected: () => void,
  onDeleteSelected: () => void
): HTMLElement[] {
  const actions = buildActionsRow(onDuplicateSelected, onDeleteSelected);

  const properties = section("Properties", [readOnlyRow("Name", "Window"), readOnlyRow("Type", windowData.type)]);

  const rotationDegrees = displayDegrees(windowData.rotation);

  const updateWindow = (changes: UpdateWindowCommand["changes"]): void => {
    commandExecutor.execute({ type: "window.update", id: windowData.id, changes });
  };

  const transform = section("Transform", [
    numberInputRow(
      "Position X",
      windowData.position.x,
      (value) => updateWindow({ position: { ...windowData.position, x: value } }),
      { step: 0.1 }
    ),
    numberInputRow(
      "Position Y",
      windowData.position.y,
      (value) => updateWindow({ position: { ...windowData.position, y: value } }),
      { step: 0.1 }
    ),
    numberInputRow(
      "Position Z",
      windowData.position.z,
      (value) => updateWindow({ position: { ...windowData.position, z: value } }),
      { step: 0.1 }
    ),
    // A window in a wall turns with the wall - its rotation isn't its own.
    windowData.hostId
      ? readOnlyRow("Rotation Y", `${rotationDegrees}° (turns with ${hostLabel})`)
      : numberInputRow(
          "Rotation Y",
          rotationDegrees,
          (value) => updateWindow({ rotation: degreesToRadians(value) }),
          { step: 1 }
        )
  ]);

  const dimensions = section("Dimensions", [
    numberInputRow(
      "Width",
      windowData.dimensions.width,
      (value) => updateWindow({ dimensions: { ...windowData.dimensions, width: value } }),
      { min: 0.1, step: 0.05 }
    ),
    numberInputRow(
      "Height",
      windowData.dimensions.height,
      (value) => updateWindow({ dimensions: { ...windowData.dimensions, height: value } }),
      { min: 0.1, step: 0.05 }
    ),
    numberInputRow(
      "Thickness",
      windowData.dimensions.thickness,
      (value) => updateWindow({ dimensions: { ...windowData.dimensions, thickness: value } }),
      { min: 0.01, step: 0.01 }
    )
  ]);

  const material = section("Material", [
    materialSelectRow(windowData.material, materialsFor(), (value) => updateWindow({ material: value }))
  ]);

  const color = section("Color", [
    colorInputRow("Color", windowData.color, (value) => updateWindow({ color: value }))
  ]);

  return [actions, properties, transform, dimensions, material, color];
}

/**
 * A placed design asset's own panel - deliberately separate from the six
 * original types' builders and from buildElementPanels, for the same
 * reason every type has its own: an asset's fields (a catalog assetId
 * and category, a real-meters width/height/depth box) aren't the same
 * shape as a construction element's (a kind, params, connections) - see
 * engine/assets/types.ts's own docs for why design assets are a
 * genuinely separate model, not a variant of ElementData. Editable name
 * (task section 10's "ASSET" section: Name/Category/Asset ID) mirrors
 * how buildElementPanels already lets a room be renamed.
 */
function buildAssetPanels(asset: AssetData, commandExecutor: CommandExecutor, onDuplicateSelected: () => void, onDeleteSelected: () => void): HTMLElement[] {
  const actions = buildActionsRow(onDuplicateSelected, onDeleteSelected);
  const definition = getAssetDefinition(asset.assetId);

  const updateAsset = (changes: UpdateAssetCommand["changes"]): void => {
    commandExecutor.execute({ type: "asset.update", id: asset.id, changes });
  };

  const properties = section("Asset", [
    textInputRow("Name", asset.label, (value) => updateAsset({ label: value })),
    readOnlyRow("Category", definition?.category ?? "unknown"),
    readOnlyRow("Asset ID", asset.assetId)
  ]);

  const rotationDegrees = displayDegrees(asset.rotation);
  const transform = section("Transform", [
    numberInputRow("Position X", asset.position.x, (value) => updateAsset({ position: { ...asset.position, x: value } }), { step: 0.1 }),
    numberInputRow("Position Y", asset.position.y, (value) => updateAsset({ position: { ...asset.position, y: value } }), { step: 0.1 }),
    numberInputRow("Position Z", asset.position.z, (value) => updateAsset({ position: { ...asset.position, z: value } }), { step: 0.1 }),
    numberInputRow("Rotation Y", rotationDegrees, (value) => updateAsset({ rotation: degreesToRadians(value) }), { step: 1 })
  ]);

  const dimensions = section("Dimensions", [
    numberInputRow("Width", asset.dimensions.width, (value) => updateAsset({ dimensions: { ...asset.dimensions, width: value } }), { min: 0.05, step: 0.05 }),
    numberInputRow("Height", asset.dimensions.height, (value) => updateAsset({ dimensions: { ...asset.dimensions, height: value } }), {
      min: 0.05,
      step: 0.05
    }),
    numberInputRow("Depth", asset.dimensions.depth, (value) => updateAsset({ dimensions: { ...asset.dimensions, depth: value } }), { min: 0.05, step: 0.05 })
  ]);

  const material = section("Material", [
    materialSelectRow(asset.material, materialsFor(definition?.materialCategories), (value) => updateAsset({ material: value }))
  ]);

  const color = section("Color", [colorInputRow("Color", asset.color, (value) => updateAsset({ color: value }))]);

  return [actions, properties, transform, dimensions, material, color];
}

/** An object as the room section lists it. */
interface ListedObject {
  id: string;
  type: string;
  kind?: string;
  label?: string;
  position: { x: number; y: number; z: number };
}

function describeListed(object: ListedObject): string {
  const name = object.label ?? object.type.charAt(0).toUpperCase() + object.type.slice(1);
  return `${name} — ${object.id}`;
}

/** A linear element's two ends, from its center, length and rotation (local X runs along world (cos t, 0, -sin t)). */
function linearEnds(element: ElementData): { start: { x: number; z: number }; end: { x: number; z: number } } {
  const half = (element.dimensions.length ?? 0) / 2;
  const dx = Math.cos(element.rotation) * half;
  const dz = -Math.sin(element.rotation) * half;
  return {
    start: { x: displayNumber(element.position.x - dx), z: displayNumber(element.position.z - dz) },
    end: { x: displayNumber(element.position.x + dx), z: displayNumber(element.position.z + dz) }
  };
}

/** The center, rotation and length of a straight run from `start` to `end`, at height `y`. */
function runBetween(start: { x: number; z: number }, end: { x: number; z: number }, y: number) {
  const dx = end.x - start.x;
  const dz = end.z - start.z;
  return {
    position: { x: (start.x + end.x) / 2, y, z: (start.z + end.z) / 2 },
    rotation: Math.atan2(-dz, dx),
    length: Math.hypot(dx, dz)
  };
}

function paramRow(spec: ParamSpec, value: number | string, onChange: (value: number | string) => boolean): HTMLElement {
  if (spec.kind === "integer") {
    return numberInputRow(spec.label, Number(value), (next) => onChange(next), { min: spec.min, max: spec.max, step: 1, integer: true });
  }
  return selectRow(
    spec.label,
    String(value),
    spec.options.map((option) => ({ value: option, label: option.charAt(0).toUpperCase() + option.slice(1) })),
    (next) => {
      onChange(next);
    }
  );
}

/**
 * One panel builder for every element kind, driven by its catalog entry:
 * name, the kind's own dimensions (with its minimums and steps), its
 * parameters, the materials that suit it, and color. A room also shows
 * its area and the objects standing in it; a linear element (pipe,
 * conduit, cable) also shows - and edits - its start and end points.
 * Every edit is an element.update command.
 */
function buildElementPanels(
  element: ElementData,
  definition: ElementKindDefinition,
  context: {
    commandExecutor: CommandExecutor;
    selectionStore: SelectionStore;
    allObjects: () => ListedObject[];
    onDuplicateSelected: () => void;
    onDeleteSelected: () => void;
  }
): HTMLElement[] {
  const actions = buildActionsRow(context.onDuplicateSelected, context.onDeleteSelected);

  const update = (changes: UpdateElementCommand["changes"]): boolean =>
    context.commandExecutor.execute({ type: "element.update", id: element.id, changes }).success;

  const categoryLabel = ELEMENT_CATEGORIES.find((category) => category.id === definition.category)?.label ?? definition.category;
  const panels: HTMLElement[] = [
    actions,
    section("Properties", [
      textInputRow("Name", element.label, (value) => {
        update({ label: value });
      }),
      readOnlyRow("Type", definition.label),
      readOnlyRow("Category", categoryLabel),
      readOnlyRow("Id", element.id)
    ])
  ];

  if (isRoom(element)) {
    const objects = context.allObjects();
    const insideIds = objectsInRoom(element, objects);
    const byId = new Map(objects.map((object) => [object.id, object]));
    const items = insideIds.map((id) => {
      const object = byId.get(id);
      const button = el("button", {
        className: "room-contents__item",
        text: object ? describeListed(object) : id,
        attrs: { type: "button" }
      });
      button.addEventListener("click", () => context.selectionStore.select(id));
      return button;
    });
    panels.push(
      section("Room", [
        readOnlyRow("Floor area", `${roomArea(element).toFixed(2)} m²`),
        readOnlyRow("Contains", `${insideIds.length} object${insideIds.length === 1 ? "" : "s"}`),
        el("div", { className: "room-contents" }, items)
      ])
    );
  }

  panels.push(
    section("Transform", [
      numberInputRow("Position X", element.position.x, (value) => update({ position: { ...element.position, x: value } }), { step: 0.1 }),
      numberInputRow("Position Y", element.position.y, (value) => update({ position: { ...element.position, y: value } }), { step: 0.1 }),
      numberInputRow("Position Z", element.position.z, (value) => update({ position: { ...element.position, z: value } }), { step: 0.1 }),
      numberInputRow("Rotation Y", displayDegrees(element.rotation), (value) => update({ rotation: degreesToRadians(value) }), { step: 1 })
    ])
  );

  if (definition.linear) {
    const { start, end } = linearEnds(element);
    const reroute = (nextStart: { x: number; z: number }, nextEnd: { x: number; z: number }): boolean => {
      const run = runBetween(nextStart, nextEnd, element.position.y);
      return update({ position: run.position, rotation: run.rotation, dimensions: { ...element.dimensions, length: run.length } });
    };
    panels.push(
      section("Run", [
        numberInputRow("Start X", start.x, (value) => reroute({ x: value, z: start.z }, end), { step: 0.1 }),
        numberInputRow("Start Z", start.z, (value) => reroute({ x: start.x, z: value }, end), { step: 0.1 }),
        numberInputRow("End X", end.x, (value) => reroute(start, { x: value, z: end.z }), { step: 0.1 }),
        numberInputRow("End Z", end.z, (value) => reroute(start, { x: end.x, z: value }), { step: 0.1 })
      ])
    );
  }

  panels.push(
    section(
      "Dimensions",
      definition.dimensions.map((spec) =>
        numberInputRow(
          spec.label,
          element.dimensions[spec.key],
          (value) => update({ dimensions: { ...element.dimensions, [spec.key]: value } }),
          { min: spec.min, step: spec.step }
        )
      )
    )
  );

  if (definition.params.length > 0) {
    panels.push(
      section(
        "Parameters",
        definition.params.map((spec) =>
          paramRow(spec, element.params[spec.key], (value) => update({ params: { ...element.params, [spec.key]: value } }))
        )
      )
    );
  }

  const suited = materialsFor(definition.materialCategories.length > 0 ? definition.materialCategories : ["generic"]);
  panels.push(
    section("Material", [
      materialSelectRow(element.material, suited, (value) => {
        update({ material: value });
      })
    ]),
    section("Color", [
      colorInputRow("Color", element.color, (value) => {
        update({ color: value });
      })
    ])
  );

  return panels;
}

/**
 * Nothing selected: instead of a bare placeholder sentence, a quiet
 * summary of what the project actually holds right now - "useful
 * project/design information" (task section 7). Purely a read of counts
 * already available in createRightSidebar (allObjects()/elementStore) -
 * no new store or counting logic of its own.
 */
function buildEmptyState(objectCount: number, roomCount: number): HTMLElement {
  const stats =
    objectCount === 0
      ? el("p", { className: "sidebar__placeholder empty-inspector__stat", text: "Nothing built yet." })
      : el("p", { className: "empty-inspector__stat", text: `${objectCount} object${objectCount === 1 ? "" : "s"}${roomCount > 0 ? ` · ${roomCount} room${roomCount === 1 ? "" : "s"}` : ""}` });
  return el("div", { className: "sidebar__section empty-inspector" }, [
    stats,
    el("p", {
      className: "sidebar__placeholder",
      text: "Select an object - in the viewport or the Project hierarchy - to view and edit its properties."
    })
  ]);
}

export type RightSidebarOptions = {
  wallStore: WallStore;
  pillarStore: PillarStore;
  beamStore: BeamStore;
  slabStore: SlabStore;
  doorStore: DoorStore;
  windowStore: WindowStore;
  elementStore: ElementStore;
  assetStore: AssetStore;
  selectionStore: SelectionStore;
  commandExecutor: CommandExecutor;
  onDuplicateSelected: () => void;
  onDeleteSelected: () => void;
};

const MATERIAL_CATEGORY_LABELS: Readonly<Record<string, string>> = {
  generic: "Generic",
  structural: "Structural",
  masonry: "Masonry",
  finish: "Finishes",
  wood: "Wood",
  glass: "Glass",
  metal: "Metal",
  ceramic: "Ceramic & tile",
  stone: "Stone",
  roofing: "Roofing",
  plumbing: "Plumbing",
  electrical: "Electrical",
  fabric: "Fabric",
  landscape: "Landscape"
};

/**
 * The Materials tab: the whole material library, by category. "Apply"
 * gives the selected object that material and its typical color - one
 * update_object command, so it is undoable like any edit, and the object
 * stays the same object.
 */
function createMaterialsPanel(options: RightSidebarOptions): HTMLElement {
  const stores = {
    wallStore: options.wallStore,
    pillarStore: options.pillarStore,
    beamStore: options.beamStore,
    slabStore: options.slabStore,
    doorStore: options.doorStore,
    windowStore: options.windowStore,
    elementStore: options.elementStore,
    assetStore: options.assetStore
  };
  const status = el("p", { className: "sidebar__placeholder material-library__status" });
  const applyButtons: HTMLButtonElement[] = [];

  const categories: string[] = [];
  for (const material of MATERIAL_LIBRARY) {
    if (!categories.includes(material.category)) {
      categories.push(material.category);
    }
  }

  const sections = categories.map((category) =>
    section(
      MATERIAL_CATEGORY_LABELS[category] ?? category,
      MATERIAL_LIBRARY.filter((material) => material.category === category).map((material) => {
        const apply = el("button", {
          className: "toolbar-button material-row__apply",
          text: "Apply",
          attrs: { type: "button", "aria-label": `Apply ${material.label} to the selected object` }
        });
        apply.addEventListener("click", () => {
          const objectId = options.selectionStore.get();
          if (objectId) {
            options.commandExecutor.execute({
              type: "update_object",
              objectId,
              changes: { material: material.id, color: material.color }
            });
          }
        });
        applyButtons.push(apply);
        return el("div", { className: "material-row", attrs: { "data-material": material.id } }, [
          el("span", { className: "material-row__swatch", attrs: { style: `background: ${materialSwatchStyle(material)}` } }),
          el("span", { className: "material-row__label", text: material.label }),
          apply
        ]);
      })
    )
  );

  const sync = (): void => {
    const selectedId = options.selectionStore.get();
    const selected = selectedId ? resolveConstructionObject(selectedId, stores) : null;
    status.textContent = selected
      ? `Applying to ${selectedId}.`
      : "Select an object, then apply a material to it.";
    for (const button of applyButtons) {
      button.disabled = !selected;
    }
  };
  options.selectionStore.subscribe(sync);

  return el("div", { className: "material-library" }, [el("div", { className: "sidebar__section" }, [status]), ...sections]);
}

/**
 * Right sidebar / inspector. Tabbed: Properties/Materials/Blocks/
 * Colors. Properties resolves the current selection against each store
 * in turn - the six original types, then elements - and renders the
 * matching panel: a type-specific one for each original type
 * (buildWallPanels ... buildWindowPanels), and one catalog-driven panel
 * for every element kind (buildElementPanels). The Materials tab applies
 * a library material to the selected object.
 *
 * Reads come straight from the stores; edits go through
 * commandExecutor.execute() ("wall.update" ... "element.update", and
 * "update_object" for the Materials tab) rather than touching the stores
 * or history controllers directly - this module never touches Three.js
 * directly either.
 */
export function createRightSidebar(options: RightSidebarOptions): HTMLElement {
  const properties = el("div", { className: "property-panel" });

  const hostLabel = (hostId: string | null): string => {
    if (hostId === null) {
      return "None (free-standing)";
    }
    return options.wallStore.get(hostId) ? hostId : `${hostId} (deleted)`;
  };

  const allObjects = (): ListedObject[] => [
    ...options.wallStore.getAll(),
    ...options.pillarStore.getAll(),
    ...options.beamStore.getAll(),
    ...options.slabStore.getAll(),
    ...options.doorStore.getAll(),
    ...options.windowStore.getAll(),
    ...options.elementStore.getAll(),
    ...options.assetStore.getAll()
  ];

  const panelsFor = (selectedId: string | null): HTMLElement[] => {
    if (!selectedId) {
      const objects = allObjects();
      return [buildEmptyState(objects.length, objects.filter(isRoom).length)];
    }
    const { commandExecutor, onDuplicateSelected, onDeleteSelected } = options;
    const wall = options.wallStore.get(selectedId);
    if (wall) {
      return buildWallPanels(wall, commandExecutor, onDuplicateSelected, onDeleteSelected);
    }
    const pillar = options.pillarStore.get(selectedId);
    if (pillar) {
      return buildPillarPanels(pillar, commandExecutor, onDuplicateSelected, onDeleteSelected);
    }
    const beam = options.beamStore.get(selectedId);
    if (beam) {
      return buildBeamPanels(beam, commandExecutor, onDuplicateSelected, onDeleteSelected);
    }
    const slab = options.slabStore.get(selectedId);
    if (slab) {
      return buildSlabPanels(slab, commandExecutor, onDuplicateSelected, onDeleteSelected);
    }
    const door = options.doorStore.get(selectedId);
    if (door) {
      return buildDoorPanels(door, hostLabel(door.hostId), commandExecutor, onDuplicateSelected, onDeleteSelected);
    }
    const windowData = options.windowStore.get(selectedId);
    if (windowData) {
      return buildWindowPanels(windowData, hostLabel(windowData.hostId), commandExecutor, onDuplicateSelected, onDeleteSelected);
    }
    const element = options.elementStore.get(selectedId);
    const definition = element ? getElementKind(element.kind) : undefined;
    if (element && definition) {
      return buildElementPanels(element, definition, {
        commandExecutor,
        selectionStore: options.selectionStore,
        allObjects,
        onDuplicateSelected,
        onDeleteSelected
      });
    }
    const asset = options.assetStore.get(selectedId);
    if (asset) {
      return buildAssetPanels(asset, commandExecutor, onDuplicateSelected, onDeleteSelected);
    }
    const objects = allObjects();
    return [buildEmptyState(objects.length, objects.filter(isRoom).length)];
  };

  // --- Relationships: host wall, a wall's openings, connections, alignment ---

  /** Shows a command's refusal under the controls that issued it (a success re-renders the panel anyway). */
  const feedback = (result: { success: boolean; message?: string }, note: HTMLElement): boolean => {
    note.textContent = result.success ? "" : result.message ?? "That change was refused.";
    return result.success;
  };

  const hostSection = (opening: DoorData | WindowData, type: "door" | "window"): HTMLElement => {
    const note = el("p", { className: "relation-note", attrs: { role: "status" } });
    const update = (changes: Record<string, unknown>): boolean =>
      feedback(options.commandExecutor.execute({ type: `${type}.update`, id: opening.id, changes }), note);
    const walls = options.wallStore.getAll();
    const rows: HTMLElement[] = [
      selectRow(
        "Host wall",
        opening.hostId ?? "",
        [{ value: "", label: "None (free-standing)" }, ...walls.map((wall) => ({ value: wall.id, label: wall.id }))],
        (value) => {
          update({ hostId: value === "" ? null : value });
        }
      )
    ];
    if (opening.hostId && opening.hostPlacement) {
      const placement = opening.hostPlacement;
      rows.push(
        numberInputRow("Along wall", placement.offset, (value) => update({ hostPlacement: { offset: value, sill: placement.sill } }), { step: 0.1 }),
        numberInputRow("Sill height", placement.sill, (value) => update({ hostPlacement: { offset: placement.offset, sill: value } }), {
          min: 0,
          step: 0.05
        })
      );
    }
    rows.push(note);
    return section("Host", rows);
  };

  const openingsSection = (wall: WallData): HTMLElement => {
    const openings = [...options.doorStore.getAll(), ...options.windowStore.getAll()].filter((opening) => opening.hostId === wall.id);
    const items = openings.map((opening) => {
      const along = opening.hostPlacement ? `, ${opening.hostPlacement.offset.toFixed(2)} m along` : "";
      const button = el("button", {
        className: "room-contents__item",
        text: `${opening.type === "door" ? "Door" : "Window"} — ${opening.id}${along}`,
        attrs: { type: "button" }
      });
      button.addEventListener("click", () => options.selectionStore.select(opening.id));
      return button;
    });
    return section("Openings", [
      readOnlyRow("In this wall", openings.length === 0 ? "None" : String(openings.length)),
      el("div", { className: "room-contents" }, items)
    ]);
  };

  const connectionsSection = (element: ElementData): HTMLElement => {
    const note = el("p", { className: "relation-note", attrs: { role: "status" } });
    const rows = element.connections.map((connection) => {
      const disconnect = el("button", {
        className: "toolbar-button connection-row__action",
        text: "Disconnect",
        attrs: { type: "button", "aria-label": `Disconnect ${element.id} ${connection.endpoint} from ${connection.objectId}` }
      });
      disconnect.addEventListener("click", () =>
        feedback(
          options.commandExecutor.execute({
            type: "element.disconnect",
            from: { id: element.id, endpoint: connection.endpoint },
            to: { id: connection.objectId, endpoint: connection.objectEndpoint }
          }),
          note
        )
      );
      return el("div", { className: "connection-row" }, [
        el("span", { className: "connection-row__label", text: `${connection.endpoint} ↔ ${connection.objectId} ${connection.objectEndpoint}` }),
        disconnect
      ]);
    });

    const candidates = options.elementStore.getAll().filter((other) => other.id !== element.id && kindsConnect(element.kind, other.kind));
    const connectRows: HTMLElement[] = [];
    if (candidates.length > 0) {
      const target = el(
        "select",
        { className: "property-row__input property-row__select", attrs: { "aria-label": "Connect to" } },
        candidates.map((candidate) => el("option", { text: `${candidate.label} — ${candidate.id}`, attrs: { value: candidate.id } }))
      );
      const connect = el("button", { className: "toolbar-button", text: "Connect", attrs: { type: "button" } });
      connect.addEventListener("click", () =>
        feedback(options.commandExecutor.execute({ type: "element.connect", from: { id: element.id }, to: { id: target.value } }), note)
      );
      connectRows.push(
        el("div", { className: "property-row" }, [el("span", { className: "property-row__label", text: "Connect to" }), target]),
        el("div", { className: "relation-actions" }, [connect])
      );
    }
    return section("Connections", [...(rows.length > 0 ? rows : [readOnlyRow("Connected", "None")]), ...connectRows, note]);
  };

  const alignSection = (id: string, isOpening: boolean): HTMLElement => {
    const others = allObjects().filter((object) => object.id !== id);
    // Doubles as the disabled reason up front (task: a disabled control
    // needs a visible reason, not just a mystery) and the post-click
    // success/failure feedback once there's something to align with -
    // feedback() below overwrites this same element either way.
    const note = el("p", {
      className: "relation-note",
      attrs: { role: "status" },
      text: others.length === 0 ? "Add another object to align or snap this one to." : undefined
    });
    const target = el(
      "select",
      { className: "property-row__input property-row__select", attrs: { "aria-label": "Align with" } },
      others.map((object) => el("option", { text: describeListed(object), attrs: { value: object.id } }))
    );
    const actions: [string, Record<string, unknown>][] = [
      ["Align X", { type: "object.align", axis: "x" }],
      ["Align Z", { type: "object.align", axis: "z" }],
      ["Align centers", { type: "object.align", axis: "both" }],
      ["Snap to endpoint", { type: "object.snap", mode: "endpoint" }],
      ...(isOpening ? [["Snap to wall", { type: "object.snap", mode: "wall" }] as [string, Record<string, unknown>]] : [])
    ];
    const buttons = actions.map(([label, command]) => {
      const button = el("button", { className: "toolbar-button", text: label, attrs: { type: "button" } });
      button.addEventListener("click", () => feedback(options.commandExecutor.execute({ ...command, id, targetId: target.value }), note));
      button.disabled = others.length === 0;
      return button;
    });
    return section("Align & snap", [
      el("div", { className: "property-row" }, [el("span", { className: "property-row__label", text: "Align with" }), target]),
      el("div", { className: "relation-actions" }, buttons),
      note
    ]);
  };

  const relationshipPanels = (selectedId: string | null): HTMLElement[] => {
    if (!selectedId) {
      return [];
    }
    const resolved = resolveConstructionObject(selectedId, {
      wallStore: options.wallStore,
      pillarStore: options.pillarStore,
      beamStore: options.beamStore,
      slabStore: options.slabStore,
      doorStore: options.doorStore,
      windowStore: options.windowStore,
      elementStore: options.elementStore
    });
    if (!resolved) {
      return [];
    }
    const panels: HTMLElement[] = [];
    const wall = options.wallStore.get(selectedId);
    const door = options.doorStore.get(selectedId);
    const windowData = options.windowStore.get(selectedId);
    const element = options.elementStore.get(selectedId);
    if (wall) {
      panels.push(openingsSection(wall));
    }
    if (door) {
      panels.push(hostSection(door, "door"));
    }
    if (windowData) {
      panels.push(hostSection(windowData, "window"));
    }
    if (element && isConnectable(element.kind)) {
      panels.push(connectionsSection(element));
    }
    panels.push(alignSection(selectedId, !!door || !!windowData));
    return panels;
  };

  const render = (): void => {
    const selectedId = options.selectionStore.get();
    properties.replaceChildren(...panelsFor(selectedId), ...relationshipPanels(selectedId));
  };

  options.wallStore.subscribe(render);
  options.pillarStore.subscribe(render);
  options.beamStore.subscribe(render);
  options.slabStore.subscribe(render);
  options.doorStore.subscribe(render);
  options.windowStore.subscribe(render);
  options.elementStore.subscribe(render);
  options.selectionStore.subscribe(render);

  const materials = createMaterialsPanel(options);

  const { strip, panel } = createTabStrip(
    [
      { id: "properties", label: "Properties", build: () => properties },
      { id: "materials", label: "Materials", build: () => materials },
      { id: "blocks", label: "Blocks", build: () => comingSoon("Reusable blocks"), disabled: true },
      { id: "colors", label: "Colors", build: () => comingSoon("Saved color palettes"), disabled: true }
    ],
    "sidebar-tabs",
    "sidebar-tabs__item"
  );

  return el("aside", { className: "sidebar sidebar--right" }, [strip, panel]);
}
