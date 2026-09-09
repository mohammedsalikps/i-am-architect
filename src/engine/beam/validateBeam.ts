import type { BeamData } from "./types";

export interface BeamValidationError {
  field: string;
  message: string;
}

export interface BeamValidationResult {
  valid: boolean;
  errors: BeamValidationError[];
}

/** 6-digit hex only - #rrggbb, matching what the color-picker UI and createBeamData's defaults produce. */
const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

function isPositiveFinite(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Validates a complete BeamData object and returns a structured result
 * instead of throwing - same convention as validateWall.ts/
 * validatePillar.ts. Pure function, no side effects, no knowledge of
 * BeamStore/ObjectRegistry/history - BeamStore is the only intended
 * caller (on add()/update()/set()).
 *
 * Does NOT check for duplicate ids against other stored beams - that's
 * a store-level concern (see BeamStore.add()).
 */
export function validateBeam(beam: BeamData): BeamValidationResult {
  const errors: BeamValidationError[] = [];

  if (!isNonEmptyString(beam.id)) {
    errors.push({ field: "id", message: "Beam id must be non-empty." });
  }

  if (beam.type !== "beam") {
    errors.push({ field: "type", message: 'Beam type must be "beam".' });
  }

  if (!Number.isFinite(beam.position?.x)) {
    errors.push({ field: "position.x", message: "Position X must be a finite number." });
  }
  if (!Number.isFinite(beam.position?.y)) {
    errors.push({ field: "position.y", message: "Position Y must be a finite number." });
  }
  if (!Number.isFinite(beam.position?.z)) {
    errors.push({ field: "position.z", message: "Position Z must be a finite number." });
  }

  if (!Number.isFinite(beam.rotation)) {
    errors.push({ field: "rotation", message: "Rotation Y must be a finite number." });
  }

  if (!isPositiveFinite(beam.dimensions?.length)) {
    errors.push({ field: "dimensions.length", message: "Length must be a finite number greater than 0." });
  }
  if (!isPositiveFinite(beam.dimensions?.width)) {
    errors.push({ field: "dimensions.width", message: "Width must be a finite number greater than 0." });
  }
  if (!isPositiveFinite(beam.dimensions?.height)) {
    errors.push({ field: "dimensions.height", message: "Height must be a finite number greater than 0." });
  }

  if (typeof beam.color !== "string" || !HEX_COLOR_PATTERN.test(beam.color)) {
    errors.push({ field: "color", message: "Color must be a 6-digit hex string, e.g. #c9c9c9." });
  }

  if (!isNonEmptyString(beam.material)) {
    errors.push({ field: "material", message: "Material must be a non-empty string." });
  }

  if (beam.assemblyId !== null && !isNonEmptyString(beam.assemblyId)) {
    errors.push({ field: "assemblyId", message: "assemblyId must be a non-empty string, or null." });
  }

  return { valid: errors.length === 0, errors };
}
