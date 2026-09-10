import type { ElementData, ElementId } from "./types";
// Explicit .ts extensions on these value imports let Node run this file
// directly (the verify suites do). Harmless for Vite.
import { ObjectRegistry, type RegistryListener } from "../objects/ObjectRegistry.ts";
import { validateElement, type ElementValidationResult } from "./validateElement.ts";
import { getElementKind } from "./catalog.ts";
import { keepBaseY } from "../objects/grounding.ts";

export type ElementStoreListener = RegistryListener<ElementData>;

export type ElementChanges = Partial<Omit<ElementData, "id" | "type" | "kind">>;

function notFound(id: ElementId): ElementValidationResult {
  return { valid: false, errors: [{ field: "id", message: `No element found with id "${id}".` }] };
}

/**
 * The one store for every element kind - the same "compose
 * ObjectRegistry, add only your own rules" facade as WallStore and its
 * siblings (see objects/README.md). Its rules come from the catalog:
 *
 * - every write is validated by validateElement() against the element's
 *   kind, and a rejected write leaves the store untouched
 * - a duplicate id is rejected on add()
 * - an element's kind never changes after it is created
 * - when the kind's vertical dimension changes without an explicit
 *   position, the base stays where it was (objects/grounding.ts) - a
 *   light keeps hanging from the ceiling, a flooring stays on its slab.
 *   A linear element (pipe, conduit, cable) keeps its axis instead, so
 *   its connected joints stay put.
 */
export class ElementStore {
  private readonly registry = new ObjectRegistry<ElementData>();

  add(element: ElementData): ElementValidationResult {
    const result = validateElement(element);
    if (!result.valid) {
      return result;
    }
    if (this.registry.has(element.id)) {
      return { valid: false, errors: [{ field: "id", message: `An element with id "${element.id}" already exists.` }] };
    }
    this.registry.add(element);
    return result;
  }

  /**
   * Merges `changes` into the element and validates the complete result
   * first. Like every store, nested `dimensions`, `params`, and `position`
   * are complete replacement objects when provided.
   */
  update(id: ElementId, changes: ElementChanges): ElementValidationResult {
    const existing = this.registry.get(id);
    if (!existing) {
      return notFound(id);
    }
    const rawKind = (changes as { kind?: unknown }).kind;
    if (rawKind !== undefined && rawKind !== existing.kind) {
      return { valid: false, errors: [{ field: "kind", message: "An element's kind can't change - add a new element instead." }] };
    }

    let effectiveChanges: ElementChanges = changes;
    const definition = getElementKind(existing.kind);
    // A linear element (pipe, conduit, cable) is routed by its axis: a new
    // diameter keeps the axis - and every joint on it - where it is.
    if (definition && !definition.linear && changes.position === undefined) {
      const verticalKey = definition.axes.y;
      const next = changes.dimensions?.[verticalKey];
      const current = existing.dimensions[verticalKey];
      if (next !== undefined && next !== current) {
        effectiveChanges = { ...changes, position: { ...existing.position, y: keepBaseY(existing.position.y, current, next) } };
      }
    }

    const merged: ElementData = { ...existing, ...effectiveChanges };
    const result = validateElement(merged);
    if (!result.valid) {
      return result;
    }
    this.registry.update(id, effectiveChanges);
    return result;
  }

  /** Overwrites an element exactly - for undo/redo snapshots. Still validated. */
  set(id: ElementId, element: ElementData): ElementValidationResult {
    const result = validateElement(element);
    if (!result.valid) {
      return result;
    }
    this.registry.set(id, element);
    return result;
  }

  remove(id: ElementId): void {
    this.registry.remove(id);
  }

  get(id: ElementId): ElementData | undefined {
    return this.registry.get(id);
  }

  getAll(): ElementData[] {
    return this.registry.getAll();
  }

  /** Returns an unsubscribe function. Calls the listener once immediately with the current state. */
  subscribe(listener: ElementStoreListener): () => void {
    return this.registry.subscribe(listener);
  }
}
