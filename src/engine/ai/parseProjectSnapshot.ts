// Explicit .ts extension on this value import (unlike the type-only
// imports below) lets Node run this file directly - the backend and the
// verify.ts scripts both do. Harmless for Vite.
import { AI_SUPPORTED_OBJECT_TYPES } from "./types.ts";
import type { ObjectType } from "../objects/types";
import type { AIContextAssembly, AIContextObject, AIProjectSnapshot } from "./types";

/**
 * Validates an untrusted `projectContext` - e.g. a request body the AI
 * proxy backend just parsed - and returns a sanitized copy containing
 * only the fields AIProjectSnapshot defines.
 *
 * Shared by backend/src/createServer.ts and the end-to-end suite's mock
 * backend (e2e/mockBackend.ts), so the two can never disagree about what
 * a valid snapshot is.
 *
 * "Sanitized" matters as much as "validated": every object and assembly
 * is rebuilt field by field, so anything extra a client sends - an
 * unexpected key, a nested blob, a `__proto__` entry - is dropped before
 * a provider ever sees it.
 *
 * Nothing is re-sorted here. Deterministic ordering is the builder's job
 * (buildAIProjectSnapshot); this relays a valid snapshot in the order it
 * arrived.
 */

export type ParsedAIProjectSnapshot = { ok: true; snapshot: AIProjectSnapshot } | { ok: false; error: string };

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

const COUNT_FIELDS = [
  "wallCount",
  "pillarCount",
  "beamCount",
  "slabCount",
  "doorCount",
  "windowCount",
  "assemblyCount"
] as const;

/** Dimension names are camelCase identifiers (length, height, width, ...). This also rules out `__proto__`. */
const DIMENSION_KEY = /^[A-Za-z][A-Za-z0-9]*$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isNonEmptyStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isNonEmptyString);
}

function parseObject(raw: unknown, path: string): Parsed<AIContextObject> {
  if (!isPlainObject(raw)) {
    return { ok: false, error: `"${path}" must be an object.` };
  }

  const id = raw.id;
  if (!isNonEmptyString(id)) {
    return { ok: false, error: `"${path}.id" must be a non-empty string.` };
  }

  const type = raw.type;
  if (typeof type !== "string" || !AI_SUPPORTED_OBJECT_TYPES.includes(type as ObjectType)) {
    return { ok: false, error: `"${path}.type" must be one of: ${AI_SUPPORTED_OBJECT_TYPES.join(", ")}.` };
  }

  const position = raw.position;
  if (!isPlainObject(position)) {
    return { ok: false, error: `"${path}.position" must be an object with finite x, y, and z.` };
  }
  const { x, y, z } = position;
  if (!isFiniteNumber(x) || !isFiniteNumber(y) || !isFiniteNumber(z)) {
    return { ok: false, error: `"${path}.position" must be an object with finite x, y, and z.` };
  }

  const rotation = raw.rotation;
  if (!isFiniteNumber(rotation)) {
    return { ok: false, error: `"${path}.rotation" must be a finite number.` };
  }

  const dimensions = raw.dimensions;
  if (!isPlainObject(dimensions)) {
    return { ok: false, error: `"${path}.dimensions" must be an object.` };
  }
  const dimensionsCopy: Record<string, number> = {};
  for (const [key, value] of Object.entries(dimensions)) {
    if (!DIMENSION_KEY.test(key) || !isFiniteNumber(value)) {
      return { ok: false, error: `"${path}.dimensions" must map identifier keys to finite numbers.` };
    }
    dimensionsCopy[key] = value;
  }

  const material = raw.material;
  if (typeof material !== "string") {
    return { ok: false, error: `"${path}.material" must be a string.` };
  }

  const color = raw.color;
  if (typeof color !== "string") {
    return { ok: false, error: `"${path}.color" must be a string.` };
  }

  const assemblyIds = raw.assemblyIds;
  if (!isNonEmptyStringList(assemblyIds)) {
    return { ok: false, error: `"${path}.assemblyIds" must be an array of non-empty strings.` };
  }

  return {
    ok: true,
    value: {
      id,
      type: type as ObjectType,
      position: { x, y, z },
      rotation,
      dimensions: dimensionsCopy,
      material,
      color,
      assemblyIds: [...assemblyIds]
    }
  };
}

function parseAssembly(raw: unknown, path: string): Parsed<AIContextAssembly> {
  if (!isPlainObject(raw)) {
    return { ok: false, error: `"${path}" must be an object.` };
  }

  const id = raw.id;
  if (!isNonEmptyString(id)) {
    return { ok: false, error: `"${path}.id" must be a non-empty string.` };
  }

  const name = raw.name;
  if (typeof name !== "string") {
    return { ok: false, error: `"${path}.name" must be a string.` };
  }

  const description = raw.description;
  if (description !== null && typeof description !== "string") {
    return { ok: false, error: `"${path}.description" must be a string or null.` };
  }

  const objectIds = raw.objectIds;
  if (!isNonEmptyStringList(objectIds)) {
    return { ok: false, error: `"${path}.objectIds" must be an array of non-empty strings.` };
  }

  return { ok: true, value: { id, name, description, objectIds: [...objectIds] } };
}

export function parseAIProjectSnapshot(value: unknown): ParsedAIProjectSnapshot {
  if (!isPlainObject(value)) {
    return { ok: false, error: '"projectContext" is required and must be an object.' };
  }

  const counts = {} as Record<(typeof COUNT_FIELDS)[number], number>;
  for (const field of COUNT_FIELDS) {
    const count = value[field];
    if (!isFiniteNumber(count)) {
      return { ok: false, error: `"projectContext.${field}" is required and must be a number.` };
    }
    counts[field] = count;
  }

  const selectedObjectId = value.selectedObjectId;
  if (selectedObjectId !== null && typeof selectedObjectId !== "string") {
    return { ok: false, error: '"projectContext.selectedObjectId" must be a string or null.' };
  }

  const rawObjects = value.objects;
  if (!Array.isArray(rawObjects)) {
    return { ok: false, error: '"projectContext.objects" is required and must be an array.' };
  }
  const objects: AIContextObject[] = [];
  for (let index = 0; index < rawObjects.length; index += 1) {
    const parsed = parseObject(rawObjects[index], `projectContext.objects[${index}]`);
    if (!parsed.ok) {
      return parsed;
    }
    objects.push(parsed.value);
  }

  const rawAssemblies = value.assemblies;
  if (!Array.isArray(rawAssemblies)) {
    return { ok: false, error: '"projectContext.assemblies" is required and must be an array.' };
  }
  const assemblies: AIContextAssembly[] = [];
  for (let index = 0; index < rawAssemblies.length; index += 1) {
    const parsed = parseAssembly(rawAssemblies[index], `projectContext.assemblies[${index}]`);
    if (!parsed.ok) {
      return parsed;
    }
    assemblies.push(parsed.value);
  }

  return {
    ok: true,
    snapshot: {
      wallCount: counts.wallCount,
      pillarCount: counts.pillarCount,
      beamCount: counts.beamCount,
      slabCount: counts.slabCount,
      doorCount: counts.doorCount,
      windowCount: counts.windowCount,
      assemblyCount: counts.assemblyCount,
      selectedObjectId,
      objects,
      assemblies
    }
  };
}
