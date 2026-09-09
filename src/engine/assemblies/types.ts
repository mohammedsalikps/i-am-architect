import type { ObjectId } from "../objects/types";

export type AssemblyId = string;

/**
 * A named, reusable grouping of construction objects (walls today,
 * other object types later). Not a ConstructionObjectBase itself - an
 * assembly has no position/dimensions/material/color of its own, just
 * an ordered list of the object ids it groups together. See
 * assemblies/README.md.
 */
export interface AssemblyData {
  id: AssemblyId;
  name: string;
  description?: string;
  /** Ordered - insertion order is preserved. AssemblyStore rejects duplicates. */
  objectIds: ObjectId[];
  /** Epoch milliseconds (Date.now()). */
  createdAt: number;
  /** Epoch milliseconds (Date.now()) - must never be earlier than createdAt. */
  updatedAt: number;
}

export interface AssemblyValidationError {
  field: string;
  message: string;
}

export interface AssemblyValidationResult {
  valid: boolean;
  errors: AssemblyValidationError[];
}
