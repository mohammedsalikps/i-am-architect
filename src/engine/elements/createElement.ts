// Explicit .ts extension on this value import lets Node run this file
// directly (the verify suites do). Harmless for Vite.
import { getElementKind } from "./catalog.ts";
import type { ElementData, ElementParams } from "./types";
import type { Vector3Data } from "../objects/types";

export interface CreateElementOptions {
  /** Which catalog entry to build - required. */
  kind: string;
  /** The name people see; defaults to the kind's label. */
  label?: string;
  position?: Partial<Vector3Data>;
  rotation?: number;
  /** Any of the kind's dimensions; the rest take the catalog defaults. */
  dimensions?: Record<string, number>;
  params?: ElementParams;
  material?: string;
  color?: string;
}

/** Per-kind id counters: roof-1, roof-2, water-pipe-1, ... */
const nextIds = new Map<string, number>();

function nextIdFor(kindId: string): string {
  const next = nextIds.get(kindId) ?? 1;
  nextIds.set(kindId, next + 1);
  return `${kindId}-${next}`;
}

/** Copies an untrusted record's own keys - never "__proto__", which would change the target's prototype. */
function copyEntries<T>(target: Record<string, T>, source: Record<string, T> | undefined): void {
  if (!source || typeof source !== "object") {
    return;
  }
  for (const key of Object.keys(source)) {
    if (key !== "__proto__") {
      target[key] = source[key];
    }
  }
}

/**
 * Makes every id createElementData() hands out from now on come after
 * `ids` - called when a saved project is loaded, since its elements keep
 * their ids (see project/projectPersistence.ts). Never moves a counter
 * backwards.
 */
export function reserveElementIds(ids: Iterable<string>): void {
  for (const id of ids) {
    const match = /^([a-z][a-z-]*[a-z])-(\d+)$/.exec(id);
    if (match && getElementKind(match[1])) {
      nextIds.set(match[1], Math.max(nextIds.get(match[1]) ?? 1, Number(match[2]) + 1));
    }
  }
}

/**
 * A new element of a catalog kind, with the catalog's defaults for
 * anything not given. Its base rests at the kind's `baseY` (the ground,
 * a ceiling, a counter top...) unless a position with y is supplied.
 *
 * Values are copied, not checked: ElementStore validates the result (an
 * unknown dimension key, a bad material, ...) exactly as it validates any
 * other write. Throws only for an unknown kind, which has no defaults to
 * build from - CommandExecutor checks the kind first and reports it.
 */
export function createElementData(options: CreateElementOptions): ElementData {
  const definition = getElementKind(options.kind);
  if (!definition) {
    throw new Error(`Unknown element kind "${String(options.kind)}".`);
  }

  const dimensions: Record<string, number> = {};
  for (const spec of definition.dimensions) {
    dimensions[spec.key] = spec.default;
  }
  copyEntries(dimensions, options.dimensions);

  const params: ElementParams = {};
  for (const spec of definition.params) {
    params[spec.key] = spec.default;
  }
  copyEntries(params, options.params);

  const vertical = dimensions[definition.axes.y];
  const position: Vector3Data = {
    x: options.position?.x ?? 0,
    y: options.position?.y ?? definition.baseY + vertical / 2,
    z: options.position?.z ?? 0
  };

  return {
    id: nextIdFor(definition.kind),
    type: "element",
    kind: definition.kind,
    label: options.label ?? definition.label,
    position,
    rotation: options.rotation ?? 0,
    dimensions,
    params,
    material: options.material ?? definition.defaultMaterial,
    color: options.color ?? definition.defaultColor,
    assemblyId: null,
    // A new element - a duplicate included - starts unconnected: only
    // element.connect joins endpoints (see connections/connections.ts).
    connections: []
  };
}

/** World-space offset applied to a duplicate so it never sits exactly on top of the original - the same value every object type uses. */
const DUPLICATE_OFFSET = 0.75;

/** An independent copy: same kind, label, size, parameters, material and color, a fresh id, offset so the two don't overlap. */
export function duplicateElementData(element: ElementData): ElementData {
  return createElementData({
    kind: element.kind,
    label: element.label,
    position: {
      x: element.position.x + DUPLICATE_OFFSET,
      y: element.position.y,
      z: element.position.z + DUPLICATE_OFFSET
    },
    rotation: element.rotation,
    dimensions: { ...element.dimensions },
    params: { ...element.params },
    material: element.material,
    color: element.color
  });
}
