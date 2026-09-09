import type { PillarData } from "./types";

export interface PillarValidationError {
  field: string;
  message: string;
}

export interface PillarValidationResult {
  valid: boolean;
  errors: PillarValidationError[];
}

/** 6-digit hex only - #rrggbb, matching what the color-picker UI and createPillarData's defaults produce. */
const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

function isPositiveFinite(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Validates a complete PillarData object and returns a structured
 * result instead of throwing - same convention as validateWall.ts.
 * Pure function, no side effects, no knowledge of PillarStore/
 * ObjectRegistry/history - PillarStore is the only intended caller (on
 * add()/update()/set()).
 *
 * Does NOT check for duplicate ids against other stored pillars -
 * that's a store-level concern (see PillarStore.add(), same as
 * AssemblyStore.add() does for assembly ids).
 */
export function validatePillar(pillar: PillarData): PillarValidationResult {
  const errors: PillarValidationError[] = [];

  if (!isNonEmptyString(pillar.id)) {
    errors.push({ field: "id", message: "Pillar id must be non-empty." });
  }

  if (pillar.type !== "pillar") {
    errors.push({ field: "type", message: 'Pillar type must be "pillar".' });
  }

  if (!Number.isFinite(pillar.position?.x)) {
    errors.push({ field: "position.x", message: "Position X must be a finite number." });
  }
  if (!Number.isFinite(pillar.position?.y)) {
    errors.push({ field: "position.y", message: "Position Y must be a finite number." });
  }
  if (!Number.isFinite(pillar.position?.z)) {
    errors.push({ field: "position.z", message: "Position Z must be a finite number." });
  }

  if (!Number.isFinite(pillar.rotation)) {
    errors.push({ field: "rotation", message: "Rotation Y must be a finite number." });
  }

  if (!isPositiveFinite(pillar.dimensions?.width)) {
    errors.push({ field: "dimensions.width", message: "Width must be a finite number greater than 0." });
  }
  if (!isPositiveFinite(pillar.dimensions?.depth)) {
    errors.push({ field: "dimensions.depth", message: "Depth must be a finite number greater than 0." });
  }
  if (!isPositiveFinite(pillar.dimensions?.height)) {
    errors.push({ field: "dimensions.height", message: "Height must be a finite number greater than 0." });
  }

  if (typeof pillar.color !== "string" || !HEX_COLOR_PATTERN.test(pillar.color)) {
    errors.push({ field: "color", message: "Color must be a 6-digit hex string, e.g. #c9c9c9." });
  }

  if (!isNonEmptyString(pillar.material)) {
    errors.push({ field: "material", message: "Material must be a non-empty string." });
  }

  if (pillar.assemblyId !== null && !isNonEmptyString(pillar.assemblyId)) {
    errors.push({ field: "assemblyId", message: "assemblyId must be a non-empty string, or null." });
  }

  return { valid: errors.length === 0, errors };
}
