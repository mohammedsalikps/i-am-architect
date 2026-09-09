import { el } from "./dom";
import { createTabStrip, comingSoon } from "./tabStrip";
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
import type { SelectionStore } from "../engine/selection/SelectionStore";
import type { CommandExecutor } from "../engine/commands/CommandExecutor";
import type {
  UpdateWallCommand,
  UpdatePillarCommand,
  UpdateBeamCommand,
  UpdateSlabCommand,
  UpdateDoorCommand,
  UpdateWindowCommand
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

/** Shared by both buildWallPanels and buildPillarPanels - identical Duplicate/Delete action row for whichever type is selected. */
function buildActionsRow(onDuplicateSelected: () => void, onDeleteSelected: () => void): HTMLElement {
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

  return el("div", { className: "property-panel__actions" }, [duplicateButton, deleteButton]);
}

function buildWallPanels(
  wall: WallData,
  commandExecutor: CommandExecutor,
  onDuplicateSelected: () => void,
  onDeleteSelected: () => void
): HTMLElement[] {
  const actions = buildActionsRow(onDuplicateSelected, onDeleteSelected);

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

  const rotationDegrees = Math.round(radiansToDegrees(pillar.rotation) * 100) / 100;

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

  const material = section("Material", [readOnlyRow("Material", pillar.material)]);

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

  const rotationDegrees = Math.round(radiansToDegrees(beam.rotation) * 100) / 100;

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

  const material = section("Material", [readOnlyRow("Material", beam.material)]);

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

  const rotationDegrees = Math.round(radiansToDegrees(slab.rotation) * 100) / 100;

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

  const material = section("Material", [readOnlyRow("Material", slab.material)]);

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
 * see rightSidebar's module doc.)
 */
function buildDoorPanels(
  door: DoorData,
  commandExecutor: CommandExecutor,
  onDuplicateSelected: () => void,
  onDeleteSelected: () => void
): HTMLElement[] {
  const actions = buildActionsRow(onDuplicateSelected, onDeleteSelected);

  const properties = section("Properties", [readOnlyRow("Name", "Door"), readOnlyRow("Type", door.type)]);

  const rotationDegrees = Math.round(radiansToDegrees(door.rotation) * 100) / 100;

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
    numberInputRow("Rotation Y", rotationDegrees, (value) => updateDoor({ rotation: degreesToRadians(value) }), {
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

  const material = section("Material", [readOnlyRow("Material", door.material)]);

  const color = section("Color", [colorInputRow("Color", door.color, (value) => updateDoor({ color: value }))]);

  return [actions, properties, transform, dimensions, material, color];
}

/**
 * Window's own panel builder - see buildDoorPanels' doc for why this
 * stays separate from it despite the identical dimensions shape.
 */
function buildWindowPanels(
  windowData: WindowData,
  commandExecutor: CommandExecutor,
  onDuplicateSelected: () => void,
  onDeleteSelected: () => void
): HTMLElement[] {
  const actions = buildActionsRow(onDuplicateSelected, onDeleteSelected);

  const properties = section("Properties", [readOnlyRow("Name", "Window"), readOnlyRow("Type", windowData.type)]);

  const rotationDegrees = Math.round(radiansToDegrees(windowData.rotation) * 100) / 100;

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
    numberInputRow(
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

  const material = section("Material", [readOnlyRow("Material", windowData.material)]);

  const color = section("Color", [
    colorInputRow("Color", windowData.color, (value) => updateWindow({ color: value }))
  ]);

  return [actions, properties, transform, dimensions, material, color];
}

function buildEmptyState(): HTMLElement {
  return el("div", { className: "sidebar__section" }, [
    el("p", {
      className: "sidebar__placeholder",
      text: "Select a wall, pillar, beam, slab, door, or window to view and edit its properties."
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
  selectionStore: SelectionStore;
  commandExecutor: CommandExecutor;
  onDuplicateSelected: () => void;
  onDeleteSelected: () => void;
};

/**
 * Right sidebar / inspector. Tabbed: Properties/Materials/Blocks/
 * Colors. Properties resolves the current selection against wallStore,
 * then pillarStore, then beamStore, then slabStore, then doorStore,
 * then windowStore - the same "try each store in turn" shape
 * assemblyPanel.ts's resolveMemberLabel already uses (both could use
 * the shared resolveConstructionObject() helper instead; they don't
 * need to, since neither is broken - see that file's docs) - and
 * renders the matching type-specific panel (buildWallPanels /
 * buildPillarPanels / buildBeamPanels / buildSlabPanels /
 * buildDoorPanels / buildWindowPanels), or the empty state if the
 * selected id belongs to none of them (or nothing is selected). Each
 * object type's rendering stays a fully separate, type-safe function -
 * this module never merges their shapes into one generic form.
 *
 * Reads come straight from the stores; edits go through
 * commandExecutor.execute() ("wall.update"/"pillar.update"/
 * "beam.update"/"slab.update"/"door.update"/"window.update" commands)
 * rather than touching the stores or history controllers directly -
 * this module never touches Three.js directly either.
 */
export function createRightSidebar(options: RightSidebarOptions): HTMLElement {
  const properties = el("div", { className: "property-panel" });

  const render = (): void => {
    const selectedId = options.selectionStore.get();
    const wall = selectedId ? options.wallStore.get(selectedId) : undefined;
    const pillar = !wall && selectedId ? options.pillarStore.get(selectedId) : undefined;
    const beam = !wall && !pillar && selectedId ? options.beamStore.get(selectedId) : undefined;
    const slab = !wall && !pillar && !beam && selectedId ? options.slabStore.get(selectedId) : undefined;
    const door = !wall && !pillar && !beam && !slab && selectedId ? options.doorStore.get(selectedId) : undefined;
    const windowData =
      !wall && !pillar && !beam && !slab && !door && selectedId ? options.windowStore.get(selectedId) : undefined;

    let content: HTMLElement[];
    if (wall) {
      content = buildWallPanels(wall, options.commandExecutor, options.onDuplicateSelected, options.onDeleteSelected);
    } else if (pillar) {
      content = buildPillarPanels(
        pillar,
        options.commandExecutor,
        options.onDuplicateSelected,
        options.onDeleteSelected
      );
    } else if (beam) {
      content = buildBeamPanels(beam, options.commandExecutor, options.onDuplicateSelected, options.onDeleteSelected);
    } else if (slab) {
      content = buildSlabPanels(slab, options.commandExecutor, options.onDuplicateSelected, options.onDeleteSelected);
    } else if (door) {
      content = buildDoorPanels(door, options.commandExecutor, options.onDuplicateSelected, options.onDeleteSelected);
    } else if (windowData) {
      content = buildWindowPanels(
        windowData,
        options.commandExecutor,
        options.onDuplicateSelected,
        options.onDeleteSelected
      );
    } else {
      content = [buildEmptyState()];
    }

    properties.replaceChildren(...content);
  };

  options.wallStore.subscribe(render);
  options.pillarStore.subscribe(render);
  options.beamStore.subscribe(render);
  options.slabStore.subscribe(render);
  options.doorStore.subscribe(render);
  options.windowStore.subscribe(render);
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
