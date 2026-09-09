import type { WallData } from "./types";

export interface WallValidationError {
  field: string;
  message: string;
}

export interface WallValidationResult {
  valid: boolean;
  errors: WallValidationError[];
}

/** 6-digit hex only - #rrggbb, matching what the color-picker UI and createWallData's defaults produce. */
const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

function isPositiveFinite(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

/**
 * Validates a complete WallData object and returns a structured result
 * instead of throwing - typing 0 into the Thickness field is normal
 * user input, not an exceptional program state. Pure function, no side
 * effects, no knowledge of WallStore/ObjectRegistry/history - WallStore
 * is the only intended caller (on add()/update()/set()). See
 * src/engine/wall/README.md for the full constraint list and what
 * happens when validation fails.
 */
export function validateWall(wall: WallData): WallValidationResult {
  const errors: WallValidationError[] = [];

  if (!wall.id || wall.id.trim().length === 0) {
    errors.push({ field: "id", message: "Wall id must be non-empty." });
  }

  if (wall.type !== "wall") {
    errors.push({ field: "type", message: 'Wall type must be "wall".' });
  }

  if (!Number.isFinite(wall.position?.x)) {
    errors.push({ field: "position.x", message: "Position X must be a finite number." });
  }
  if (!Number.isFinite(wall.position?.y)) {
    errors.push({ field: "position.y", message: "Position Y must be a finite number." });
  }
  if (!Number.isFinite(wall.position?.z)) {
    errors.push({ field: "position.z", message: "Position Z must be a finite number." });
  }

  if (!Number.isFinite(wall.rotation)) {
    errors.push({ field: "rotation", message: "Rotation Y must be a finite number." });
  }

  if (!isPositiveFinite(wall.dimensions?.length)) {
    errors.push({ field: "dimensions.length", message: "Length must be a finite number greater than 0." });
  }
  if (!isPositiveFinite(wall.dimensions?.height)) {
    errors.push({ field: "dimensions.height", message: "Height must be a finite number greater than 0." });
  }
  if (!isPositiveFinite(wall.dimensions?.thickness)) {
    errors.push({ field: "dimensions.thickness", message: "Thickness must be a finite number greater than 0." });
  }

  if (typeof wall.color !== "string" || !HEX_COLOR_PATTERN.test(wall.color)) {
    errors.push({ field: "color", message: "Color must be a 6-digit hex string, e.g. #c9c9c9." });
  }

  return { valid: errors.length === 0, errors };
}
