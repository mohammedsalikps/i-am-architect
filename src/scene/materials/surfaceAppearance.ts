import { getMaterial } from "../../engine/materials/materialLibrary";

/**
 * What a MeshStandardMaterial needs beyond color: how rough/metallic/
 * see-through the surface is. Shared by every mesh builder (wall, pillar,
 * beam, slab, door, window - buildElementMesh.ts has its own equivalent,
 * surfaceMaterial(), for the newer catalog elements) so "pick Concrete vs
 * Glass vs Oak" actually changes how the object looks, not just a string
 * stored on it.
 *
 * `fallback` is each type's own pre-existing hardcoded look (the same
 * numbers these builders already used before materials were wired up) -
 * used whenever the object's material is "generic" (every original
 * type's own default - see createWall.ts/createDoor.ts/.../DEFAULTS) or
 * an unrecognized/free-text id (older saved projects). That keeps every
 * object's DEFAULT appearance pixel-identical to before this change; only
 * explicitly picking a real library material (via the Materials tab or
 * Paint) changes how it renders.
 */
export interface SurfaceAppearance {
  roughness: number;
  metalness: number;
  opacity: number;
}

export function resolveSurfaceAppearance(
  materialId: string,
  fallback: { roughness: number; metalness?: number; opacity?: number }
): SurfaceAppearance {
  const library = materialId !== "generic" ? getMaterial(materialId) : undefined;
  if (!library) {
    return { roughness: fallback.roughness, metalness: fallback.metalness ?? 0, opacity: fallback.opacity ?? 1 };
  }
  return { roughness: library.roughness, metalness: library.metalness, opacity: library.opacity };
}
