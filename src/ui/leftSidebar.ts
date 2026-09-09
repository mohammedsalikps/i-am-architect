import { el } from "./dom";
import { createAssemblyPanel } from "./assemblyPanel";
import { createTabStrip, comingSoon } from "./tabStrip";
import type { AssemblyStore } from "../engine/assemblies/AssemblyStore";
import type { CommandExecutor } from "../engine/commands/CommandExecutor";
import type { SelectionStore } from "../engine/selection/SelectionStore";
import type { WallStore } from "../engine/wall/WallStore";
import type { PillarStore } from "../engine/pillar/PillarStore";
import type { BeamStore } from "../engine/beam/BeamStore";
import type { SlabStore } from "../engine/slab/SlabStore";
import type { DoorStore } from "../engine/door/DoorStore";
import type { WindowStore } from "../engine/window/WindowStore";

const HIERARCHY_SECTIONS = ["Building", "Floors", "Rooms", "Objects"];

function buildProjectHierarchy(): HTMLElement {
  return el("div", { className: "sidebar__section" }, [
    el("h3", { className: "sidebar__section-title", text: "Hierarchy" }),
    el(
      "ul",
      { className: "hierarchy-list" },
      HIERARCHY_SECTIONS.map((label) => el("li", { className: "hierarchy-list__item", text: label }))
    ),
    el("p", { className: "sidebar__placeholder", text: "No objects in the scene yet." })
  ]);
}

/**
 * Left workspace: a narrow icon rail (Project/Assets/Assemblies/Layers/
 * Views/Measurements/Documents) that switches a single panel below it.
 * "Project" shows the project hierarchy scaffold; "Assemblies" shows
 * the existing, unmodified assembly panel (assemblyPanel.ts); the rest
 * are "Coming soon" placeholders - this milestone doesn't add real
 * asset/layer/view/measurement/document management, only somewhere for
 * it to eventually live.
 *
 * `selectionStore`, `wallStore`, `pillarStore`, `beamStore`,
 * `slabStore`, `doorStore`, and `windowStore` are threaded straight
 * through to the assembly panel, which resolves a member id against
 * all six stores (see resolveConstructionObject.ts) rather than
 * assuming every member is a wall.
 */
export function createLeftSidebar(
  assemblyStore: AssemblyStore,
  commandExecutor: CommandExecutor,
  selectionStore: SelectionStore,
  wallStore: WallStore,
  pillarStore: PillarStore,
  beamStore: BeamStore,
  slabStore: SlabStore,
  doorStore: DoorStore,
  windowStore: WindowStore
): HTMLElement {
  const { strip, panel } = createTabStrip(
    [
      { id: "project", label: "Project", build: buildProjectHierarchy },
      {
        id: "assemblies",
        label: "Assemblies",
        build: () =>
          createAssemblyPanel(
            assemblyStore,
            commandExecutor,
            selectionStore,
            wallStore,
            pillarStore,
            beamStore,
            slabStore,
            doorStore,
            windowStore
          )
      },
      { id: "assets", label: "Assets", build: () => comingSoon("Asset management"), disabled: true },
      { id: "layers", label: "Layers", build: () => comingSoon("Layer management"), disabled: true },
      { id: "views", label: "Views", build: () => comingSoon("Saved views"), disabled: true },
      { id: "measurements", label: "Measurements", build: () => comingSoon("Measurements"), disabled: true },
      { id: "documents", label: "Documents", build: () => comingSoon("Document management"), disabled: true }
    ],
    "sidebar-rail",
    "sidebar-rail__item"
  );

  return el("aside", { className: "sidebar sidebar--left" }, [strip, panel]);
}
