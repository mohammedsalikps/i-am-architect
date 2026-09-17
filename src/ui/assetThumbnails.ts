import type { AssetDefinition } from "../engine/assets/catalog";

/**
 * Every .png under src/assets/thumbnails/, resolved to its real, hashed
 * build URL by Vite at build time - the exact same `import.meta.glob`
 * technique scene/assets/AssetLoader.ts already uses for the .gltf files
 * themselves (see that file's own docs for why a plain relative path
 * would 404 once built). Kept as its own small module rather than folded
 * into AssetLoader.ts: this is a DOM/`<img>` concern for the library
 * panel, not a THREE.js loading concern, and the two glob sets (models,
 * thumbnails) are independent - a thumbnail can be missing while its
 * model still loads fine, and vice versa.
 */
const THUMBNAIL_MODULE_URLS = import.meta.glob("../assets/thumbnails/*.png", { eager: true, query: "?url", import: "default" }) as Record<string, string>;

/**
 * `definition`'s real rendered thumbnail, or null when none exists yet -
 * never throws, unlike AssetLoader's resolveAssetUrl(): a missing .gltf
 * is a real error, but a missing thumbnail is the expected, gracefully
 * handled case for an asset that hasn't been rendered yet (see
 * assetLibrary.ts's icon fallback).
 *
 * Resolution is convention-first: `thumbnailUrl` on the definition wins
 * when set (the rare override - see catalog.ts's own docs), otherwise
 * "<id>.png" is derived the same way `url` already names "<id>.gltf" -
 * so a normal new asset needs no thumbnail bookkeeping in the catalog at
 * all, and the file on disk can never drift from what the id already says.
 */
export function resolveAssetThumbnailUrl(definition: AssetDefinition): string | null {
  const relativeUrl = definition.thumbnailUrl ?? `${definition.id}.png`;
  const match = Object.entries(THUMBNAIL_MODULE_URLS).find(([path]) => path.endsWith(`/${relativeUrl}`));
  return match ? match[1] : null;
}
