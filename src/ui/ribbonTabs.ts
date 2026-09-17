// Explicit .ts extensions on these value imports let Node run this file
// directly - elements/verify.ts checks the ribbon covers every catalog
// kind. Harmless for Vite. Data only: no DOM here (constructionRibbon.ts
// renders it).
import { ELEMENT_CATEGORIES, getElementKind } from "../engine/elements/catalog.ts";
import { ROOM_PRESETS } from "../engine/elements/roomPresets.ts";
import { constructionIconSvg } from "./constructionIcons.ts";
import type { ElementCategory } from "../engine/elements/catalog";
import type { RoomPreset } from "../engine/elements/roomPresets";

/** One ribbon button. */
export interface RibbonTool {
  id: string;
  label: string;
  /**
   * The button's icon square content, injected via `.innerHTML` (see
   * constructionRibbon.ts's renderTool()) - real SVG markup for a tool
   * constructionIconSvg() has an icon for, or a plain 1-2 letter
   * `iconFor()` fallback otherwise (renders identically to plain text
   * through innerHTML, so nothing regresses for a not-yet-drawn tool).
   */
  icon: string;
  /** Tooltip and accessible name: what the button does. */
  title: string;
  group: string;
  /** Runs the tool - `value` is the tool's color picker value, when it has one. */
  run(value?: string): void;
  /** When present, the button is enabled only while this returns true. */
  isEnabled?(): boolean;
  /** The tooltip while disabled - why it can't be used right now. */
  disabledTitle?: string;
  /** When present, the button is shown "armed"/active - e.g. its pick-and-place tool is the one currently loaded in the viewport. */
  isActive?(): boolean;
  /** A color picker shown next to the button. */
  colorInput?: { label: string; initial: string };
}

export interface RibbonTab {
  id: string;
  label: string;
  tools: RibbonTool[];
}

/** What the ribbon's buttons do - main.ts supplies these, every one a command through the shared CommandExecutor. */
export interface RibbonActions {
  addWall(): void;
  addPillar(): void;
  addBeam(): void;
  addSlab(): void;
  addDoor(): void;
  addWindow(): void;
  addElement(kind: string): void;
  addRoom(preset: RoomPreset): void;
  /** Repaints the selected object (a wall, an element, ...): the same object, material "paint" and the chosen color. */
  paintSelected(color: string): void;
  canPaintSelection(): boolean;
  /** Whether tool `id` is the one currently armed for pick-and-place in the viewport. */
  isPlacementActive(id: string): boolean;
}

type OriginalType = "wall" | "pillar" | "beam" | "slab" | "door" | "window";

type RibbonItem = { original: OriginalType } | { kind: string } | { roomPresets: true } | { paint: true };

interface RibbonGroup {
  label: string;
  items: readonly RibbonItem[];
}

const k = (kind: string): RibbonItem => ({ kind });
const o = (original: OriginalType): RibbonItem => ({ original });

/**
 * Which tools each tab shows, grouped. Home collects the everyday
 * building tools; every other tab is one catalog category. Each element
 * kind appears in its own category's tab (elements/verify.ts checks that
 * none is missing or misplaced).
 */
export const RIBBON_LAYOUT: Readonly<Record<"home" | ElementCategory, readonly RibbonGroup[]>> = {
  home: [
    { label: "Structure", items: [o("wall"), o("pillar"), o("beam"), o("slab")] },
    { label: "Openings", items: [o("door"), o("window")] },
    { label: "Building", items: [k("foundation"), k("roof"), k("stair"), k("room")] }
  ],
  structure: [
    { label: "Foundation", items: [k("foundation")] },
    { label: "Frame", items: [o("wall"), o("pillar"), o("beam"), o("slab")] },
    { label: "Roof & stair", items: [k("roof"), k("stair")] }
  ],
  openings: [{ label: "Openings", items: [o("door"), o("window")] }],
  rooms: [
    { label: "Room presets", items: [{ roomPresets: true }] },
    { label: "Custom", items: [k("room")] }
  ],
  finish: [
    { label: "Surfaces", items: [k("flooring"), k("ceiling")] },
    { label: "Paint", items: [{ paint: true }] }
  ],
  plumbing: [
    { label: "Pipes", items: [k("water-pipe"), k("drain-pipe")] },
    { label: "Equipment", items: [k("water-tank"), k("pump")] },
    { label: "Fixtures", items: [k("sink"), k("toilet"), k("shower"), k("tap")] }
  ],
  electrical: [
    { label: "Wiring", items: [k("conduit"), k("cable")] },
    { label: "Devices", items: [k("switch"), k("socket"), k("light")] },
    { label: "Supply", items: [k("distribution-board")] }
  ],
  interior: [
    { label: "Furniture", items: [k("bed"), k("table"), k("chair"), k("sofa"), k("wardrobe")] },
    { label: "Kitchen", items: [k("kitchen-cabinet"), k("kitchen-counter")] }
  ],
  exterior: [
    { label: "Site", items: [k("landscape"), k("path")] },
    { label: "Boundary", items: [k("boundary-wall"), k("gate")] },
    { label: "Planting", items: [k("tree"), k("plant")] }
  ]
};

const ORIGINAL_LABELS: Readonly<Record<OriginalType, string>> = {
  wall: "Wall",
  pillar: "Pillar",
  beam: "Beam",
  slab: "Slab",
  door: "Door",
  window: "Window"
};

/** "Water Pipe" -> "WP", "Roof" -> "Ro". */
export function iconFor(label: string): string {
  const words = label.split(/\s+/).filter((word) => word.length > 0);
  return words.length > 1 ? `${words[0][0]}${words[1][0]}`.toUpperCase() : label.slice(0, 2);
}

function withArticle(noun: string): string {
  return `${/^[aeiou]/i.test(noun) ? "an" : "a"} ${noun}`;
}

function originalTool(type: OriginalType, group: string, actions: RibbonActions): RibbonTool {
  const label = ORIGINAL_LABELS[type];
  const run: Record<OriginalType, () => void> = {
    wall: () => actions.addWall(),
    pillar: () => actions.addPillar(),
    beam: () => actions.addBeam(),
    slab: () => actions.addSlab(),
    door: () => actions.addDoor(),
    window: () => actions.addWindow()
  };
  const hosted = type === "door" || type === "window";
  return {
    id: type,
    label,
    icon: constructionIconSvg(type) ?? iconFor(label),
    title: hosted
      ? `Add ${withArticle(type)} - placed in the selected wall when a wall is selected, otherwise click to place it in the viewport`
      : `Click, then click in the viewport to place ${withArticle(type)}`,
    group,
    run: run[type],
    isActive: () => actions.isPlacementActive(type)
  };
}

function toolsFor(item: RibbonItem, group: string, actions: RibbonActions): RibbonTool[] {
  if ("original" in item) {
    return [originalTool(item.original, group, actions)];
  }
  if ("roomPresets" in item) {
    return ROOM_PRESETS.map((preset) => ({
      id: `room-preset:${preset.name}`,
      label: preset.name,
      // Every preset places an ordinary "room" element (roomPresets.ts) -
      // the same room icon for all of them is accurate, not a
      // simplification, and replaces the two-letter fallback ("LR", "Ma", ...)
      // this was the last ribbon tool still showing (Phase 2).
      icon: constructionIconSvg("room") ?? iconFor(preset.name),
      title: `Click, then click in the viewport to place ${withArticle(preset.name)} (${preset.length} × ${preset.width} m)`,
      group,
      run: () => actions.addRoom(preset),
      // Every room preset arms placement under the shared "room" kind id
      // (element.add's kind) - so all presets show active together while
      // any one is armed, a small imprecision this milestone accepts
      // rather than threading a distinct id per preset through addElement().
      isActive: () => actions.isPlacementActive("room")
    }));
  }
  if ("paint" in item) {
    return [
      {
        id: "paint",
        label: "Paint",
        icon: constructionIconSvg("paint") ?? "Pa",
        title: "Paint the selected object with the chosen color - it stays the same object",
        disabledTitle: "Select a wall or another object to paint it",
        group,
        run: (value) => actions.paintSelected(value ?? "#efe9dd"),
        isEnabled: () => actions.canPaintSelection(),
        colorInput: { label: "Paint color", initial: "#efe9dd" }
      }
    ];
  }
  const definition = getElementKind(item.kind);
  if (!definition) {
    return [];
  }
  return [
    {
      id: definition.kind,
      label: definition.label,
      icon: constructionIconSvg(definition.kind) ?? iconFor(definition.label),
      title: `Click, then click in the viewport to place ${withArticle(definition.label.toLowerCase())} - ${definition.description}`,
      group,
      run: () => actions.addElement(definition.kind),
      isActive: () => actions.isPlacementActive(definition.kind)
    }
  ];
}

/**
 * "Build", then one tab per catalog category, each with its grouped
 * tools wired to `actions`. The id stays "home" - it still selects
 * RIBBON_LAYOUT.home below and is never shown - only the visible label
 * changes (Phase 1A: main nav reads as a workflow, not a literal "Home"
 * screen), so nothing about tab selection, the ribbon's own data source,
 * or main-nav wiring (mainNav.ts) changes.
 */
export function buildRibbonTabs(actions: RibbonActions): RibbonTab[] {
  const tabs: { id: "home" | ElementCategory; label: string }[] = [{ id: "home", label: "Build" }, ...ELEMENT_CATEGORIES];
  return tabs.map(({ id, label }) => ({
    id,
    label,
    tools: RIBBON_LAYOUT[id].flatMap((group) => group.items.flatMap((item) => toolsFor(item, group.label, actions)))
  }));
}
