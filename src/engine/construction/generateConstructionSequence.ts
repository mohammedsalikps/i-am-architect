import type { AIContextObject } from "../ai/types.ts";
import { compareIds } from "../ai/types.ts";
import { getElementKind } from "../elements/catalog.ts";
import { getAssetDefinition } from "../assets/catalog.ts";
import type { ConstructionCategory, ConstructionSequence, ConstructionStep, RequiredComponent } from "./types.ts";

/**
 * Deterministic Construction Method / Build Sequence generator - V1.
 *
 * Inspects the ACTUAL objects currently in the project (the same
 * AIContextObject[] the AI layer already reads - see ../ai/types.ts) and
 * classifies each into one of nine construction phases. Never calls
 * Gemini or any AIProvider (task section 10) and never invents an object,
 * an id, or an engineering quantity: every id in every step is copied
 * from a real object, and every RequiredComponent's quantity is either a
 * real count/sum derived from real object fields, or the honest
 * placeholder "Not calculated"/"As designed" when the project's data
 * model doesn't track enough to compute a real number (concrete volumes,
 * reinforcement weights - nothing here is an engineering or costing
 * calculation, see types.ts's own docs).
 */

const CATEGORY_DEFINITIONS: readonly { category: ConstructionCategory; title: string; description: string }[] = [
  { category: "foundation", title: "Foundation", description: "Base foundation and footings that transfer the building's loads to the ground." },
  { category: "structure", title: "Structure", description: "Pillars, beams, slabs and stairs forming the load-bearing frame." },
  { category: "walls", title: "Walls", description: "Exterior and interior walls enclosing and dividing the building." },
  { category: "openings", title: "Openings", description: "Doors and windows fitted into the walls." },
  { category: "services", title: "Services", description: "Plumbing and electrical systems routed through the building." },
  { category: "finish", title: "Finish", description: "Flooring, ceiling and surface finishes." },
  { category: "roof", title: "Roof", description: "Roof structure and covering over the building." },
  { category: "interior", title: "Interior", description: "Furniture and fixtures furnishing the interior spaces." },
  { category: "exterior", title: "Exterior", description: "Landscaping and exterior site elements." }
];

/**
 * Assigns one real project object to a construction phase, or null to
 * leave it out of the sequence entirely - rooms are a spatial/design
 * designation, not a built component with a construction trade, so every
 * `kind: "room"` element is excluded here.
 */
export function classifyConstructionObject(object: AIContextObject): ConstructionCategory | null {
  switch (object.type) {
    case "wall":
      return "walls";
    case "pillar":
    case "beam":
    case "slab":
      return "structure";
    case "door":
    case "window":
      return "openings";
    case "asset": {
      const definition = getAssetDefinition(object.assetId ?? "");
      return definition?.category === "outdoor" ? "exterior" : "interior";
    }
    case "element": {
      const kindId = object.kind ?? "";
      // These three kinds share the catalog's own "structure" category
      // (elements/catalog.ts) but need finer phases than that - checked
      // by exact kind before falling back to the shared category below.
      if (kindId === "room") {
        return null;
      }
      if (kindId === "foundation") {
        return "foundation";
      }
      if (kindId === "roof") {
        return "roof";
      }
      if (kindId === "stair") {
        return "structure";
      }
      if (kindId === "flooring" || kindId === "ceiling") {
        return "finish";
      }
      const definition = getElementKind(kindId);
      switch (definition?.category) {
        case "plumbing":
        case "electrical":
          return "services";
        case "interior":
          return "interior";
        case "exterior":
          return "exterior";
        case "structure":
          return "structure";
        case "finish":
          return "finish";
        default:
          return null;
      }
    }
    default:
      return null;
  }
}

function component(name: string, category: string, quantity: number | "As designed" | "Not calculated", unit: string, relatedObjectIds: string[]): RequiredComponent {
  return { name, category, quantity, unit, relatedObjectIds };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Sums `dimensions[key]` across objects that actually have it as a finite number - never treats a missing dimension as zero engineering fact, just as "doesn't contribute". */
function sumDimension(objects: readonly AIContextObject[], key: string): number {
  return objects.reduce((total, object) => {
    const value = object.dimensions[key];
    return typeof value === "number" && Number.isFinite(value) ? total + value : total;
  }, 0);
}

function sumArea(objects: readonly AIContextObject[], lengthKey: string, widthKey: string): number {
  return objects.reduce((total, object) => {
    const length = object.dimensions[lengthKey];
    const width = object.dimensions[widthKey];
    return typeof length === "number" && typeof width === "number" ? total + length * width : total;
  }, 0);
}

/** Groups objects by a string key, preserving first-seen order (the objects passed in are already sorted by id) so component lists are stable across runs. */
function groupBy(objects: readonly AIContextObject[], keyFn: (object: AIContextObject) => string): Map<string, AIContextObject[]> {
  const groups = new Map<string, AIContextObject[]>();
  for (const object of objects) {
    const key = keyFn(object);
    const list = groups.get(key) ?? [];
    list.push(object);
    groups.set(key, list);
  }
  return groups;
}

function componentsFor(category: ConstructionCategory, objects: readonly AIContextObject[]): RequiredComponent[] {
  const allIds = objects.map((object) => object.id);

  switch (category) {
    case "foundation":
      return [
        component("Foundation elements", "structural", objects.length, "unit", allIds),
        component("Concrete (foundation)", "structural", "Not calculated", "m³", allIds),
        component("Reinforcement steel", "structural", "Not calculated", "kg", allIds)
      ];

    case "structure": {
      const components: RequiredComponent[] = [];
      for (const type of ["pillar", "beam", "slab"] as const) {
        const matching = objects.filter((object) => object.type === type);
        if (matching.length > 0) {
          const label = type === "pillar" ? "Pillars" : type === "beam" ? "Beams" : "Slabs";
          components.push(component(label, "structural", matching.length, "unit", matching.map((object) => object.id)));
        }
      }
      const stairs = objects.filter((object) => object.kind === "stair");
      if (stairs.length > 0) {
        components.push(component("Stairs", "structural", stairs.length, "unit", stairs.map((object) => object.id)));
      }
      components.push(component("Concrete (structure)", "structural", "Not calculated", "m³", allIds));
      components.push(component("Reinforcement steel", "structural", "Not calculated", "kg", allIds));
      return components;
    }

    case "walls": {
      const components: RequiredComponent[] = [component("Wall count", "masonry", objects.length, "unit", allIds)];
      for (const [material, matching] of groupBy(objects, (object) => object.material)) {
        components.push(component(`Wall material - ${material}`, "masonry", matching.length, "unit", matching.map((object) => object.id)));
      }
      const totalLength = round2(sumDimension(objects, "length"));
      if (totalLength > 0) {
        components.push(component("Total wall length", "masonry", totalLength, "m", allIds));
      }
      return components;
    }

    case "openings": {
      const components: RequiredComponent[] = [];
      const doors = objects.filter((object) => object.type === "door");
      const windows = objects.filter((object) => object.type === "window");
      if (doors.length > 0) {
        components.push(component("Doors", "openings", doors.length, "unit", doors.map((object) => object.id)));
      }
      if (windows.length > 0) {
        components.push(component("Windows", "openings", windows.length, "unit", windows.map((object) => object.id)));
      }
      return components;
    }

    case "services": {
      const components: RequiredComponent[] = [];
      for (const [kindId, matching] of groupBy(objects, (object) => object.kind ?? "unknown")) {
        const definition = getElementKind(kindId);
        const label = definition?.label ?? kindId;
        const ids = matching.map((object) => object.id);
        if (definition?.linear) {
          components.push(component(label, definition.category, round2(sumDimension(matching, "length")), "m", ids));
        } else {
          components.push(component(label, definition?.category ?? "services", matching.length, "unit", ids));
        }
      }
      return components;
    }

    case "finish": {
      const components: RequiredComponent[] = [];
      const flooring = objects.filter((object) => object.kind === "flooring");
      const ceiling = objects.filter((object) => object.kind === "ceiling");
      if (flooring.length > 0) {
        components.push(component("Flooring area", "finish", round2(sumArea(flooring, "length", "width")), "m²", flooring.map((object) => object.id)));
      }
      if (ceiling.length > 0) {
        components.push(component("Ceiling area", "finish", round2(sumArea(ceiling, "length", "width")), "m²", ceiling.map((object) => object.id)));
      }
      return components;
    }

    case "roof":
      return [component("Roof area", "roofing", round2(sumArea(objects, "length", "width")), "m²", allIds)];

    case "interior":
    case "exterior": {
      const components: RequiredComponent[] = [];
      for (const [label, matching] of groupBy(objects, (object) => object.label ?? object.assetId ?? object.kind ?? "Item")) {
        components.push(component(label, category, matching.length, "unit", matching.map((object) => object.id)));
      }
      return components;
    }
  }
}

export interface GenerateConstructionSequenceOptions {
  /** ProjectMeta.id at generation time - null for an unsaved project. */
  projectId?: string | null;
}

/**
 * Builds a fresh ConstructionSequence from the project's real objects.
 * Only includes a step for a category that has at least one matching
 * object (task section 2: "a simple house without plumbing/electrical
 * objects must not show those steps") and always orders steps in the
 * fixed CATEGORY_DEFINITIONS phase order, never by discovery order.
 */
export function generateConstructionSequence(objects: readonly AIContextObject[], options: GenerateConstructionSequenceOptions = {}): ConstructionSequence {
  const byCategory = new Map<ConstructionCategory, AIContextObject[]>();
  for (const object of objects) {
    const category = classifyConstructionObject(object);
    if (!category) {
      continue;
    }
    const list = byCategory.get(category) ?? [];
    list.push(object);
    byCategory.set(category, list);
  }

  const steps: ConstructionStep[] = [];
  for (const definition of CATEGORY_DEFINITIONS) {
    const matching = byCategory.get(definition.category);
    if (!matching || matching.length === 0) {
      continue;
    }
    const sorted = [...matching].sort((a, b) => compareIds(a.id, b.id));
    steps.push({
      id: `step-${definition.category}`,
      order: steps.length + 1,
      title: definition.title,
      category: definition.category,
      description: definition.description,
      objectIds: sorted.map((object) => object.id),
      requiredComponents: componentsFor(definition.category, sorted),
      status: "pending"
    });
  }

  return {
    id: `sequence-${Date.now()}`,
    projectId: options.projectId ?? null,
    generatedAt: Date.now(),
    steps
  };
}
