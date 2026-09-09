import type { SlabData } from "./types";

export interface SlabValidationError {
  field: string;
  message: string;
}

export interface SlabValidationResult {
  valid: boolean;
  errors: SlabValidationError[];
}

/** 6-digit hex only - #rrggbb, matching what the color-picker UI and createSlabData's defaults produce. */
const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

function isPositiveFinite(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Validates a complete SlabData object and returns a structured result
 * instead of throwing - same convention as validateWall.ts/
 * validatePillar.ts/validateBeam.ts. Pure function, no side effects,
 * no knowledge of SlabStore/ObjectRegistry/history - SlabStore is the
 * only intended caller (on add()/update()/set()).
 *
 * Does NOT check for duplicate ids against other stored slabs - that's
 * a store-level concern (see SlabStore.add()).
 */
export function validateSlab(slab: SlabData): SlabValidationResult {
  const errors: SlabValidationError[] = [];

  if (!isNonEmptyString(slab.id)) {
    errors.push({ field: "id", message: "Slab id must be non-empty." });
  }

  if (slab.type !== "slab") {
    errors.push({ field: "type", message: 'Slab type must be "slab".' });
  }

  if (!Number.isFinite(slab.position?.x)) {
    errors.push({ field: "position.x", message: "Position X must be a finite number." });
  }
  if (!Number.isFinite(slab.position?.y)) {
    errors.push({ field: "position.y", message: "Position Y must be a finite number." });
  }
  if (!Number.isFinite(slab.position?.z)) {
    errors.push({ field: "position.z", message: "Position Z must be a finite number." });
  }

  if (!Number.isFinite(slab.rotation)) {
    errors.push({ field: "rotation", message: "Rotation Y must be a finite number." });
  }

  if (!isPositiveFinite(slab.dimensions?.length)) {
    errors.push({ field: "dimensions.length", message: "Length must be a finite number greater than 0." });
  }
  if (!isPositiveFinite(slab.dimensions?.width)) {
    errors.push({ field: "dimensions.width", message: "Width must be a finite number greater than 0." });
  }
  if (!isPositiveFinite(slab.dimensions?.thickness)) {
    errors.push({ field: "dimensions.thickness", message: "Thickness must be a finite number greater than 0." });
  }

  if (typeof slab.color !== "string" || !HEX_COLOR_PATTERN.test(slab.color)) {
    errors.push({ field: "color", message: "Color must be a 6-digit hex string, e.g. #c9c9c9." });
  }

  if (!isNonEmptyString(slab.material)) {
    errors.push({ field: "material", message: "Material must be a non-empty string." });
  }

  if (slab.assemblyId !== null && !isNonEmptyString(slab.assemblyId)) {
    errors.push({ field: "assemblyId", message: "assemblyId must be a non-empty string, or null." });
  }

  return { valid: errors.length === 0, errors };
}
