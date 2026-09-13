import { el } from "./dom";
import { createAssemblyPanel } from "./assemblyPanel";
import { createAssetLibrary } from "./assetLibrary";
import { createTabStrip, comingSoon } from "./tabStrip";
import { ELEMENT_KINDS } from "../engine/elements/catalog";
import { ASSET_DEFINITIONS } from "../engine/assets/catalog";
import { isRoom, objectsInRoom, roomArea } from "../engine/elements/rooms";
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
import type { AssetStore } from "../engine/assets/AssetStore";
import type { VisibilityStore } from "../scene/visibility/VisibilityStore";

interface HierarchyObject {
  id: string;
  kind?: string;
  /** Assets only: which catalog asset (assets/catalog.ts) - the asset equivalent of `kind`. */
  assetId?: string;
  label?: string;
  hostId?: string | null;
  connections?: readonly unknown[];
  position: { x: number; y: number; z: number };
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

/** A placed asset's name, falling back to its label if for some reason it's missing. */
function assetLabel(object: HierarchyObject): string {
  return object.label ?? "Asset";
}

/** Assets list after every catalog element (elementOrder's own length), in catalog order, then by id number - keeps the hierarchy's existing "catalog order, then id" convention without needing assets interleaved into the element catalog itself. */
function assetOrder(object: HierarchyObject): number {
  const index = ASSET_DEFINITIONS.findIndex((definition) => definition.id === object.assetId);
  return (ELEMENT_KINDS.length + 1) * 1_000_000 + (index < 0 ? ASSET_DEFINITIONS.length : index) * 1_000_000 + idNumber(object.id);
}

/** One clickable object row - selects it, and toggles its own visibility without affecting anything else. */
function objectRow(
  item: { id: string; label: string },
  selectedId: string | null,
  selectionStore: SelectionStore,
  visibilityStore: VisibilityStore
): HTMLElement {
  const hidden = visibilityStore.isHidden(item.id);
  const button = el("button", {
    className: `hierarchy-objects__item${item.id === selectedId ? " hierarchy-objects__item--selected" : ""}${hidden ? " hierarchy-objects__item--hidden" : ""}`,
    text: `${item.label} — ${item.id}`,
    attrs: { type: "button", "data-object-id": item.id }
  });
  button.addEventListener("click", () => selectionStore.select(item.id));

  const eye = el("button", {
    className: "hierarchy-objects__eye",
    text: hidden ? "\u{1F441}\u{FE0E}" : "\u{1F441}",
    attrs: { type: "button", title: hidden ? "Show" : "Hide", "aria-pressed": String(!hidden), "aria-label": hidden ? `Show ${item.label}` : `Hide ${item.label}` }
  });
  eye.addEventListener("click", (event) => {
    event.stopPropagation();
    visibilityStore.toggle(item.id);
  });

  return el("div", { className: "hierarchy-objects__row" }, [button, eye]);
}

/**
 * One room's row: its own select/visibility row plus Isolate and Focus,
 * and (when expanded) the rows of every object standing in it - "standing
 * in" computed by elements/rooms.ts's objectsInRoom(), never stored -
 * see that file's own docs for why. This is the smallest safe
 * implementation of "room-by-room" the current engine supports: there is
 * no floor/level concept anywhere in the data model (see DEPLOYMENT
 * notes/known limitations), so a room's contents are listed directly
 * under it, not under an invented floor.
 */
function roomSection(
  room: { id: string; label: string },
  memberItems: { id: string; label: string }[],
  selectedId: string | null,
  selectionStore: SelectionStore,
  visibilityStore: VisibilityStore,
  onFocusObjects: (objectIds: string[]) => void,
  expanded: Set<string>,
  /** Every object id in the project - what Isolate hides everything else among (see VisibilityStore.isolate()'s own docs). */
  allObjectIds: readonly string[]
): HTMLElement {
  const roomLabel = `${room.label} (${memberItems.length} object${memberItems.length === 1 ? "" : "s"})`;
  const isExpanded = expanded.has(room.id);
  const isolating = visibilityStore.isIsolating();

  const toggle = el("button", {
    className: "hierarchy-room__disclosure",
    text: isExpanded ? "▾" : "▸",
    attrs: { type: "button", "aria-label": isExpanded ? "Collapse" : "Expand", "aria-expanded": String(isExpanded) }
  });
  toggle.addEventListener("click", (event) => {
    event.stopPropagation();
    if (isExpanded) {
      expanded.delete(room.id);
    } else {
      expanded.add(room.id);
    }
  });

  const nameButton = el("button", {
    className: `hierarchy-room__name${room.id === selectedId ? " hierarchy-objects__item--selected" : ""}`,
    text: roomLabel,
    attrs: { type: "button" }
  });
  nameButton.addEventListener("click", () => selectionStore.select(room.id));

  const focusButton = el("button", {
    className: "hierarchy-room__action",
    text: "Focus",
    attrs: { type: "button", title: "Frame this room and its contents" }
  });
  focusButton.addEventListener("click", (event) => {
    event.stopPropagation();
    onFocusObjects([room.id, ...memberItems.map((item) => item.id)]);
  });

  const isolateButton = el("button", {
    className: `hierarchy-room__action${isolating ? " hierarchy-room__action--active" : ""}`,
    text: isolating ? "Back to House" : "Isolate",
    attrs: { type: "button", title: isolating ? "Show the whole building again" : "Make this room the visual hero - hide everything else in the building" }
  });
  isolateButton.addEventListener("click", (event) => {
    event.stopPropagation();
    if (visibilityStore.isIsolating()) {
      visibilityStore.exitIsolation();
    } else {
      // Hides every OTHER object in the project - the room becomes a
      // real destination on its own (task section 9), not just a camera
      // move. Framing it too (onFocusObjects) means "Isolate" reads as
      // one continuous "go to this room" action, not two unrelated ones.
      visibilityStore.isolate([room.id, ...memberItems.map((item) => item.id)], allObjectIds);
      onFocusObjects([room.id, ...memberItems.map((item) => item.id)]);
    }
  });

  const header = el("div", { className: "hierarchy-room__header" }, [toggle, nameButton, focusButton, isolateButton]);
  const children: HTMLElement[] = [header];
  if (isExpanded) {
    if (memberItems.length === 0) {
      children.push(el("p", { className: "sidebar__placeholder hierarchy-room__empty", text: "Nothing in this room yet." }));
    } else {
      children.push(
        el(
          "div",
          { className: "hierarchy-room__members" },
          memberItems.map((item) => objectRow(item, selectedId, selectionStore, visibilityStore))
        )
      );
    }
  }
  return el("div", { className: "hierarchy-room" }, children);
}

/**
 * The live project hierarchy: every "room" element (kind "room") gets its
 * own section listing the objects standing in it (computed by
 * objectsInRoom() - never invented/stored membership); everything not in
 * any room lists under "Other Objects", grouped the same way the whole
 * list used to be (six original types, then catalog elements). There is
 * no floor/level in this hierarchy - nothing in the engine's data model
 * supports one yet (see the milestone's own known-limitations note); a
 * multi-story project still lists every room flatly under "Building".
 */
function buildProjectHierarchy(
  selectionStore: SelectionStore,
  visibilityStore: VisibilityStore,
  sources: readonly ObjectSource[],
  elementStore: ElementStore,
  onFocusObjects: (objectIds: string[]) => void
): HTMLElement {
  const root = el("div", { className: "hierarchy-objects" });
  const expandedRooms = new Set<string>();
  let renderedKey: string | null = null;

  const render = (): void => {
    const selectedId = selectionStore.get();
    const hidden = visibilityStore.getHidden();
    const allObjects = sources.flatMap((source) => source.store.getAll());
    const rooms = elementStore.getAll().filter(isRoom);

    const items = sources.flatMap((source) =>
      source.store
        .getAll()
        .map((object) => ({ id: object.id, label: source.labelOf(object), order: source.orderOf(object) }))
        .sort((a, b) => a.order - b.order)
    );
    const itemById = new Map(items.map((item) => [item.id, item]));

    const roomMemberIds = new Set<string>();
    const roomEntries = rooms.map((room) => {
      const memberIds = objectsInRoom(room, allObjects);
      for (const id of memberIds) {
        roomMemberIds.add(id);
      }
      const memberItems: { id: string; label: string }[] = [];
      for (const id of memberIds) {
        const item = itemById.get(id);
        if (item) {
          memberItems.push({ id: item.id, label: item.label });
        }
      }
      return {
        room: { id: room.id, label: `${itemById.get(room.id)?.label ?? "Room"} — ${roomArea(room)} m²` },
        memberItems
      };
    });
    const roomIds = new Set(rooms.map((room) => room.id));
    const otherItems = items.filter((item) => !roomMemberIds.has(item.id) && !roomIds.has(item.id));
    const allObjectIds = allObjects.map((object) => object.id);

    // Only rebuild when something that changes the RENDERED OUTPUT changed
    // - not on every edit to some object's size or position. Rebuilding
    // mid-click (a pending field edit commits when the press starts)
    // would swallow it.
    const key = JSON.stringify([
      selectedId,
      Array.from(hidden).sort(),
      visibilityStore.isIsolating(),
      Array.from(expandedRooms).sort(),
      roomEntries.map(({ room, memberItems }) => [room.id, room.label, memberItems.map((item) => item.id)]),
      otherItems.map((item) => [item.id, item.label])
    ]);
    if (key === renderedKey) {
      return;
    }
    renderedKey = key;

    const sections: HTMLElement[] = [];
    if (roomEntries.length > 0) {
      // The one group title styled distinctly (see styles.css's
      // hierarchy-objects__group-title--rooms) - Phase 1A's "clearly
      // distinguish rooms" ask, a label-only change with no effect on
      // what's rendered underneath.
      sections.push(el("h4", { className: "hierarchy-objects__group-title hierarchy-objects__group-title--rooms", text: "Rooms" }));
      sections.push(
        ...roomEntries.map(({ room, memberItems }) =>
          roomSection(room, memberItems, selectedId, selectionStore, visibilityStore, onFocusObjects, expandedRooms, allObjectIds)
        )
      );
    }
    sections.push(el("h4", { className: "hierarchy-objects__group-title", text: roomEntries.length > 0 ? "Other Objects" : "Objects" }));
    if (otherItems.length === 0) {
      sections.push(el("p", { className: "sidebar__placeholder", text: roomEntries.length > 0 ? "Everything else is inside a room." : "No objects in the scene yet." }));
    } else {
      sections.push(...otherItems.map((item) => objectRow(item, selectedId, selectionStore, visibilityStore)));
    }

    root.replaceChildren(...sections);
  };

  for (const { store } of sources) {
    store.subscribe(render);
  }
  selectionStore.subscribe(render);
  visibilityStore.subscribe(render);

  return el("div", { className: "sidebar__section" }, [el("h3", { className: "sidebar__section-title", text: "Building" }), root]);
}

/**
 * Left workspace: a narrow icon rail (Project/Assemblies/Assets/Layers/
 * Views/Measurements/Documents) that switches a single panel below it.
 * "Project" shows the live building hierarchy (see buildProjectHierarchy) -
 * every "room" element with the objects standing in it, then everything
 * else; "Assemblies" shows the assembly panel (assemblyPanel.ts); "Assets"
 * shows the real visual design-asset browser (assetLibrary.ts) - clicking
 * a card arms pick-and-place for that asset, same as any construction
 * tool; the rest are still "Coming soon" placeholders, only somewhere for
 * layer/view/measurement/document management to eventually live.
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
  elementStore: ElementStore,
  assetStore: AssetStore,
  visibilityStore: VisibilityStore,
  onFocusObjects: (objectIds: string[]) => void,
  onAddAsset: (assetId: string) => void
): HTMLElement {
  const objectSources: ObjectSource[] = [
    originalSource("Wall", wallStore),
    originalSource("Pillar", pillarStore),
    originalSource("Beam", beamStore),
    originalSource("Slab", slabStore),
    originalSource("Door", doorStore),
    originalSource("Window", windowStore),
    { store: elementStore, labelOf: elementLabel, orderOf: elementOrder },
    { store: assetStore, labelOf: assetLabel, orderOf: assetOrder }
  ];

  const { strip, panel } = createTabStrip(
    [
      {
        id: "project",
        label: "Project",
        build: () => buildProjectHierarchy(selectionStore, visibilityStore, objectSources, elementStore, onFocusObjects)
      },
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
      { id: "assets", label: "Assets", build: () => createAssetLibrary({ onPlaceAsset: onAddAsset }) },
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
