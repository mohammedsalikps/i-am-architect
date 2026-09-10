import type { WindowData } from "./types";

export interface WindowValidationError {
  field: string;
  message: string;
}

export interface WindowValidationResult {
  valid: boolean;
  errors: WindowValidationError[];
}

/** 6-digit hex only - #rrggbb, matching what the color-picker UI and createWindowData's defaults produce. */
const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

function isPositiveFinite(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Validates a complete WindowData object and returns a structured
 * result instead of throwing - same convention as validateDoor.ts and
 * every sibling validator. Pure function, no side effects, no
 * knowledge of WindowStore/ObjectRegistry/history - WindowStore is the
 * only intended caller (on add()/update()/set()).
 *
 * Does NOT check for duplicate ids against other stored windows -
 * that's a store-level concern (see WindowStore.add()).
 */
export function validateWindow(windowData: WindowData): WindowValidationResult {
  const errors: WindowValidationError[] = [];

  if (!isNonEmptyString(windowData.id)) {
    errors.push({ field: "id", message: "Window id must be non-empty." });
  }

  if (windowData.type !== "window") {
    errors.push({ field: "type", message: 'Window type must be "window".' });
  }

  if (!Number.isFinite(windowData.position?.x)) {
    errors.push({ field: "position.x", message: "Position X must be a finite number." });
  }
  if (!Number.isFinite(windowData.position?.y)) {
    errors.push({ field: "position.y", message: "Position Y must be a finite number." });
  }
  if (!Number.isFinite(windowData.position?.z)) {
    errors.push({ field: "position.z", message: "Position Z must be a finite number." });
  }

  if (!Number.isFinite(windowData.rotation)) {
    errors.push({ field: "rotation", message: "Rotation Y must be a finite number." });
  }

  if (!isPositiveFinite(windowData.dimensions?.width)) {
    errors.push({ field: "dimensions.width", message: "Width must be a finite number greater than 0." });
  }
  if (!isPositiveFinite(windowData.dimensions?.height)) {
    errors.push({ field: "dimensions.height", message: "Height must be a finite number greater than 0." });
  }
  if (!isPositiveFinite(windowData.dimensions?.thickness)) {
    errors.push({ field: "dimensions.thickness", message: "Thickness must be a finite number greater than 0." });
  }

  if (typeof windowData.color !== "string" || !HEX_COLOR_PATTERN.test(windowData.color)) {
    errors.push({ field: "color", message: "Color must be a 6-digit hex string, e.g. #c9c9c9." });
  }

  if (!isNonEmptyString(windowData.material)) {
    errors.push({ field: "material", message: "Material must be a non-empty string." });
  }

  if (windowData.assemblyId !== null && !isNonEmptyString(windowData.assemblyId)) {
    errors.push({ field: "assemblyId", message: "assemblyId must be a non-empty string, or null." });
  }

  // Absent is treated as null, so a window built before hosting existed still validates.
  const hostId = windowData.hostId ?? null;
  const hostPlacement = windowData.hostPlacement ?? null;
  if (hostId !== null && !isNonEmptyString(hostId)) {
    errors.push({ field: "hostId", message: "hostId must be a wall id, or null." });
  } else if (hostId === null && hostPlacement !== null) {
    errors.push({ field: "hostPlacement", message: "A free-standing window has no placement in a wall." });
  } else if (
    hostId !== null &&
    (hostPlacement === null || !Number.isFinite(hostPlacement.offset) || !Number.isFinite(hostPlacement.sill))
  ) {
    errors.push({ field: "hostPlacement", message: "A window in a wall needs a finite offset and sill in it." });
  }

  return { valid: errors.length === 0, errors };
}
