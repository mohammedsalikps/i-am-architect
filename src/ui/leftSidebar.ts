import { el } from "./dom";
import { createAssemblyPanel } from "./assemblyPanel";
import { createTabStrip, comingSoon } from "./tabStrip";
import { ELEMENT_KINDS } from "../engine/elements/catalog";
import type { AssemblyStore } from "../engine/assemblies/AssemblyStore";
import type { CommandExecutor } from "../engine/commands/CommandExecutor";
import type { SelectionStore } from "../engine/selection/SelectionStore";
import type { WallStore } from "../engine/wall/WallStore";
import type { PillarStore } from "../engine/pillar/PillarStore";
import type { BeamStore } from "../engine/beam/BeamStore";
import type { SlabStore } from "../engine/slab/SlabStore";
import type { DoorStore } from "../engine/door/DoorStore";
import type { WindowStore } from "../engine/window/WindowStore";
import type { ElementStore } from "../engine/elements/ElementStore";

const HIERARCHY_SECTIONS = ["Building", "Floors", "Rooms", "Objects"];

interface HierarchyObject {
  id: string;
  kind?: string;
  label?: string;
  hostId?: string | null;
  connections?: readonly unknown[];
}

interface ObjectSource {
  store: { getAll(): readonly HierarchyObject[]; subscribe(listener: () => void): unknown };
  /** The name listed before the id. */
  labelOf(object: HierarchyObject): string;
  /** Orders the source's objects. */
  orderOf(object: HierarchyObject): number;
}

/** "wall-12" -> 12, so "wall-2" lists before "wall-10". */
function idNumber(id: string): number {
  const match = /(\d+)$/.exec(id);
  return match ? Number(match[1]) : 0;
}

/** Elements list in catalog order (structure first ... exterior last), then by id number. */
function elementOrder(object: HierarchyObject): number {
  const index = ELEMENT_KINDS.findIndex((definition) => definition.kind === object.kind);
  return (index < 0 ? ELEMENT_KINDS.length : index) * 1_000_000 + idNumber(object.id);
}

function originalSource(label: string, store: ObjectSource["store"]): ObjectSource {
  return {
    store,
    // A door or window in a wall says which: "Door in wall-3".
    labelOf: (object) => (typeof object.hostId === "string" ? `${label} in ${object.hostId}` : label),
    orderOf: (object) => idNumber(object.id)
  };
}

/** An element's name, with how many endpoint connections it has, if any. */
function elementLabel(object: HierarchyObject): string {
  const name = object.label ?? object.kind ?? "Element";
  const count = object.connections?.length ?? 0;
  return count === 0 ? name : `${name} (${count} connection${count === 1 ? "" : "s"})`;
}

/**
 * The hierarchy scaffold plus a live list of every construction object:
 * the six original types, then every element (by catalog order, named by
 * its own label - "Living Room", "Water Pipe") in id order. Clicking one
 * selects it through the shared selectionStore - the same selection a
 * click in the viewport makes - which is the dependable way to reach an
 * object hidden behind or inside another. Read-only: it never writes to
 * any store.
 */
function buildProjectHierarchy(selectionStore: SelectionStore, sources: readonly ObjectSource[]): HTMLElement {
  const objectList = el("div", { className: "hierarchy-objects" });
  let renderedKey: string | null = null;

  const render = (): void => {
    const selectedId = selectionStore.get();
    const items = sources.flatMap((source) =>
      source.store
        .getAll()
        .map((object) => ({ id: object.id, label: source.labelOf(object), order: source.orderOf(object) }))
        .sort((a, b) => a.order - b.order)
    );

    // Only rebuild when the list, a name, or the selection changed - not
    // on every edit to some object's size or position. Rebuilding
    // mid-click (a pending field edit commits when the press starts)
    // would swallow it.
    const key = JSON.stringify([selectedId, items.map((item) => [item.id, item.label])]);
    if (key === renderedKey) {
      return;
    }
    renderedKey = key;

    if (items.length === 0) {
      objectList.replaceChildren(el("p", { className: "sidebar__placeholder", text: "No objects in the scene yet." }));
      return;
    }

    objectList.replaceChildren(
      ...items.map((item) => {
        const button = el("button", {
          className: `hierarchy-objects__item${item.id === selectedId ? " hierarchy-objects__item--selected" : ""}`,
          text: `${item.label} — ${item.id}`,
          attrs: { type: "button", "data-object-id": item.id }
        });
        button.addEventListener("click", () => selectionStore.select(item.id));
        return button;
      })
    );
  };

  for (const { store } of sources) {
    store.subscribe(render);
  }
  selectionStore.subscribe(render);

  return el("div", { className: "sidebar__section" }, [
    el("h3", { className: "sidebar__section-title", text: "Hierarchy" }),
    el(
      "ul",
      { className: "hierarchy-list" },
      HIERARCHY_SECTIONS.map((label) => el("li", { className: "hierarchy-list__item", text: label }))
    ),
    objectList
  ]);
}

/**
 * Left workspace: a narrow icon rail (Project/Assets/Assemblies/Layers/
 * Views/Measurements/Documents) that switches a single panel below it.
 * "Project" shows the project hierarchy scaffold with a live, clickable
 * list of every object (see buildProjectHierarchy); "Assemblies" shows
 * the assembly panel (assemblyPanel.ts); the rest are "Coming soon"
 * placeholders - this milestone doesn't add real asset/layer/view/
 * measurement/document management, only somewhere for it to eventually
 * live.
 *
 * The object stores are threaded straight through to the assembly
 * panel, which resolves a member id against all of them (see
 * resolveConstructionObject.ts) rather than assuming every member is a
 * wall.
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
  windowStore: WindowStore,
  elementStore: ElementStore
): HTMLElement {
  const objectSources: ObjectSource[] = [
    originalSource("Wall", wallStore),
    originalSource("Pillar", pillarStore),
    originalSource("Beam", beamStore),
    originalSource("Slab", slabStore),
    originalSource("Door", doorStore),
    originalSource("Window", windowStore),
    { store: elementStore, labelOf: elementLabel, orderOf: elementOrder }
  ];

  const { strip, panel } = createTabStrip(
    [
      { id: "project", label: "Project", build: () => buildProjectHierarchy(selectionStore, objectSources) },
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
            windowStore,
            elementStore
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
