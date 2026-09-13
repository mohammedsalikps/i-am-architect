import type { ConstructionObjectBase, ObjectId } from "../objects/types";

export type AssetId = ObjectId;

/** A placed design asset's real-world bounding box, in meters - see AssetInstance's own docs for how this drives its Three.js scale. */
export interface AssetDimensions {
  width: number;
  height: number;
  depth: number;
}

/**
 * One placed design asset (a sofa, a bed, a lamp, ...) - an ordinary
 * ConstructionObjectBase (id, position, rotation, dimensions, material,
 * color, assemblyId) exactly like a wall or a catalog element, so every
 * generic system that already operates on that shape (selection,
 * manipulation, the Properties inspector, hierarchy, visibility,
 * persistence) needs no special case for it - see AssetStore.ts's own
 * docs for why this stays a SEPARATE store from ElementStore rather than
 * reusing it.
 *
 * `dimensions` (width/height/depth, in real meters) is deliberately in
 * the same "a real box size" units every other type's dimensions already
 * are - not a unitless Three.js scale factor. AssetLayer derives the
 * actual THREE.Group scale by dividing this by the loaded model's own
 * measured bounding box (see scene/assets/AssetLoader.ts), so dragging a
 * resize handle changes a real, meaningful size (a wider sofa, a taller
 * lamp) through the exact same manipulation math every other type uses -
 * this is what lets task section 8's "assets may use transform scaling"
 * reuse the existing resize-handle system instead of inventing a second,
 * scale-specific one.
 *
 * `assetId` names which AssetDefinition (catalog.ts) this instance is -
 * the asset equivalent of an ElementData's `kind`.
 */
export interface AssetData extends ConstructionObjectBase<"asset", AssetDimensions> {
  assetId: string;
  /** The name people see; defaults to the definition's label. */
  label: string;
}
