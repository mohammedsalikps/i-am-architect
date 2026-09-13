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
import { validateAsset } from "../assets/validateAsset.ts";
import { getAssetDefinition } from "../assets/catalog.ts";
import { validateAssembly } from "../assemblies/AssemblyStore.ts";
import { hostedTransform, hostingProblems, placementFromWorld } from "../openings/hostOpening.ts";
import { connectionProblems } from "../connections/connections.ts";
import type { WallData } from "../wall/types";
import type { PillarData } from "../pillar/types";
import type { BeamData } from "../beam/types";
import type { SlabData } from "../slab/types";
import type { DoorData } from "../door/types";
import type { WindowData } from "../window/types";
import type { ElementConnection, ElementData, Endpoint } from "../elements/types";
import type { AssetData } from "../assets/types";
import type { AssemblyData } from "../assemblies/types";
import type { HostPlacement } from "../openings/hostOpening";

/**
 * The persisted form of one project's construction model: ONE project,
 * ONE plain JSON document. It holds exactly what the stores hold - every
 * construction object as its store keeps it, and every assembly - and
 * nothing else: no meshes, no DOM, no selection, no undo history. The
 * scene is rebuilt from it the same way it is from any store change.
 *
 * Relationships are part of the objects: a door or window in a wall has
 * `hostId` and its relative `hostPlacement` (offset along the wall, sill);
 * a connected pipe, conduit, or cable has `connections`. A loaded project
 * never brings back a broken relationship - see parseProjectDocument().
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

/** Every persisted object type: the six original types, "element" for every catalog kind (elements/catalog.ts), and "asset" for every placed design asset (assets/catalog.ts). */
export const PERSISTED_OBJECT_TYPES = ["wall", "pillar", "beam", "slab", "door", "window", "element", "asset"] as const;
export type PersistedObjectType = (typeof PERSISTED_OBJECT_TYPES)[number];
type OriginalObjectType = Exclude<PersistedObjectType, "element" | "asset">;

/** A construction object exactly as its store holds it. */
export type PersistedObject = WallData | PillarData | BeamData | SlabData | DoorData | WindowData | ElementData | AssetData;

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
  element: (object) => validateElement(object as ElementData),
  asset: (object) => validateAsset(object as AssetData)
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

function isElement(object: PersistedObject): object is ElementData {
  return object.type === "element";
}

/** A record's fields copied one key list at a time, in that order. */
function pick(source: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const copy: Record<string, unknown> = {};
  for (const key of keys) {
    copy[key] = source[key];
  }
  return copy;
}

function copyConnections(connections: readonly ElementConnection[] | undefined): ElementConnection[] {
  return (connections ?? []).map((connection) => ({
    endpoint: connection.endpoint,
    objectId: connection.objectId,
    objectEndpoint: connection.objectEndpoint
  }));
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
      assemblyId: record.assemblyId,
      connections: copyConnections(record.connections)
    } as unknown as PersistedObject;
  }
  if (record.type === "asset") {
    return {
      id: record.id,
      type: record.type,
      assetId: record.assetId,
      label: record.label,
      position,
      rotation: record.rotation,
      dimensions: { width: record.dimensions.width, height: record.dimensions.height, depth: record.dimensions.depth },
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
  if (!isOpening(record)) {
    return base as unknown as PersistedObject;
  }
  const placement = record.hostPlacement ?? null;
  return {
    ...base,
    hostId: record.hostId ?? null,
    hostPlacement: placement === null ? null : { offset: placement.offset, sill: placement.sill }
  } as unknown as PersistedObject;
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

/** A list of connection entries, copied field by field (validateElement and connectionProblems check the rest). Absent: none. */
function parseConnections(raw: unknown, where: string): Parsed<ElementConnection[]> {
  if (raw === undefined) {
    return { ok: true, value: [] };
  }
  if (!Array.isArray(raw)) {
    return fail(`${where}: connections must be a list.`);
  }
  const connections: ElementConnection[] = [];
  for (const entry of raw) {
    if (!isPlainObject(entry) || typeof entry.endpoint !== "string" || typeof entry.objectId !== "string" || typeof entry.objectEndpoint !== "string") {
      return fail(`${where}: each connection must be { endpoint, objectId, objectEndpoint }.`);
    }
    connections.push({ endpoint: entry.endpoint as Endpoint, objectId: entry.objectId, objectEndpoint: entry.objectEndpoint as Endpoint });
  }
  return { ok: true, value: connections };
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

  const connections = parseConnections(raw.connections, where);
  if (!connections.ok) {
    return connections;
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
    assemblyId: common.value.assemblyId,
    connections: connections.value
  };
  const validation = validateElement(element);
  if (!validation.valid) {
    return fail(`${where}: ${validation.errors[0]?.message ?? "invalid element."}`);
  }
  return { ok: true, value: element };
}

/**
 * `derivePlacement` collects the ids of hosted openings saved before
 * placements were stored: their placement is worked out from their
 * position once their wall is known (see resolveHosting).
 */
function parseObject(raw: unknown, path: string, derivePlacement: Set<string>): Parsed<PersistedObject> {
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
  if (type === "asset") {
    return parseAsset(raw, path);
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
    const rawPlacement = raw.hostPlacement === undefined ? null : raw.hostPlacement;
    let placement: HostPlacement | null = null;
    if (rawPlacement !== null) {
      if (!isPlainObject(rawPlacement) || !isFiniteNumber(rawPlacement.offset) || !isFiniteNumber(rawPlacement.sill)) {
        return fail(`${where}: hostPlacement must have a finite offset and sill.`);
      }
      if (hostId === null) {
        return fail(`${where}: a free-standing ${objectType} has no hostPlacement.`);
      }
      placement = { offset: rawPlacement.offset, sill: rawPlacement.sill };
    } else if (hostId !== null) {
      // Saved before placements were stored - worked out from its position once its wall is known.
      derivePlacement.add(id);
      placement = { offset: 0, sill: 0 };
    }
    record.hostId = hostId;
    record.hostPlacement = placement;
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

/** A design asset - the same "kind"-shaped id, common fields, then its own dimensions - as parseElement(), minus params/connections (an asset has neither). */
function parseAsset(raw: Record<string, unknown>, path: string): Parsed<PersistedObject> {
  const assetId = raw.assetId;
  const definition = typeof assetId === "string" ? getAssetDefinition(assetId) : undefined;
  if (!definition) {
    return fail(`${path}: ${JSON.stringify(assetId)} is not a known asset.`);
  }

  const id = raw.id;
  const idMatch = typeof id === "string" ? ELEMENT_ID.exec(id) : null; // same "<name>-<number>" id shape as an element's
  if (typeof id !== "string" || !idMatch || idMatch[1] !== definition.id) {
    return fail(`${path}: the id must look like "${definition.id}-<number>", got ${JSON.stringify(id)}.`);
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
  const dimensions = parseDimensions(raw.dimensions, ["width", "height", "depth"], "asset", where);
  if (!dimensions.ok) {
    return dimensions;
  }

  const asset: AssetData = {
    id,
    type: "asset",
    assetId: definition.id,
    label,
    position: common.value.position,
    rotation: common.value.rotation,
    dimensions: { width: dimensions.value.width, height: dimensions.value.height, depth: dimensions.value.depth },
    material: common.value.material,
    color: common.value.color,
    assemblyId: common.value.assemblyId
  };
  const validation = validateAsset(asset);
  if (!validation.valid) {
    return fail(`${where}: ${validation.errors[0]?.message ?? "invalid asset."}`);
  }
  return { ok: true, value: asset as unknown as PersistedObject };
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
 * The hosted openings, re-derived from their walls: a placement saved
 * without one is worked out from the opening's position, and every hosted
 * opening's position and rotation are recomputed from its wall and
 * placement - so a loaded opening always sits exactly where its wall says.
 * Then each must fit its wall and overlap no other opening in it.
 */
function resolveHosting(objects: PersistedObject[], derivePlacement: ReadonlySet<string>): string | null {
  const walls = new Map(objects.filter((object) => object.type === "wall").map((wall) => [wall.id, wall as WallData]));
  for (let index = 0; index < objects.length; index += 1) {
    const object = objects[index];
    if (!isOpening(object) || object.hostId === null) {
      continue;
    }
    const wall = walls.get(object.hostId);
    if (!wall) {
      return `${object.id}: hostId "${object.hostId}" is not a wall in this project.`;
    }
    const placement = derivePlacement.has(object.id)
      ? placementFromWorld(wall, object.dimensions, object.position)
      : (object.hostPlacement as HostPlacement);
    const transform = hostedTransform(wall, object.dimensions, placement);
    objects[index] = { ...object, hostPlacement: placement, position: transform.position, rotation: transform.rotation };
  }

  const hosted = objects.filter((object): object is DoorData | WindowData => isOpening(object) && object.hostId !== null);
  for (const opening of hosted) {
    const wall = walls.get(opening.hostId as string) as WallData;
    const siblings = hosted
      .filter((other) => other.id !== opening.id && other.hostId === opening.hostId)
      .map((other) => ({ id: other.id, size: other.dimensions, placement: other.hostPlacement as HostPlacement }));
    const problems = hostingProblems(wall, { id: opening.id, size: opening.dimensions }, opening.hostPlacement as HostPlacement, siblings);
    if (problems.length > 0) {
      return `${opening.id}: ${problems[0]}`;
    }
  }
  return null;
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
 * - an assembly member that isn't an object in the document, or an object
 *   whose assemblyId names no assembly in it
 * - a door or window whose hostId names no wall in it, that doesn't fit
 *   its wall, or that overlaps another opening in it (a hosted opening's
 *   position is re-derived from its wall - see resolveHosting)
 * - a connection to a missing element, between incompatible kinds, not
 *   recorded on both elements, or between endpoints that don't meet
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
  const derivePlacement = new Set<string>();
  for (let index = 0; index < value.objects.length; index += 1) {
    const parsed = parseObject(value.objects[index], `objects[${index}]`, derivePlacement);
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

  const hostingError = resolveHosting(objects, derivePlacement);
  if (hostingError !== null) {
    return { ok: false, error: hostingError };
  }

  const connectionError = connectionProblems(objects.filter(isElement))[0];
  if (connectionError !== undefined) {
    return { ok: false, error: connectionError };
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
