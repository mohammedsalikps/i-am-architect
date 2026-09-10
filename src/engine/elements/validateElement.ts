// Explicit .ts extensions on these value imports let Node run this file
// directly (the verify suites and the backend do). Harmless for Vite.
import { getElementKind } from "./catalog.ts";
import { getMaterial } from "../materials/materialLibrary.ts";
import type { ElementData } from "./types";

export interface ElementValidationError {
  field: string;
  message: string;
}

export interface ElementValidationResult {
  valid: boolean;
  errors: ElementValidationError[];
}

const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validates a complete ElementData against its kind's catalog entry (see
 * catalog.ts) - the one rulebook for every element kind:
 *
 * - a known kind, a non-empty id and label, type "element"
 * - a finite position and rotation
 * - exactly the kind's dimensions, each a finite number no smaller than
 *   its catalog minimum
 * - a material from the material library, a #rrggbb color
 * - exactly the kind's parameters, each an integer in range or one of its
 *   choices
 *
 * Pure: returns a structured result instead of throwing, like every other
 * validator. ElementStore is the intended caller.
 */
export function validateElement(element: ElementData): ElementValidationResult {
  const errors: ElementValidationError[] = [];

  if (!isNonEmptyString(element.id)) {
    errors.push({ field: "id", message: "Element id must be non-empty." });
  }
  if (element.type !== "element") {
    errors.push({ field: "type", message: 'Element type must be "element".' });
  }

  const definition = getElementKind(element.kind);
  if (!definition) {
    errors.push({ field: "kind", message: `"${String(element.kind)}" is not a known element kind.` });
  }

  if (!isNonEmptyString(element.label)) {
    errors.push({ field: "label", message: "Name must be a non-empty string." });
  }

  for (const axis of ["x", "y", "z"] as const) {
    if (!Number.isFinite(element.position?.[axis])) {
      errors.push({ field: `position.${axis}`, message: `Position ${axis.toUpperCase()} must be a finite number.` });
    }
  }
  if (!Number.isFinite(element.rotation)) {
    errors.push({ field: "rotation", message: "Rotation Y must be a finite number." });
  }

  if (!isPlainObject(element.dimensions)) {
    errors.push({ field: "dimensions", message: "Dimensions must be an object." });
  } else if (definition) {
    const known = definition.dimensions.map((spec) => spec.key);
    for (const key of Object.keys(element.dimensions)) {
      if (!known.includes(key)) {
        errors.push({ field: `dimensions.${key}`, message: `A ${definition.label.toLowerCase()} has no "${key}" dimension.` });
      }
    }
    for (const spec of definition.dimensions) {
      const value = element.dimensions[spec.key];
      if (typeof value !== "number" || !Number.isFinite(value) || value < spec.min) {
        errors.push({
          field: `dimensions.${spec.key}`,
          message: `${spec.label} must be a finite number of at least ${spec.min} m.`
        });
      }
    }
  }

  if (!isNonEmptyString(element.material)) {
    errors.push({ field: "material", message: "Material must be a non-empty string." });
  } else if (!getMaterial(element.material)) {
    errors.push({ field: "material", message: `"${element.material}" is not a material in the library.` });
  }

  if (typeof element.color !== "string" || !HEX_COLOR_PATTERN.test(element.color)) {
    errors.push({ field: "color", message: "Color must be a 6-digit hex string, e.g. #c9c9c9." });
  }

  if (element.assemblyId !== null && !isNonEmptyString(element.assemblyId)) {
    errors.push({ field: "assemblyId", message: "assemblyId must be a non-empty string, or null." });
  }

  if (!isPlainObject(element.params)) {
    errors.push({ field: "params", message: "Parameters must be an object." });
  } else if (definition) {
    const known = definition.params.map((spec) => spec.key);
    for (const key of Object.keys(element.params)) {
      if (!known.includes(key)) {
        errors.push({ field: `params.${key}`, message: `A ${definition.label.toLowerCase()} has no "${key}" parameter.` });
      }
    }
    for (const spec of definition.params) {
      const value = element.params[spec.key];
      if (spec.kind === "integer") {
        if (typeof value !== "number" || !Number.isInteger(value) || value < spec.min || value > spec.max) {
          errors.push({ field: `params.${spec.key}`, message: `${spec.label} must be a whole number from ${spec.min} to ${spec.max}.` });
        }
      } else if (typeof value !== "string" || !spec.options.includes(value)) {
        errors.push({ field: `params.${spec.key}`, message: `${spec.label} must be one of: ${spec.options.join(", ")}.` });
      }
    }
  }

  validateConnections(element, definition?.connectsWith.length ? definition.label : null, errors);

  return { valid: errors.length === 0, errors };
}

const ENDPOINT_NAMES: readonly string[] = ["start", "end"];

/**
 * The per-element rules for `connections` (the cross-element ones - the
 * other element exists, is compatible, lists the connection back, and its
 * endpoint coincides - are in connections/connections.ts): a list; only a
 * connectable kind has any; every entry names this element's endpoint,
 * another element, and that element's endpoint; no entry is repeated, and
 * one endpoint joins a given element only once.
 */
function validateConnections(element: ElementData, connectableLabel: string | null, errors: ElementValidationError[]): void {
  if (!Array.isArray(element.connections)) {
    errors.push({ field: "connections", message: "Connections must be a list." });
    return;
  }
  if (connectableLabel === null && element.connections.length > 0) {
    errors.push({ field: "connections", message: "This kind of element has no endpoints to connect." });
    return;
  }
  const seen = new Set<string>();
  element.connections.forEach((connection, index) => {
    const field = `connections[${index}]`;
    if (!isPlainObject(connection)) {
      errors.push({ field, message: "A connection must be an object." });
      return;
    }
    if (!ENDPOINT_NAMES.includes(connection.endpoint) || !ENDPOINT_NAMES.includes(connection.objectEndpoint)) {
      errors.push({ field, message: 'A connection joins endpoints named "start" or "end".' });
      return;
    }
    if (!isNonEmptyString(connection.objectId)) {
      errors.push({ field, message: "A connection must name the element it joins." });
      return;
    }
    if (connection.objectId === element.id) {
      errors.push({ field, message: "An element can't connect to itself." });
      return;
    }
    const key = `${connection.endpoint}>${connection.objectId}`;
    if (seen.has(key)) {
      errors.push({ field, message: `The ${connection.endpoint} is already connected to ${connection.objectId}.` });
      return;
    }
    seen.add(key);
  });
}
