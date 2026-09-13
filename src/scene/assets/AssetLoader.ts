import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { AssetDefinition } from "../../engine/assets/catalog";

/**
 * Every .gltf file under src/assets/, resolved to its real, hashed build
 * URL by Vite at build time (`eager` + `?url` - the same mechanism a
 * hand-written `import sofaUrl from "../../assets/sofa.gltf?url"` per
 * file would give, done once for the whole directory instead of one
 * import per asset). This is what makes AssetDefinition.url (a plain
 * relative filename, e.g. "sofa.gltf") actually resolve in a PRODUCTION
 * build, not just in dev (where Vite serves src/ paths directly) - a
 * relative fetch("./sofa.gltf") would work in dev and silently 404 once
 * built, since a production build never ships raw src/ files that
 * nothing imports.
 */
const ASSET_MODULE_URLS = import.meta.glob("../../assets/*.gltf", { eager: true, query: "?url", import: "default" }) as Record<string, string>;

function resolveAssetUrl(relativeUrl: string): string {
  const match = Object.entries(ASSET_MODULE_URLS).find(([path]) => path.endsWith(`/${relativeUrl}`));
  if (!match) {
    throw new Error(`Asset file "${relativeUrl}" is not under src/assets/ - see AssetLoader.ts.`);
  }
  return match[1];
}

export interface LoadedAsset {
  /** A fresh, independently-transformable instance - safe to position/rotate/scale/dispose per placement. */
  group: THREE.Group;
  /**
   * The instance's own bounding-box size, in its local (unscaled) units -
   * the real-world reference AssetLayer divides an AssetData's
   * width/height/depth by to compute the group's actual Three.js scale
   * (see AssetLayer.ts). Computed once per definition and reused from
   * the cache, not recomputed per instance.
   */
  naturalSize: THREE.Vector3;
}

/**
 * Loads a GLB/GLTF asset's scene graph into a real, usable THREE.Group -
 * the finished version of the previous milestone's loading foundation
 * (see this file's git history / engine/assets/catalog.ts's own docs for
 * what "foundation only" used to mean). Every returned group is an
 * independent instance:
 *
 * - geometries are shared with the cached template (never disposed here -
 *   see AssetLayer.ts's disposal contract) - cheap, and safe because nothing
 *   ever mutates a geometry in place.
 * - materials are cloned per instance, so recoloring/re-texturing one
 *   placed asset (a material override - see engine/materials/
 *   surfaceAppearance.ts) never leaks onto every other instance of the
 *   same asset, or the cached template.
 *
 * Loading is asynchronous and cached by URL: placing a second sofa reuses
 * the already-loaded template instead of re-fetching/re-parsing the file.
 * A failed load (bad URL, malformed glTF) rejects - AssetLayer is
 * responsible for catching that and showing a failure state, never for
 * throwing past it.
 */
export class AssetLoader {
  private readonly loader = new GLTFLoader();
  private readonly cache = new Map<string, Promise<{ template: THREE.Group; naturalSize: THREE.Vector3 }>>();

  /** Loads (and caches) `definition`'s GLTF, returning a fresh, independently-usable clone plus its measured natural size. */
  async load(definition: AssetDefinition): Promise<LoadedAsset> {
    let pending = this.cache.get(definition.url);
    if (!pending) {
      pending = new Promise<{ template: THREE.Group; naturalSize: THREE.Vector3 }>((resolve, reject) => {
        this.loader.load(
          resolveAssetUrl(definition.url),
          (gltf) => {
            const template = gltf.scene;
            const naturalSize = new THREE.Box3().setFromObject(template).getSize(new THREE.Vector3());
            resolve({ template, naturalSize });
          },
          undefined,
          (error) => reject(error instanceof Error ? error : new Error(String(error)))
        );
      });
      this.cache.set(definition.url, pending);
    }

    const { template, naturalSize } = await pending;
    const group = template.clone(true);
    group.traverse((object) => {
      if (object instanceof THREE.Mesh) {
        object.material = Array.isArray(object.material) ? object.material.map((material) => material.clone()) : object.material.clone();
      }
    });
    return { group, naturalSize };
  }
}
