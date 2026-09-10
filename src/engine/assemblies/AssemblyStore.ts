import type { AssemblyData, AssemblyId, AssemblyValidationResult } from "./types";
import type { ObjectId } from "../objects/types";
// Explicit .ts extension on this value import (unlike the type-only
// imports elsewhere in this file) is required so Node can run this
// file directly, e.g. from src/engine/assemblies/verify.ts - see
// allowImportingTsExtensions in tsconfig.json. Harmless for Vite too.
import { ObjectRegistry, type RegistryListener } from "../objects/ObjectRegistry.ts";

export type AssemblyStoreListener = RegistryListener<AssemblyData>;

export interface CreateAssemblyOptions {
  name: string;
  description?: string;
  objectIds?: ObjectId[];
}

let nextAssemblyId = 1;

/** Makes new assembly ids come after `ids` - the same rule as createWall.ts's reserveWallIds(), for loaded projects. */
export function reserveAssemblyIds(ids: Iterable<string>): void {
  for (const id of ids) {
    const match = /^assembly-(\d+)$/.exec(id);
    if (match) {
      nextAssemblyId = Math.max(nextAssemblyId, Number(match[1]) + 1);
    }
  }
}

/** Creates a new assembly with a fresh id and createdAt === updatedAt (both Date.now()). */
export function createAssemblyData(options: CreateAssemblyOptions): AssemblyData {
  const now = Date.now();
  return {
    id: `assembly-${nextAssemblyId++}`,
    name: options.name,
    description: options.description,
    objectIds: options.objectIds ? [...options.objectIds] : [],
    createdAt: now,
    updatedAt: now
  };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Validates a complete AssemblyData object's own shape. Does NOT check
 * whether its id collides with an existing assembly (that's a store-
 * level concern - see AssemblyStore.add()) and does NOT check whether
 * its objectIds actually exist in any object store (an assembly can
 * end up referencing a wall that's later deleted; reconciling that is
 * out of scope for this milestone - see assemblies/README.md).
 */
export function validateAssembly(assembly: AssemblyData): AssemblyValidationResult {
  const errors: AssemblyValidationResult["errors"] = [];

  if (!isNonEmptyString(assembly.id)) {
    errors.push({ field: "id", message: "Assembly id must be non-empty." });
  }

  if (!isNonEmptyString(assembly.name)) {
    errors.push({ field: "name", message: "Assembly name must be non-empty." });
  }

  if (!Array.isArray(assembly.objectIds)) {
    errors.push({ field: "objectIds", message: "objectIds must be an array." });
  } else {
    if (assembly.objectIds.some((id) => !isNonEmptyString(id))) {
      errors.push({ field: "objectIds", message: "Every object id must be a non-empty string." });
    }
    if (new Set(assembly.objectIds).size !== assembly.objectIds.length) {
      errors.push({ field: "objectIds", message: "objectIds must not contain duplicates." });
    }
  }

  if (!Number.isFinite(assembly.createdAt)) {
    errors.push({ field: "createdAt", message: "createdAt must be a finite timestamp." });
  }
  if (!Number.isFinite(assembly.updatedAt)) {
    errors.push({ field: "updatedAt", message: "updatedAt must be a finite timestamp." });
  }
  if (
    Number.isFinite(assembly.createdAt) &&
    Number.isFinite(assembly.updatedAt) &&
    assembly.updatedAt < assembly.createdAt
  ) {
    errors.push({ field: "updatedAt", message: "updatedAt must not be earlier than createdAt." });
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Domain-specific facade over the generic ObjectRegistry, following
 * the same pattern WallStore does: storage/CRUD/cloning/subscriptions
 * delegate to a private ObjectRegistry<AssemblyData>, and this class
 * adds only what's actually assembly-specific:
 *
 * - Shape validation (validateAssembly above) before every write.
 * - Rejecting a duplicate assembly id on add() - a generic registry
 *   has no "this id must not already exist" concept, only "add
 *   replaces whatever's there."
 *
 * No undo/redo yet - see assemblies/README.md for what's deliberately
 * out of scope for this milestone.
 */
export class AssemblyStore {
  private readonly registry = new ObjectRegistry<AssemblyData>();

  /** Validates `assembly` and rejects a duplicate id; only stores it (and notifies subscribers) if both pass. */
  add(assembly: AssemblyData): AssemblyValidationResult {
    const shapeResult = validateAssembly(assembly);
    if (!shapeResult.valid) {
      return shapeResult;
    }

    if (this.registry.get(assembly.id) !== undefined) {
      return {
        valid: false,
        errors: [{ field: "id", message: `An assembly with id "${assembly.id}" already exists.` }]
      };
    }

    this.registry.add(assembly);
    return shapeResult;
  }

  /**
   * Merges `changes` into the existing assembly and validates the
   * resulting *complete* assembly before applying it. `changes.objectIds`
   * must be a complete replacement array when provided (not a partial
   * merge), the same "complete replacement value" convention WallStore
   * uses for its own nested fields.
   */
  update(id: AssemblyId, changes: Partial<Omit<AssemblyData, "id">>): AssemblyValidationResult {
    const existing = this.registry.get(id);
    if (!existing) {
      return { valid: false, errors: [{ field: "id", message: `No assembly found with id "${id}".` }] };
    }

    const merged: AssemblyData = { ...existing, ...changes };
    const result = validateAssembly(merged);
    if (!result.valid) {
      return result;
    }

    this.registry.update(id, changes);
    return result;
  }

  remove(id: AssemblyId): void {
    this.registry.remove(id);
  }

  get(id: AssemblyId): AssemblyData | undefined {
    return this.registry.get(id);
  }

  getAll(): AssemblyData[] {
    return this.registry.getAll();
  }

  /** Returns an unsubscribe function. Calls the listener once immediately with the current state. */
  subscribe(listener: AssemblyStoreListener): () => void {
    return this.registry.subscribe(listener);
  }
}
