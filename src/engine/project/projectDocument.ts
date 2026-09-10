// Explicit .ts extensions on these value imports let Node run this file
// directly - the backend and the verify suites both do (see
// allowImportingTsExtensions in tsconfig.json). Harmless for Vite.
import { validateWall } from "../wall/validateWall.ts";
import { validatePillar } from "../pillar/validatePillar.ts";
import { validateBeam } from "../beam/validateBeam.ts";
import { validateSlab } from "../slab/validateSlab.ts";
import { validateDoor } from "../door/validateDoor.ts";
import { validateWindow } from "../window/validateWindow.ts";
import { validateElement } from "../elements/validateElement.ts";
import { getElementKind } from "../elements/catalog.ts";
import { validateAssembly } from "../assemblies/AssemblyStore.ts";
import type { WallData } from "../wall/types";
import type { PillarData } from "../pillar/types";
import type { BeamData } from "../beam/types";
import type { SlabData } from "../slab/types";
import type { DoorData } from "../door/types";
import type { WindowData } from "../window/types";
import type { ElementData } from "../elements/types";
import type { AssemblyData } from "../assemblies/types";

/**
 * The persisted form of one project's construction model: ONE project,
 * ONE plain JSON document. It holds exactly what the stores hold - every
 * construction object as its store keeps it, and every assembly - and
 * nothing else: no meshes, no DOM, no selection, no undo history. The
 * scene is rebuilt from it the same way it is from any store change.
 *
 * It depends on nothing in the AI layer. The AI snapshot is a different,
 * derived view (sorted, assembly membership copied onto objects,
 * timestamps dropped); this document is the exact state to restore.
 *
 * parseProjectDocument() is the one gate every persisted document passes
 * before it can be loaded or stored - in the browser, on the backend, and
 * in the in-memory repository. See project/README.md.
 */

export const PROJECT_DOCUMENT_VERSION = 1;

/** Every persisted object type: the six original types, and "element" for every catalog kind (elements/catalog.ts). */
export const PERSISTED_OBJECT_TYPES = ["wall", "pillar", "beam", "slab", "door", "window", "element"] as const;
export type PersistedObjectType = (typeof PERSISTED_OBJECT_TYPES)[number];
type OriginalObjectType = Exclude<PersistedObjectType, "element">;

/** A construction object exactly as its store holds it. */
export type PersistedObject = WallData | PillarData | BeamData | SlabData | DoorData | WindowData | ElementData;

export interface ProjectDocument {
  version: typeof PROJECT_DOCUMENT_VERSION;
  objects: PersistedObject[];
  assemblies: AssemblyData[];
}

/** Each original type's dimension names, in the order its factory writes them. An element's come from its catalog kind. */
export const DIMENSION_KEYS: Readonly<Record<OriginalObjectType, readonly string[]>> = {
  wall: ["length", "height", "thickness"],
  pillar: ["width", "depth", "height"],
  beam: ["length", "width", "height"],
  slab: ["length", "width", "thickness"],
  door: ["width", "height", "thickness"],
  window: ["width", "height", "thickness"]
};

type Validation = { valid: boolean; errors: { field: string; message: string }[] };

/** Each type's own store validator - the same rules a live edit has to pass. */
const VALIDATORS: Readonly<Record<PersistedObjectType, (object: PersistedObject) => Validation>> = {
  wall: (object) => validateWall(object as WallData),
  pillar: (object) => validatePillar(object as PillarData),
  beam: (object) => validateBeam(object as BeamData),
  slab: (object) => validateSlab(object as SlabData),
  door: (object) => validateDoor(object as DoorData),
  window: (object) => validateWindow(object as WindowData),
  element: (object) => validateElement(object as ElementData)
};

export const MAX_PROJECT_NAME_LENGTH = 120;

/** Ids the factories hand out: "<type>-<n>" - for an element, "<kind>-<n>". Loading reserves them, so new objects never reuse one. */
const OBJECT_ID = /^(?:wall|pillar|beam|slab|door|window)-[1-9]\d*$/;
const ELEMENT_ID = /^([a-z][a-z-]*[a-z])-[1-9]\d*$/;
const ASSEMBLY_ID = /^assembly-[1-9]\d*$/;

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

export type ParsedProjectDocument = { ok: true; document: ProjectDocument } | { ok: false; error: string };
export type ParsedProjectName = { ok: true; name: string } | { ok: false; error: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function fail<T>(error: string): Parsed<T> {
  return { ok: false, error };
}

function isOpening(object: PersistedObject): object is DoorData | WindowData {
  return object.type === "door" || object.type === "window";
}

/** A record's fields copied one key list at a time, in that order. */
function pick(source: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const copy: Record<string, unknown> = {};
  for (const key of keys) {
    copy[key] = source[key];
  }
  return copy;
}

/**
 * An object in its canonical persisted form: every field copied out one
 * by one, dimensions (and an element's parameters) in the order the
 * factories write them. Both serializeProject() and parseProjectDocument()
 * produce this shape, so a loaded object is the same JSON as the object
 * that was saved.
 */
export function toPersistedObject(record: PersistedObject): PersistedObject {
  const position = { x: record.position.x, y: record.position.y, z: record.position.z };
  if (record.type === "element") {
    const definition = getElementKind(record.kind);
    const dimensionKeys = definition ? definition.dimensions.map((spec) => spec.key) : Object.keys(record.dimensions);
    const paramKeys = definition ? definition.params.map((spec) => spec.key) : Object.keys(record.params);
    return {
      id: record.id,
      type: record.type,
      kind: record.kind,
      label: record.label,
      position,
      rotation: record.rotation,
      dimensions: pick(record.dimensions, dimensionKeys),
      params: pick(record.params, paramKeys),
      material: record.material,
      color: record.color,
      assemblyId: record.assemblyId
    } as unknown as PersistedObject;
  }

  const base = {
    id: record.id,
    type: record.type,
    position,
    rotation: record.rotation,
    dimensions: pick(record.dimensions as unknown as Record<string, unknown>, DIMENSION_KEYS[record.type]),
    material: record.material,
    color: record.color,
    assemblyId: record.assemblyId
  };
  return (isOpening(record) ? { ...base, hostId: record.hostId ?? null } : base) as unknown as PersistedObject;
}

/** The checks every object shares - position, rotation, material, color, assemblyId. */
function parseCommonFields(
  raw: Record<string, unknown>,
  where: string
): Parsed<{ position: { x: number; y: number; z: number }; rotation: number; material: string; color: string; assemblyId: string | null }> {
  const position = raw.position;
  if (!isPlainObject(position) || !isFiniteNumber(position.x) || !isFiniteNumber(position.y) || !isFiniteNumber(position.z)) {
    return fail(`${where}: position must have finite numeric x, y and z.`);
  }
  const rotation = raw.rotation;
  if (!isFiniteNumber(rotation)) {
    return fail(`${where}: rotation must be a finite number.`);
  }
  const material = raw.material;
  if (!isNonEmptyString(material)) {
    return fail(`${where}: material must be a non-empty string.`);
  }
  const color = raw.color;
  if (typeof color !== "string") {
    return fail(`${where}: color must be a string.`);
  }
  const assemblyId = raw.assemblyId === undefined ? null : raw.assemblyId;
  if (assemblyId !== null && !isNonEmptyString(assemblyId)) {
    return fail(`${where}: assemblyId must be a non-empty string or null.`);
  }
  return { ok: true, value: { position: { x: position.x, y: position.y, z: position.z }, rotation, material, color, assemblyId } };
}

/** Exactly `expected` numeric dimensions, each finite and positive - in `expected`'s order. */
function parseDimensions(raw: unknown, expected: readonly string[], typeLabel: string, where: string): Parsed<Record<string, number>> {
  if (!isPlainObject(raw)) {
    return fail(`${where}: dimensions must be an object.`);
  }
  const unexpected = Object.keys(raw).find((key) => !expected.includes(key));
  if (unexpected !== undefined) {
    return fail(`${where}: a ${typeLabel} has no "${unexpected}" dimension (expected ${expected.join(", ")}).`);
  }
  const ordered: Record<string, number> = {};
  for (const key of expected) {
    const value = raw[key];
    if (!isFiniteNumber(value) || value <= 0) {
      return fail(`${where}: dimensions.${key} must be a finite number greater than 0.`);
    }
    ordered[key] = value;
  }
  return { ok: true, value: ordered };
}

function parseElement(raw: Record<string, unknown>, path: string): Parsed<PersistedObject> {
  const kind = raw.kind;
  const definition = typeof kind === "string" ? getElementKind(kind) : undefined;
  if (!definition) {
    return fail(`${path}: ${JSON.stringify(kind)} is not a known element kind.`);
  }

  const id = raw.id;
  const idMatch = typeof id === "string" ? ELEMENT_ID.exec(id) : null;
  if (typeof id !== "string" || !idMatch || idMatch[1] !== definition.kind) {
    return fail(`${path}: the id must look like "${definition.kind}-<number>", got ${JSON.stringify(id)}.`);
  }
  const where = `${path} (${id})`;

  const label = raw.label;
  if (!isNonEmptyString(label)) {
    return fail(`${where}: label must be a non-empty string.`);
  }

  const common = parseCommonFields(raw, where);
  if (!common.ok) {
    return common;
  }
  const dimensions = parseDimensions(
    raw.dimensions,
    definition.dimensions.map((spec) => spec.key),
    definition.label.toLowerCase(),
    where
  );
  if (!dimensions.ok) {
    return dimensions;
  }

  const rawParams = raw.params === undefined ? {} : raw.params;
  if (!isPlainObject(rawParams)) {
    return fail(`${where}: params must be an object.`);
  }
  const paramKeys = definition.params.map((spec) => spec.key);
  const unexpected = Object.keys(rawParams).find((key) => !paramKeys.includes(key));
  if (unexpected !== undefined) {
    return fail(`${where}: a ${definition.label.toLowerCase()} has no "${unexpected}" parameter.`);
  }
  const params: Record<string, number | string> = {};
  for (const key of paramKeys) {
    const value = rawParams[key];
    if (typeof value !== "number" && typeof value !== "string") {
      return fail(`${where}: params.${key} is missing.`);
    }
    params[key] = value;
  }

  const element: ElementData = {
    id,
    type: "element",
    kind: definition.kind,
    label,
    position: common.value.position,
    rotation: common.value.rotation,
    dimensions: dimensions.value,
    params,
    material: common.value.material,
    color: common.value.color,
    assemblyId: common.value.assemblyId
  };
  const validation = validateElement(element);
  if (!validation.valid) {
    return fail(`${where}: ${validation.errors[0]?.message ?? "invalid element."}`);
  }
  return { ok: true, value: element };
}

function parseObject(raw: unknown, path: string): Parsed<PersistedObject> {
  if (!isPlainObject(raw)) {
    return fail(`${path} must be an object.`);
  }

  const type = raw.type;
  if (typeof type !== "string" || !(PERSISTED_OBJECT_TYPES as readonly string[]).includes(type)) {
    return fail(`${path}: ${JSON.stringify(type)} is not a supported object type (${PERSISTED_OBJECT_TYPES.join(", ")}).`);
  }
  if (type === "element") {
    return parseElement(raw, path);
  }
  const objectType = type as OriginalObjectType;

  const id = raw.id;
  if (typeof id !== "string" || !OBJECT_ID.test(id) || !id.startsWith(`${objectType}-`)) {
    return fail(`${path}: the id must look like "${objectType}-<number>", got ${JSON.stringify(id)}.`);
  }
  const where = `${path} (${id})`;

  const common = parseCommonFields(raw, where);
  if (!common.ok) {
    return common;
  }
  const dimensions = parseDimensions(raw.dimensions, DIMENSION_KEYS[objectType], objectType, where);
  if (!dimensions.ok) {
    return dimensions;
  }

  const record: Record<string, unknown> = {
    id,
    type: objectType,
    position: common.value.position,
    rotation: common.value.rotation,
    dimensions: dimensions.value,
    material: common.value.material,
    color: common.value.color,
    assemblyId: common.value.assemblyId
  };

  if (objectType === "door" || objectType === "window") {
    const hostId = raw.hostId === undefined ? null : raw.hostId;
    if (hostId !== null && !isNonEmptyString(hostId)) {
      return fail(`${where}: hostId must be a wall id or null.`);
    }
    record.hostId = hostId;
  }

  const object = record as unknown as PersistedObject;
  // Last, the type's own validator - so a stored object obeys exactly the
  // rules a live edit does (e.g. a 6-digit hex color).
  const validation = VALIDATORS[objectType](object);
  if (!validation.valid) {
    return fail(`${where}: ${validation.errors[0]?.message ?? "invalid object."}`);
  }

  return { ok: true, value: object };
}

function parseAssembly(raw: unknown, path: string): Parsed<AssemblyData> {
  if (!isPlainObject(raw)) {
    return fail(`${path} must be an object.`);
  }

  const id = raw.id;
  if (typeof id !== "string" || !ASSEMBLY_ID.test(id)) {
    return fail(`${path}: the id must look like "assembly-<number>", got ${JSON.stringify(id)}.`);
  }
  const where = `${path} (${id})`;

  const name = raw.name;
  if (typeof name !== "string") {
    return fail(`${where}: name must be a string.`);
  }

  const description = raw.description;
  if (description !== undefined && typeof description !== "string") {
    return fail(`${where}: description must be a string when present.`);
  }

  const objectIds = raw.objectIds;
  if (!Array.isArray(objectIds) || !objectIds.every((objectId) => typeof objectId === "string")) {
    return fail(`${where}: objectIds must be an array of object ids.`);
  }

  const createdAt = raw.createdAt;
  const updatedAt = raw.updatedAt;
  if (!isFiniteNumber(createdAt) || !isFiniteNumber(updatedAt)) {
    return fail(`${where}: createdAt and updatedAt must be finite timestamps.`);
  }

  const assembly: AssemblyData = {
    id,
    name,
    ...(description === undefined ? {} : { description }),
    objectIds: [...objectIds],
    createdAt,
    updatedAt
  };

  const validation = validateAssembly(assembly);
  if (!validation.valid) {
    return fail(`${where}: ${validation.errors[0]?.message ?? "invalid assembly."}`);
  }

  return { ok: true, value: assembly };
}

/**
 * Validates an untrusted project document - a request body, a stored
 * record, anything - and returns a sanitized copy containing only the
 * fields ProjectDocument defines. Nothing is loaded or stored unless the
 * WHOLE document passes. It rejects:
 *
 * - anything that isn't a version-1 document with `objects` and
 *   `assemblies` arrays
 * - an unknown object type, or an element of an unknown kind
 * - a malformed or duplicate object id, or a duplicate assembly id
 * - missing, extra, zero, negative, or non-numeric dimensions, and an
 *   element's unknown or invalid parameters
 * - a non-finite position or rotation, a blank material, a bad color -
 *   and anything else the type's own validator rejects
 * - an assembly member that isn't an object in the document, an object
 *   whose assemblyId names no assembly in it, or a door/window whose
 *   hostId names no wall in it
 */
export function parseProjectDocument(value: unknown): ParsedProjectDocument {
  if (!isPlainObject(value)) {
    return { ok: false, error: "A project document must be an object." };
  }
  if (value.version !== PROJECT_DOCUMENT_VERSION) {
    return {
      ok: false,
      error: `Unsupported project document version ${JSON.stringify(value.version)} (expected ${PROJECT_DOCUMENT_VERSION}).`
    };
  }
  if (!Array.isArray(value.objects)) {
    return { ok: false, error: '"objects" must be an array.' };
  }
  if (!Array.isArray(value.assemblies)) {
    return { ok: false, error: '"assemblies" must be an array.' };
  }

  const objects: PersistedObject[] = [];
  const objectIds = new Set<string>();
  for (let index = 0; index < value.objects.length; index += 1) {
    const parsed = parseObject(value.objects[index], `objects[${index}]`);
    if (!parsed.ok) {
      return { ok: false, error: parsed.error };
    }
    if (objectIds.has(parsed.value.id)) {
      return { ok: false, error: `objects[${index}]: duplicate object id "${parsed.value.id}".` };
    }
    objectIds.add(parsed.value.id);
    objects.push(parsed.value);
  }

  const assemblies: AssemblyData[] = [];
  const assemblyIds = new Set<string>();
  for (let index = 0; index < value.assemblies.length; index += 1) {
    const parsed = parseAssembly(value.assemblies[index], `assemblies[${index}]`);
    if (!parsed.ok) {
      return { ok: false, error: parsed.error };
    }
    if (assemblyIds.has(parsed.value.id)) {
      return { ok: false, error: `assemblies[${index}]: duplicate assembly id "${parsed.value.id}".` };
    }
    const missing = parsed.value.objectIds.find((objectId) => !objectIds.has(objectId));
    if (missing !== undefined) {
      return {
        ok: false,
        error: `assemblies[${index}] (${parsed.value.id}): member "${missing}" is not an object in this project.`
      };
    }
    assemblyIds.add(parsed.value.id);
    assemblies.push(parsed.value);
  }

  const orphan = objects.find((object) => object.assemblyId !== null && !assemblyIds.has(object.assemblyId));
  if (orphan) {
    return { ok: false, error: `${orphan.id}: assemblyId "${orphan.assemblyId}" is not an assembly in this project.` };
  }

  const wallIds = new Set(objects.filter((object) => object.type === "wall").map((object) => object.id));
  const unhosted = objects.find((object) => isOpening(object) && object.hostId !== null && !wallIds.has(object.hostId));
  if (unhosted && isOpening(unhosted)) {
    return { ok: false, error: `${unhosted.id}: hostId "${unhosted.hostId}" is not a wall in this project.` };
  }

  return { ok: true, document: { version: PROJECT_DOCUMENT_VERSION, objects, assemblies } };
}

/** A project name: trimmed, non-empty, at most MAX_PROJECT_NAME_LENGTH characters. */
export function parseProjectName(value: unknown): ParsedProjectName {
  if (typeof value !== "string" || value.trim().length === 0) {
    return { ok: false, error: "A project name must be a non-empty string." };
  }
  const name = value.trim();
  if (name.length > MAX_PROJECT_NAME_LENGTH) {
    return { ok: false, error: `A project name can be at most ${MAX_PROJECT_NAME_LENGTH} characters.` };
  }
  return { ok: true, name };
}
