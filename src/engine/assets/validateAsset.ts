// Explicit .ts extensions on these value imports let Node run this file
// directly (the verify suites and the backend do). Harmless for Vite.
import { getAssetDefinition } from "./catalog.ts";
import { getMaterial } from "../materials/materialLibrary.ts";
import type { AssetData } from "./types";

export interface AssetValidationError {
  field: string;
  message: string;
}

export interface AssetValidationResult {
  valid: boolean;
  errors: AssetValidationError[];
}

const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;
const DIMENSION_KEYS = ["width", "height", "depth"] as const;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validates a complete AssetData against its catalog definition (see
 * catalog.ts) - the same "one rulebook" shape validateElement() uses for
 * elements:
 *
 * - a known assetId, a non-empty id and label, type "asset"
 * - a finite position and rotation
 * - exactly width/height/depth, each a finite positive number (an
 *   asset's box, in real meters - see types.ts's own docs)
 * - a material from the material library, a #rrggbb color
 *
 * Pure: returns a structured result instead of throwing, like every
 * other validator. AssetStore is the intended caller.
 */
export function validateAsset(asset: AssetData): AssetValidationResult {
  const errors: AssetValidationError[] = [];

  if (!isNonEmptyString(asset.id)) {
    errors.push({ field: "id", message: "Asset id must be non-empty." });
  }
  if (asset.type !== "asset") {
    errors.push({ field: "type", message: 'Asset type must be "asset".' });
  }

  const definition = getAssetDefinition(asset.assetId);
  if (!definition) {
    errors.push({ field: "assetId", message: `"${String(asset.assetId)}" is not a known asset.` });
  }

  if (!isNonEmptyString(asset.label)) {
    errors.push({ field: "label", message: "Name must be a non-empty string." });
  }

  for (const axis of ["x", "y", "z"] as const) {
    if (!Number.isFinite(asset.position?.[axis])) {
      errors.push({ field: `position.${axis}`, message: `Position ${axis.toUpperCase()} must be a finite number.` });
    }
  }
  if (!Number.isFinite(asset.rotation)) {
    errors.push({ field: "rotation", message: "Rotation Y must be a finite number." });
  }

  if (!isPlainObject(asset.dimensions)) {
    errors.push({ field: "dimensions", message: "Dimensions must be an object." });
  } else {
    for (const key of Object.keys(asset.dimensions)) {
      if (!(DIMENSION_KEYS as readonly string[]).includes(key)) {
        errors.push({ field: `dimensions.${key}`, message: `An asset has no "${key}" dimension.` });
      }
    }
    for (const key of DIMENSION_KEYS) {
      const value = asset.dimensions[key];
      if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
        errors.push({ field: `dimensions.${key}`, message: `${key[0].toUpperCase()}${key.slice(1)} must be a finite number greater than 0.` });
      }
    }
  }

  if (!isNonEmptyString(asset.material)) {
    errors.push({ field: "material", message: "Material must be a non-empty string." });
  } else if (!getMaterial(asset.material)) {
    errors.push({ field: "material", message: `"${asset.material}" is not a material in the library.` });
  }

  if (typeof asset.color !== "string" || !HEX_COLOR_PATTERN.test(asset.color)) {
    errors.push({ field: "color", message: "Color must be a 6-digit hex string, e.g. #c9c9c9." });
  }

  if (asset.assemblyId !== null && !isNonEmptyString(asset.assemblyId)) {
    errors.push({ field: "assemblyId", message: "assemblyId must be a non-empty string, or null." });
  }

  return { valid: errors.length === 0, errors };
}
