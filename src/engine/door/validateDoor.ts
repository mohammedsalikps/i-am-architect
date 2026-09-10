import type { DoorData } from "./types";

export interface DoorValidationError {
  field: string;
  message: string;
}

export interface DoorValidationResult {
  valid: boolean;
  errors: DoorValidationError[];
}

/** 6-digit hex only - #rrggbb, matching what the color-picker UI and createDoorData's defaults produce. */
const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

function isPositiveFinite(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Validates a complete DoorData object and returns a structured result
 * instead of throwing - same convention as validateWall.ts/
 * validatePillar.ts/validateBeam.ts/validateSlab.ts. Pure function, no
 * side effects, no knowledge of DoorStore/ObjectRegistry/history -
 * DoorStore is the only intended caller (on add()/update()/set()).
 *
 * Does NOT check for duplicate ids against other stored doors - that's
 * a store-level concern (see DoorStore.add()).
 */
export function validateDoor(door: DoorData): DoorValidationResult {
  const errors: DoorValidationError[] = [];

  if (!isNonEmptyString(door.id)) {
    errors.push({ field: "id", message: "Door id must be non-empty." });
  }

  if (door.type !== "door") {
    errors.push({ field: "type", message: 'Door type must be "door".' });
  }

  if (!Number.isFinite(door.position?.x)) {
    errors.push({ field: "position.x", message: "Position X must be a finite number." });
  }
  if (!Number.isFinite(door.position?.y)) {
    errors.push({ field: "position.y", message: "Position Y must be a finite number." });
  }
  if (!Number.isFinite(door.position?.z)) {
    errors.push({ field: "position.z", message: "Position Z must be a finite number." });
  }

  if (!Number.isFinite(door.rotation)) {
    errors.push({ field: "rotation", message: "Rotation Y must be a finite number." });
  }

  if (!isPositiveFinite(door.dimensions?.width)) {
    errors.push({ field: "dimensions.width", message: "Width must be a finite number greater than 0." });
  }
  if (!isPositiveFinite(door.dimensions?.height)) {
    errors.push({ field: "dimensions.height", message: "Height must be a finite number greater than 0." });
  }
  if (!isPositiveFinite(door.dimensions?.thickness)) {
    errors.push({ field: "dimensions.thickness", message: "Thickness must be a finite number greater than 0." });
  }

  if (typeof door.color !== "string" || !HEX_COLOR_PATTERN.test(door.color)) {
    errors.push({ field: "color", message: "Color must be a 6-digit hex string, e.g. #c9c9c9." });
  }

  if (!isNonEmptyString(door.material)) {
    errors.push({ field: "material", message: "Material must be a non-empty string." });
  }

  if (door.assemblyId !== null && !isNonEmptyString(door.assemblyId)) {
    errors.push({ field: "assemblyId", message: "assemblyId must be a non-empty string, or null." });
  }

  // Absent is treated as null, so a door built before hosting existed still validates.
  const hostId = door.hostId ?? null;
  const hostPlacement = door.hostPlacement ?? null;
  if (hostId !== null && !isNonEmptyString(hostId)) {
    errors.push({ field: "hostId", message: "hostId must be a wall id, or null." });
  } else if (hostId === null && hostPlacement !== null) {
    errors.push({ field: "hostPlacement", message: "A free-standing door has no placement in a wall." });
  } else if (
    hostId !== null &&
    (hostPlacement === null || !Number.isFinite(hostPlacement.offset) || !Number.isFinite(hostPlacement.sill))
  ) {
    errors.push({ field: "hostPlacement", message: "A door in a wall needs a finite offset and sill in it." });
  }

  return { valid: errors.length === 0, errors };
}
