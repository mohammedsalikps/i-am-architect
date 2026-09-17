import * as THREE from "three";
import type { AssetData } from "../../engine/assets/types";
import { resolveSurfaceAppearance } from "../materials/surfaceAppearance";
import { OUTLINE_COLOR, OUTLINE_SCALE } from "../selectionOutline";
import type { AssetLoader, LoadedAsset } from "./AssetLoader";

export interface AssetVisual {
  group: THREE.Group;
  /** The pickable meshes - empty while a placeholder is showing (see buildPlaceholderVisual). */
  meshes: THREE.Mesh[];
  outline: THREE.LineSegments;
  /** Whether `group`'s own geometries are privately owned (a placeholder box - dispose them) or shared with AssetLoader's cached template (a real loaded model - never dispose them; see disposeAssetVisual's own docs). */
  ownsGeometry: boolean;
}

/** Everything that decides how a placed asset looks apart from where it is - when it changes, the visual is rebuilt. */
export function assetAppearanceKey(asset: AssetData): string {
  return JSON.stringify([asset.assetId, asset.dimensions, asset.material, asset.color]);
}

export function applyAssetTransform(group: THREE.Group, asset: AssetData): void {
  group.position.set(asset.position.x, asset.position.y, asset.position.z);
  group.rotation.y = asset.rotation;
}

function buildOutline(asset: AssetData): THREE.LineSegments {
  const volume = new THREE.BoxGeometry(asset.dimensions.width, asset.dimensions.height, asset.dimensions.depth);
  const outline = new THREE.LineSegments(new THREE.EdgesGeometry(volume), new THREE.LineBasicMaterial({ color: OUTLINE_COLOR }));
  volume.dispose();
  outline.scale.setScalar(OUTLINE_SCALE);
  outline.visible = false;
  return outline;
}

/**
 * A translucent box the size of the asset's own real-world dimensions -
 * shown while its real model is loading, or in its place if loading
 * fails (task section 6/20: a real loading state and a real failure
 * state, not a silent gap). Blue while loading, red (and wireframe) on
 * failure, so the two are visually distinguishable at a glance. Not
 * pickable while loading (meshes: []) - nothing to select until there's
 * something real there; a failed placeholder IS pickable, so a failed
 * asset can still be selected, inspected, and deleted.
 */
export function buildPlaceholderVisual(asset: AssetData, state: "loading" | "failed"): AssetVisual {
  const group = new THREE.Group();
  group.userData.objectId = asset.id;
  const geometry = new THREE.BoxGeometry(
    Math.max(asset.dimensions.width, 0.05),
    Math.max(asset.dimensions.height, 0.05),
    Math.max(asset.dimensions.depth, 0.05)
  );
  const material = new THREE.MeshStandardMaterial({
    color: state === "loading" ? 0x4f8ef7 : 0xe5746b,
    roughness: 0.9,
    transparent: true,
    opacity: state === "loading" ? 0.35 : 0.5,
    wireframe: state === "failed"
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.userData.objectId = asset.id;
  group.add(mesh);

  const outline = buildOutline(asset);
  group.add(outline);
  applyAssetTransform(group, asset);

  return { group, meshes: state === "failed" ? [mesh] : [], outline, ownsGeometry: true };
}

/**
 * The asset's real loaded model, scaled so its measured natural size
 * becomes the instance's own real-world dimensions (see AssetData's own
 * docs for why `dimensions` is in meters, not a unitless scale factor),
 * with the material override applied to its primary surface.
 *
 * "Primary surface" is a real, documented simplification: by this
 * project's own authoring convention (scripts/generate-asset-models.mjs),
 * the first mesh every asset's build*() function adds is its main
 * surface (a sofa's base, a table's top, ...). Mutating meshes[0]'s
 * material in place also recolors every other mesh that originally
 * shared that same material - AssetLoader.load() clones per original
 * material reference, not per mesh, precisely so this reaches a sofa's
 * backrest/armrests or a dining chair's legs along with its seat.
 * Secondary parts with a genuinely different original material (a
 * mattress, a counter's sink, a lamp's shade) keep their own authored
 * color regardless of the object's material/color - the same "main
 * surface only" precedent buildElementMesh.ts's surfaceMaterial() already
 * set for catalog elements' own secondary parts (WOOD/LINEN/BARK
 * constants). A future milestone could tag every part explicitly (glTF
 * extras round-trip through GLTFLoader as userData) rather than relying
 * on mesh order/material identity, if genuinely independent per-part
 * overrides are ever needed.
 */
export async function buildLoadedVisual(asset: AssetData, loader: AssetLoader, definition: Parameters<AssetLoader["load"]>[0]): Promise<AssetVisual> {
  const loaded: LoadedAsset = await loader.load(definition);
  const { group, naturalSize } = loaded;

  const safeScale = (target: number, natural: number): number => (natural > 1e-6 ? target / natural : 1);
  group.scale.set(
    safeScale(asset.dimensions.width, naturalSize.x),
    safeScale(asset.dimensions.height, naturalSize.y),
    safeScale(asset.dimensions.depth, naturalSize.z)
  );

  const meshes: THREE.Mesh[] = [];
  group.traverse((object) => {
    if (object instanceof THREE.Mesh) {
      object.userData.objectId = asset.id;
      object.castShadow = true;
      object.receiveShadow = true;
      meshes.push(object);
    }
  });

  const primary = meshes[0]?.material;
  if (primary instanceof THREE.MeshStandardMaterial) {
    const appearance = resolveSurfaceAppearance(asset.material, { roughness: primary.roughness, metalness: primary.metalness });
    primary.color.set(asset.color);
    primary.roughness = appearance.roughness;
    primary.metalness = appearance.metalness;
    primary.opacity = appearance.opacity;
    primary.transparent = appearance.opacity < 1;
    primary.depthWrite = appearance.opacity >= 1;
  }

  const outline = buildOutline(asset);
  group.add(outline);
  applyAssetTransform(group, asset);

  return { group, meshes, outline, ownsGeometry: false };
}

/** Disposes a visual's own resources - never a loaded model's shared geometry (see AssetVisual.ownsGeometry), only its per-instance cloned materials (see AssetLoader.load()) and the outline, which is always privately owned. */
export function disposeAssetVisual(visual: AssetVisual): void {
  visual.group.traverse((object) => {
    if (object instanceof THREE.Mesh || object instanceof THREE.LineSegments) {
      if (visual.ownsGeometry || object === visual.outline) {
        object.geometry.dispose();
      }
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) {
        material.dispose();
      }
    }
  });
}
