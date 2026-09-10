// Explicit .ts extension on this value import lets Node run this file
// directly (the verify suites and the backend do). Harmless for Vite.
import { getMaterial } from "../materials/materialLibrary.ts";
import type { MaterialCategory } from "../materials/materialLibrary";

/**
 * The construction object registry: every kind of parametric element the
 * engine can build, as data. One entry decides, for its kind:
 *
 * - its category and label (the ribbon, hierarchy, and AI read these)
 * - its dimensions - names, defaults, minimums - and which local box axis
 *   each runs along (geometry analysis, resize handles, the mesh)
 * - its default placement, material, color, and parameters
 * - its mesh recipe (`shape`, drawn by src/scene/elements/)
 *
 * Nothing about a kind is written anywhere else: ElementStore, the
 * element commands, history, persistence, the Properties panel, and the
 * scene layer are all generic over this table. Adding a kind is adding
 * an entry here (and, for a new shape, a mesh recipe).
 *
 * Coordinates follow the rest of the engine: meters, +Y up, `position` is
 * the center of the element's box, rotation is radians around Y. Every
 * element is a box in its own frame, sized by the three dimensions its
 * `axes` name - a pipe runs along local X with its diameter on Y and Z.
 */

export type ElementCategory = "structure" | "openings" | "rooms" | "finish" | "plumbing" | "electrical" | "interior" | "exterior";

export interface CategoryDefinition {
  id: ElementCategory;
  label: string;
}

/** The ribbon's categories, in order. The six original types belong to structure and openings. */
export const ELEMENT_CATEGORIES: readonly CategoryDefinition[] = Object.freeze([
  { id: "structure", label: "Structure" },
  { id: "openings", label: "Openings" },
  { id: "rooms", label: "Rooms" },
  { id: "finish", label: "Finish" },
  { id: "plumbing", label: "Plumbing" },
  { id: "electrical", label: "Electrical" },
  { id: "interior", label: "Interior" },
  { id: "exterior", label: "Exterior" }
]);

/** The mesh recipes src/scene/elements/buildElementMesh.ts knows how to draw. */
export const ELEMENT_SHAPES = [
  "box",
  "plate",
  "roof-gable",
  "stair",
  "pipe",
  "cylinder",
  "sink",
  "toilet",
  "shower",
  "tap",
  "wall-plate",
  "light",
  "bed",
  "table",
  "chair",
  "sofa",
  "cabinet",
  "counter",
  "gate",
  "tree",
  "plant",
  "room"
] as const;
export type ElementShape = (typeof ELEMENT_SHAPES)[number];

export interface DimensionSpec {
  key: string;
  label: string;
  default: number;
  /** The smallest accepted value, in meters (always > 0). */
  min: number;
  /** The Properties panel's step. */
  step: number;
}

export type ParamSpec =
  | { key: string; label: string; kind: "integer"; default: number; min: number; max: number }
  | { key: string; label: string; kind: "choice"; default: string; options: readonly string[] };

export interface ElementKindDefinition {
  kind: string;
  label: string;
  category: ElementCategory;
  description: string;
  shape: ElementShape;
  /** In the order objects store them. */
  dimensions: readonly DimensionSpec[];
  /** Which dimension spans each local axis of the element's box. */
  axes: { x: string; y: string; z: string };
  /** Where a new element's base sits when no height is given: 0 is the ground. */
  baseY: number;
  defaultMaterial: string;
  defaultColor: string;
  /** Material categories that suit this kind - the Properties panel offers these (plus "generic"). */
  materialCategories: readonly MaterialCategory[];
  params: readonly ParamSpec[];
  /** Linear elements (pipes, conduits, cables) run along local X: the panel also shows their start and end. */
  linear: boolean;
  /**
   * Linear kinds whose endpoints this kind's endpoints can be connected to
   * (see connections/connections.ts) - a water pipe to a water pipe, a
   * cable to a cable. Empty: no connections.
   */
  connectsWith: readonly string[];
  /** Words an instruction may use for this kind - the mock AI's vocabulary. */
  keywords: readonly string[];
}

function dimension(key: string, label: string, defaultValue: number, min: number, step: number): DimensionSpec {
  return { key, label, default: defaultValue, min, step };
}

const BOX_LWH = { x: "length", y: "height", z: "width" } as const;
const BOX_WHD = { x: "width", y: "height", z: "depth" } as const;
const PLATE_LTW = { x: "length", y: "thickness", z: "width" } as const;
const ROUND_DH = { x: "diameter", y: "height", z: "diameter" } as const;
const LINEAR = { x: "length", y: "diameter", z: "diameter" } as const;

type KindInput = Omit<ElementKindDefinition, "params" | "linear" | "connectsWith" | "keywords"> & {
  params?: readonly ParamSpec[];
  linear?: boolean;
  connectsWith?: readonly string[];
  keywords?: readonly string[];
};

function kind(input: KindInput): ElementKindDefinition {
  return {
    ...input,
    params: input.params ?? [],
    linear: input.linear ?? false,
    connectsWith: input.connectsWith ?? [],
    keywords: input.keywords ?? [input.label.toLowerCase()]
  };
}

const linearDimensions = (length: number, diameter: number) => [
  dimension("length", "Length", length, 0.05, 0.1),
  dimension("diameter", "Diameter", diameter, 0.004, 0.005)
];

export const ELEMENT_KINDS: readonly ElementKindDefinition[] = Object.freeze([
  // --- Structure ---
  kind({
    kind: "foundation",
    label: "Foundation",
    category: "structure",
    description: "A concrete raft/strip foundation, its top at ground level.",
    shape: "box",
    dimensions: [dimension("length", "Length", 10.4, 0.2, 0.1), dimension("depth", "Depth", 0.6, 0.1, 0.05), dimension("width", "Width", 8.4, 0.2, 0.1)],
    axes: { x: "length", y: "depth", z: "width" },
    baseY: -0.6,
    defaultMaterial: "reinforced-concrete",
    defaultColor: "#8f8f8f",
    materialCategories: ["structural", "masonry"]
  }),
  kind({
    kind: "roof",
    label: "Roof",
    category: "structure",
    description: "A pitched gable roof: the ridge runs along its length, the slopes fall across its width.",
    shape: "roof-gable",
    dimensions: [dimension("length", "Length", 10.6, 0.5, 0.1), dimension("height", "Rise", 1.6, 0.1, 0.1), dimension("width", "Span", 8.6, 0.5, 0.1)],
    axes: BOX_LWH,
    baseY: 2.9,
    defaultMaterial: "clay-roof-tile",
    defaultColor: "#a4502f",
    materialCategories: ["roofing", "metal", "wood"]
  }),
  kind({
    kind: "stair",
    label: "Stair",
    category: "structure",
    description: "A straight-flight staircase rising along its length.",
    shape: "stair",
    dimensions: [dimension("length", "Run", 3.4, 0.5, 0.1), dimension("height", "Rise", 2.9, 0.2, 0.05), dimension("width", "Width", 1, 0.5, 0.05)],
    axes: BOX_LWH,
    baseY: 0,
    defaultMaterial: "concrete",
    defaultColor: "#b5b5b0",
    materialCategories: ["structural", "wood", "stone", "metal"],
    params: [{ key: "steps", label: "Steps", kind: "integer", default: 16, min: 3, max: 40 }],
    keywords: ["stair", "stairs", "staircase"]
  }),

  // --- Rooms ---
  kind({
    kind: "room",
    label: "Room",
    category: "rooms",
    description: "A named room: the floor area and ceiling height of a space in the house.",
    shape: "room",
    dimensions: [dimension("length", "Length", 4, 0.5, 0.1), dimension("height", "Ceiling height", 2.7, 1, 0.05), dimension("width", "Width", 4, 0.5, 0.1)],
    axes: BOX_LWH,
    baseY: 0,
    defaultMaterial: "generic",
    defaultColor: "#6fa8dc",
    materialCategories: [],
    keywords: ["room"]
  }),

  // --- Finish ---
  kind({
    kind: "flooring",
    label: "Flooring",
    category: "finish",
    description: "A floor finish laid over a slab.",
    shape: "plate",
    dimensions: [dimension("length", "Length", 4, 0.1, 0.1), dimension("thickness", "Thickness", 0.02, 0.005, 0.005), dimension("width", "Width", 4, 0.1, 0.1)],
    axes: PLATE_LTW,
    baseY: 0,
    defaultMaterial: "ceramic-tile",
    defaultColor: "#d9d2c3",
    materialCategories: ["ceramic", "wood", "stone", "finish"],
    keywords: ["flooring", "floor finish", "tiles", "tile floor"]
  }),
  kind({
    kind: "ceiling",
    label: "Ceiling",
    category: "finish",
    description: "A ceiling finish under the roof or slab above.",
    shape: "plate",
    dimensions: [dimension("length", "Length", 4, 0.1, 0.1), dimension("thickness", "Thickness", 0.02, 0.005, 0.005), dimension("width", "Width", 4, 0.1, 0.1)],
    axes: PLATE_LTW,
    baseY: 2.68,
    defaultMaterial: "plaster",
    defaultColor: "#f2f0ea",
    materialCategories: ["finish", "wood"]
  }),

  // --- Plumbing ---
  kind({
    kind: "water-pipe",
    label: "Water Pipe",
    category: "plumbing",
    description: "A water supply pipe, running along its length.",
    shape: "pipe",
    dimensions: linearDimensions(3, 0.025),
    axes: LINEAR,
    baseY: 0.3,
    defaultMaterial: "cpvc",
    defaultColor: "#3b7dd8",
    materialCategories: ["plumbing", "metal"],
    params: [{ key: "system", label: "System", kind: "choice", default: "cold", options: ["cold", "hot"] }],
    linear: true,
    connectsWith: ["water-pipe"],
    keywords: ["water pipe", "supply pipe", "water line"]
  }),
  kind({
    kind: "drain-pipe",
    label: "Drain Pipe",
    category: "plumbing",
    description: "A waste/drain pipe, running along its length.",
    shape: "pipe",
    dimensions: linearDimensions(3, 0.1),
    axes: LINEAR,
    baseY: 0.05,
    defaultMaterial: "pvc",
    defaultColor: "#7c7c7c",
    materialCategories: ["plumbing"],
    linear: true,
    connectsWith: ["drain-pipe"],
    keywords: ["drain pipe", "drain", "waste pipe", "sewer pipe"]
  }),
  kind({
    kind: "water-tank",
    label: "Water Tank",
    category: "plumbing",
    description: "A cylindrical water storage tank.",
    shape: "cylinder",
    dimensions: [dimension("diameter", "Diameter", 1.2, 0.2, 0.05), dimension("height", "Height", 1.4, 0.2, 0.05)],
    axes: ROUND_DH,
    baseY: 0,
    defaultMaterial: "hdpe",
    defaultColor: "#2f2f2f",
    materialCategories: ["plumbing", "metal", "structural"],
    keywords: ["water tank", "tank", "cistern"]
  }),
  kind({
    kind: "pump",
    label: "Pump",
    category: "plumbing",
    description: "A water pump.",
    shape: "box",
    dimensions: [dimension("length", "Length", 0.5, 0.1, 0.05), dimension("height", "Height", 0.4, 0.1, 0.05), dimension("width", "Width", 0.35, 0.1, 0.05)],
    axes: BOX_LWH,
    baseY: 0,
    defaultMaterial: "steel",
    defaultColor: "#3a6ea5",
    materialCategories: ["metal"],
    keywords: ["pump", "water pump"]
  }),
  kind({
    kind: "sink",
    label: "Sink",
    category: "plumbing",
    description: "A wash basin or kitchen sink on its stand.",
    shape: "sink",
    dimensions: [dimension("width", "Width", 0.6, 0.2, 0.05), dimension("height", "Height", 0.9, 0.2, 0.05), dimension("depth", "Depth", 0.5, 0.2, 0.05)],
    axes: BOX_WHD,
    baseY: 0,
    defaultMaterial: "porcelain",
    defaultColor: "#f4f4f2",
    materialCategories: ["ceramic", "metal", "stone"],
    keywords: ["sink", "basin", "wash basin"]
  }),
  kind({
    kind: "toilet",
    label: "Toilet",
    category: "plumbing",
    description: "A toilet with cistern.",
    shape: "toilet",
    dimensions: [dimension("width", "Width", 0.4, 0.2, 0.05), dimension("height", "Height", 0.8, 0.3, 0.05), dimension("depth", "Depth", 0.7, 0.3, 0.05)],
    axes: BOX_WHD,
    baseY: 0,
    defaultMaterial: "porcelain",
    defaultColor: "#f4f4f2",
    materialCategories: ["ceramic"],
    keywords: ["toilet", "wc", "commode"]
  }),
  kind({
    kind: "shower",
    label: "Shower",
    category: "plumbing",
    description: "A shower tray with glass enclosure.",
    shape: "shower",
    dimensions: [dimension("width", "Width", 0.9, 0.6, 0.05), dimension("height", "Height", 2.1, 1.5, 0.05), dimension("depth", "Depth", 0.9, 0.6, 0.05)],
    axes: BOX_WHD,
    baseY: 0,
    defaultMaterial: "glass",
    defaultColor: "#9fd3e6",
    materialCategories: ["glass", "ceramic"],
    keywords: ["shower"]
  }),
  kind({
    kind: "tap",
    label: "Tap",
    category: "plumbing",
    description: "A tap or faucet.",
    shape: "tap",
    dimensions: [dimension("width", "Width", 0.05, 0.02, 0.01), dimension("height", "Height", 0.25, 0.05, 0.01), dimension("depth", "Reach", 0.2, 0.05, 0.01)],
    axes: BOX_WHD,
    baseY: 0.9,
    defaultMaterial: "stainless-steel",
    defaultColor: "#c0c4c8",
    materialCategories: ["metal"],
    keywords: ["tap", "faucet", "mixer"]
  }),

  // --- Electrical ---
  kind({
    kind: "conduit",
    label: "Conduit",
    category: "electrical",
    description: "An electrical conduit, running along its length.",
    shape: "pipe",
    dimensions: linearDimensions(3, 0.02),
    axes: LINEAR,
    baseY: 2.5,
    defaultMaterial: "pvc-conduit",
    defaultColor: "#d9d9d9",
    materialCategories: ["electrical", "metal"],
    linear: true,
    connectsWith: ["conduit"],
    keywords: ["conduit"]
  }),
  kind({
    kind: "cable",
    label: "Cable",
    category: "electrical",
    description: "An electrical cable or wire run.",
    shape: "pipe",
    dimensions: linearDimensions(3, 0.008),
    axes: LINEAR,
    baseY: 2.5,
    defaultMaterial: "copper-wire",
    defaultColor: "#c96f35",
    materialCategories: ["electrical"],
    linear: true,
    connectsWith: ["cable"],
    keywords: ["cable", "wire", "wiring"]
  }),
  kind({
    kind: "switch",
    label: "Switch",
    category: "electrical",
    description: "A wall light switch.",
    shape: "wall-plate",
    dimensions: [dimension("width", "Width", 0.086, 0.04, 0.005), dimension("height", "Height", 0.086, 0.04, 0.005), dimension("depth", "Depth", 0.03, 0.01, 0.005)],
    axes: BOX_WHD,
    baseY: 1.15,
    defaultMaterial: "abs-plastic",
    defaultColor: "#f2f2f2",
    materialCategories: ["electrical", "metal"],
    params: [{ key: "gangs", label: "Gangs", kind: "integer", default: 1, min: 1, max: 4 }],
    keywords: ["switch", "light switch"]
  }),
  kind({
    kind: "socket",
    label: "Socket",
    category: "electrical",
    description: "A wall power socket.",
    shape: "wall-plate",
    dimensions: [dimension("width", "Width", 0.146, 0.04, 0.005), dimension("height", "Height", 0.086, 0.04, 0.005), dimension("depth", "Depth", 0.04, 0.01, 0.005)],
    axes: BOX_WHD,
    baseY: 0.3,
    defaultMaterial: "abs-plastic",
    defaultColor: "#f2f2f2",
    materialCategories: ["electrical", "metal"],
    params: [{ key: "outlets", label: "Outlets", kind: "integer", default: 2, min: 1, max: 4 }],
    keywords: ["socket", "outlet", "power point"]
  }),
  kind({
    kind: "light",
    label: "Light",
    category: "electrical",
    description: "A ceiling light fitting.",
    shape: "light",
    dimensions: [dimension("diameter", "Diameter", 0.3, 0.05, 0.05), dimension("height", "Height", 0.12, 0.02, 0.01)],
    axes: ROUND_DH,
    baseY: 2.55,
    defaultMaterial: "abs-plastic",
    defaultColor: "#fff3c4",
    materialCategories: ["electrical", "glass", "metal"],
    keywords: ["light", "lamp", "light fitting"]
  }),
  kind({
    kind: "distribution-board",
    label: "Panel",
    category: "electrical",
    description: "The electrical distribution board (consumer unit).",
    shape: "box",
    dimensions: [dimension("width", "Width", 0.4, 0.1, 0.05), dimension("height", "Height", 0.5, 0.1, 0.05), dimension("depth", "Depth", 0.12, 0.05, 0.01)],
    axes: BOX_WHD,
    baseY: 1.4,
    defaultMaterial: "steel",
    defaultColor: "#7d8288",
    materialCategories: ["metal", "electrical"],
    keywords: ["distribution board", "electrical panel", "fuse box", "consumer unit", "panel"]
  }),

  // --- Interior ---
  kind({
    kind: "bed",
    label: "Bed",
    category: "interior",
    description: "A bed with headboard and mattress.",
    shape: "bed",
    dimensions: [dimension("length", "Length", 2.1, 0.8, 0.05), dimension("height", "Height", 0.9, 0.3, 0.05), dimension("width", "Width", 1.6, 0.6, 0.05)],
    axes: BOX_LWH,
    baseY: 0,
    defaultMaterial: "fabric",
    defaultColor: "#d8d2c4",
    materialCategories: ["fabric", "wood"],
    keywords: ["bed"]
  }),
  kind({
    kind: "table",
    label: "Table",
    category: "interior",
    description: "A table on four legs.",
    shape: "table",
    dimensions: [dimension("length", "Length", 1.6, 0.4, 0.05), dimension("height", "Height", 0.75, 0.3, 0.05), dimension("width", "Width", 0.9, 0.4, 0.05)],
    axes: BOX_LWH,
    baseY: 0,
    defaultMaterial: "oak",
    defaultColor: "#b08050",
    materialCategories: ["wood", "glass", "metal", "stone"],
    keywords: ["table", "dining table"]
  }),
  kind({
    kind: "chair",
    label: "Chair",
    category: "interior",
    description: "A chair with backrest.",
    shape: "chair",
    dimensions: [dimension("width", "Width", 0.45, 0.3, 0.05), dimension("height", "Height", 0.9, 0.5, 0.05), dimension("depth", "Depth", 0.5, 0.3, 0.05)],
    axes: BOX_WHD,
    baseY: 0,
    defaultMaterial: "oak",
    defaultColor: "#9c6b3f",
    materialCategories: ["wood", "metal", "fabric"],
    keywords: ["chair"]
  }),
  kind({
    kind: "sofa",
    label: "Sofa",
    category: "interior",
    description: "A sofa with back and arms.",
    shape: "sofa",
    dimensions: [dimension("length", "Length", 2.1, 0.8, 0.05), dimension("height", "Height", 0.85, 0.5, 0.05), dimension("width", "Depth", 0.9, 0.6, 0.05)],
    axes: BOX_LWH,
    baseY: 0,
    defaultMaterial: "fabric",
    defaultColor: "#7a8ca3",
    materialCategories: ["fabric"],
    keywords: ["sofa", "couch"]
  }),
  kind({
    kind: "wardrobe",
    label: "Wardrobe",
    category: "interior",
    description: "A free-standing wardrobe.",
    shape: "cabinet",
    dimensions: [dimension("width", "Width", 1.2, 0.4, 0.05), dimension("height", "Height", 2.1, 0.8, 0.05), dimension("depth", "Depth", 0.6, 0.3, 0.05)],
    axes: BOX_WHD,
    baseY: 0,
    defaultMaterial: "plywood",
    defaultColor: "#c8a878",
    materialCategories: ["wood", "finish"],
    keywords: ["wardrobe", "closet", "cupboard"]
  }),
  kind({
    kind: "kitchen-cabinet",
    label: "Cabinet",
    category: "interior",
    description: "A kitchen base cabinet.",
    shape: "cabinet",
    dimensions: [dimension("width", "Width", 0.8, 0.2, 0.05), dimension("height", "Height", 0.85, 0.3, 0.05), dimension("depth", "Depth", 0.58, 0.2, 0.02)],
    axes: BOX_WHD,
    baseY: 0,
    defaultMaterial: "laminate",
    defaultColor: "#e5ded0",
    materialCategories: ["wood", "finish"],
    keywords: ["kitchen cabinet", "cabinet"]
  }),
  kind({
    kind: "kitchen-counter",
    label: "Counter",
    category: "interior",
    description: "A kitchen worktop on its base units.",
    shape: "counter",
    dimensions: [dimension("length", "Length", 2.4, 0.4, 0.05), dimension("height", "Height", 0.9, 0.5, 0.05), dimension("width", "Depth", 0.6, 0.3, 0.02)],
    axes: BOX_LWH,
    baseY: 0,
    defaultMaterial: "granite",
    defaultColor: "#6e6a66",
    materialCategories: ["stone", "wood", "metal", "finish"],
    keywords: ["kitchen counter", "counter", "worktop", "countertop"]
  }),

  // --- Exterior ---
  kind({
    kind: "landscape",
    label: "Landscape",
    category: "exterior",
    description: "A landscape surface - lawn, gravel, or soil - at ground level.",
    shape: "plate",
    dimensions: [dimension("length", "Length", 20, 0.5, 0.5), dimension("thickness", "Thickness", 0.05, 0.01, 0.01), dimension("width", "Width", 16, 0.5, 0.5)],
    axes: PLATE_LTW,
    baseY: -0.05,
    defaultMaterial: "grass",
    defaultColor: "#4f8a3a",
    materialCategories: ["landscape", "stone"],
    keywords: ["landscape", "lawn", "garden", "grass"]
  }),
  kind({
    kind: "path",
    label: "Path",
    category: "exterior",
    description: "A paved path or driveway.",
    shape: "plate",
    dimensions: [dimension("length", "Length", 6, 0.3, 0.1), dimension("thickness", "Thickness", 0.05, 0.01, 0.01), dimension("width", "Width", 1.2, 0.3, 0.1)],
    axes: PLATE_LTW,
    baseY: 0,
    defaultMaterial: "paving-stone",
    defaultColor: "#8d8a84",
    materialCategories: ["landscape", "stone", "structural"],
    keywords: ["path", "pathway", "walkway", "driveway"]
  }),
  kind({
    kind: "boundary-wall",
    label: "Boundary Wall",
    category: "exterior",
    description: "A compound/boundary wall around the plot.",
    shape: "box",
    dimensions: [dimension("length", "Length", 10, 0.2, 0.1), dimension("height", "Height", 1.5, 0.3, 0.05), dimension("thickness", "Thickness", 0.2, 0.05, 0.05)],
    axes: { x: "length", y: "height", z: "thickness" },
    baseY: 0,
    defaultMaterial: "brick",
    defaultColor: "#a0522d",
    materialCategories: ["masonry", "structural", "finish"],
    keywords: ["boundary wall", "compound wall", "fence wall"]
  }),
  kind({
    kind: "gate",
    label: "Gate",
    category: "exterior",
    description: "A gate in the boundary wall.",
    shape: "gate",
    dimensions: [dimension("width", "Width", 1.2, 0.5, 0.05), dimension("height", "Height", 1.5, 0.5, 0.05), dimension("thickness", "Thickness", 0.05, 0.02, 0.01)],
    axes: { x: "width", y: "height", z: "thickness" },
    baseY: 0,
    defaultMaterial: "steel",
    defaultColor: "#3a3a3a",
    materialCategories: ["metal", "wood"],
    keywords: ["gate"]
  }),
  kind({
    kind: "tree",
    label: "Tree",
    category: "exterior",
    description: "A tree: a trunk and a rounded canopy.",
    shape: "tree",
    dimensions: [dimension("diameter", "Canopy", 3, 0.5, 0.1), dimension("height", "Height", 5, 1, 0.1)],
    axes: ROUND_DH,
    baseY: 0,
    defaultMaterial: "foliage",
    defaultColor: "#3f7d34",
    materialCategories: ["landscape"],
    keywords: ["tree"]
  }),
  kind({
    kind: "plant",
    label: "Plant",
    category: "exterior",
    description: "A shrub or potted plant.",
    shape: "plant",
    dimensions: [dimension("diameter", "Spread", 0.6, 0.1, 0.05), dimension("height", "Height", 0.8, 0.1, 0.05)],
    axes: ROUND_DH,
    baseY: 0,
    defaultMaterial: "foliage",
    defaultColor: "#4f9a3f",
    materialCategories: ["landscape"],
    keywords: ["plant", "shrub", "bush"]
  })
]);

const BY_KIND: ReadonlyMap<string, ElementKindDefinition> = new Map(ELEMENT_KINDS.map((definition) => [definition.kind, definition]));

/** The catalog entry for a kind, or undefined for an unknown one. */
export function getElementKind(kindId: string): ElementKindDefinition | undefined {
  return typeof kindId === "string" ? BY_KIND.get(kindId) : undefined;
}

export function elementKindsIn(category: ElementCategory): ElementKindDefinition[] {
  return ELEMENT_KINDS.filter((definition) => definition.category === category);
}

/** A kind's dimension keys, in stored order. */
export function dimensionKeysOf(definition: ElementKindDefinition): string[] {
  return definition.dimensions.map((spec) => spec.key);
}

/** A kind's vertical dimension - the one whose change keeps the base in place (see objects/grounding.ts). */
export function verticalKeyOf(definition: ElementKindDefinition): string {
  return definition.axes.y;
}

// --- Discovery: every construction object type the engine supports ---

/** One constructible type, as the AI layer (or any other client) discovers it. */
export interface ConstructionTypeInfo {
  /** The command that creates it. */
  command: string;
  /** The element kind, for element.add - absent for the six original types. */
  kind?: string;
  label: string;
  category: ElementCategory;
  dimensions: readonly string[];
}

/** The six original object types, each with its own store and "<type>.add" command. */
const ORIGINAL_TYPES: readonly ConstructionTypeInfo[] = Object.freeze([
  { command: "wall.add", label: "Wall", category: "structure", dimensions: ["length", "height", "thickness"] },
  { command: "pillar.add", label: "Pillar", category: "structure", dimensions: ["width", "depth", "height"] },
  { command: "beam.add", label: "Beam", category: "structure", dimensions: ["length", "width", "height"] },
  { command: "slab.add", label: "Slab", category: "structure", dimensions: ["length", "width", "thickness"] },
  { command: "door.add", label: "Door", category: "openings", dimensions: ["width", "height", "thickness"] },
  { command: "window.add", label: "Window", category: "openings", dimensions: ["width", "height", "thickness"] }
]);

/** Every constructible type - the six original ones, then every element kind - in ribbon category order. */
export function constructionTypeRegistry(): ConstructionTypeInfo[] {
  const all: ConstructionTypeInfo[] = [
    ...ORIGINAL_TYPES,
    ...ELEMENT_KINDS.map((definition) => ({
      command: "element.add",
      kind: definition.kind,
      label: definition.label,
      category: definition.category,
      dimensions: dimensionKeysOf(definition)
    }))
  ];
  const order = ELEMENT_CATEGORIES.map((category) => category.id);
  return all.sort((a, b) => order.indexOf(a.category) - order.indexOf(b.category));
}

/** Sanity checks the catalog satisfies - element verify.ts asserts this returns no problems. */
export function catalogProblems(): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const definition of ELEMENT_KINDS) {
    if (seen.has(definition.kind)) {
      problems.push(`duplicate kind "${definition.kind}"`);
    }
    seen.add(definition.kind);
    if (!/^[a-z][a-z-]*[a-z]$/.test(definition.kind)) {
      problems.push(`${definition.kind}: kinds are lower-case words joined by dashes`);
    }
    const keys = dimensionKeysOf(definition);
    for (const axis of ["x", "y", "z"] as const) {
      if (!keys.includes(definition.axes[axis])) {
        problems.push(`${definition.kind}: axis ${axis} names "${definition.axes[axis]}", which isn't one of its dimensions`);
      }
    }
    for (const spec of definition.dimensions) {
      if (!(spec.min > 0 && spec.default >= spec.min && spec.step > 0)) {
        problems.push(`${definition.kind}.${spec.key}: needs 0 < min <= default and a positive step`);
      }
    }
    if (!getMaterial(definition.defaultMaterial)) {
      problems.push(`${definition.kind}: default material "${definition.defaultMaterial}" isn't in the material library`);
    }
    if (!/^#[0-9a-f]{6}$/i.test(definition.defaultColor)) {
      problems.push(`${definition.kind}: default color must be #rrggbb`);
    }
    if (!(ELEMENT_SHAPES as readonly string[]).includes(definition.shape)) {
      problems.push(`${definition.kind}: unknown shape "${definition.shape}"`);
    }
    for (const other of definition.connectsWith) {
      const target = ELEMENT_KINDS.find((candidate) => candidate.kind === other);
      if (!definition.linear || !target || !target.linear) {
        problems.push(`${definition.kind}: only linear kinds connect, and "${other}" must be one`);
      } else if (!target.connectsWith.includes(definition.kind)) {
        problems.push(`${definition.kind}: connects with "${other}", which doesn't connect back`);
      }
    }
  }
  return problems;
}
