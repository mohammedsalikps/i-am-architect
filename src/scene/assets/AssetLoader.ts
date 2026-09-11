import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { AssetDefinition } from "../../engine/assets/types";

/**
 * Loads a GLB/GLTF asset's scene graph into a real, cached THREE.Group -
 * the foundation piece of the future asset system (see
 * engine/assets/types.ts for the full scope note: this loader is real,
 * functional Three.js code, but nothing in the running app calls it yet -
 * no ribbon button, no placement tool, no construction-object type. It
 * exists so a future milestone that DOES wire assets into the
 * command/persistence system has a real loading layer to build on,
 * rather than starting from nothing.
 *
 * Every returned group is cloned before use (`SkeletonUtils`-free plain
 * clone, sufficient for the static, non-skinned placeholder asset this
 * milestone ships) so multiple placements of the same asset never share
 * (and accidentally mutate) one Object3D.
 */
export class AssetLoader {
  private readonly loader = new GLTFLoader();
  private readonly cache = new Map<string, Promise<THREE.Group>>();

  /** `baseUrl` is where asset files are served from - src/assets/ via Vite's default static-asset handling in the running app. */
  constructor(private readonly baseUrl: string) {}

  /** Loads (and caches) `definition`'s GLTF, returning a fresh clone of its scene graph, scaled to `defaultScale`. */
  async load(definition: AssetDefinition): Promise<THREE.Group> {
    let pending = this.cache.get(definition.url);
    if (!pending) {
      pending = new Promise<THREE.Group>((resolve, reject) => {
        this.loader.load(
          `${this.baseUrl}${definition.url}`,
          (gltf) => resolve(gltf.scene),
          undefined,
          (error) => reject(error instanceof Error ? error : new Error(String(error)))
        );
      });
      this.cache.set(definition.url, pending);
    }
    const original = await pending;
    const clone = original.clone(true);
    clone.scale.set(definition.defaultScale.x, definition.defaultScale.y, definition.defaultScale.z);
    return clone;
  }
}
