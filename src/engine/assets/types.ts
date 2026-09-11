/**
 * Foundation for a future GLB/GLTF asset system (furniture, fixtures,
 * lights, appliances, architectural components) - see UI milestone
 * notes for the exact scope of this milestone.
 *
 * THIS MILESTONE DELIBERATELY STOPS HERE: an asset definition and a real
 * loader (see src/scene/assets/AssetLoader.ts) exist, but nothing wires
 * a GLB into a placeable, selectable, persistable construction object
 * yet - there is no "asset" ConstructionObjectBase, no "asset.add"
 * command, and no ribbon button for it. Adding all of that is real
 * engine/command/persistence/AI-schema surface (a new object type
 * touches CommandExecutor, ObjectRegistry, resolveConstructionObject,
 * persistence, and AI_SUPPORTED_OBJECT_TYPES) - disproportionate to,
 * and outside the scope of, a UX/interaction milestone that must not
 * rewrite the construction engine. A visible "place a GLB" control with
 * nothing real behind it would be exactly the fake/demo control this
 * milestone is required not to introduce.
 *
 * When that future milestone happens, an asset instance should follow
 * the SAME shape every other construction object already does - never
 * a Three.js mesh/Object3D as the persisted representation:
 *   - id: string (like every ConstructionObjectBase)
 *   - transform: position/rotation, meters and radians, +Y up
 *   - visibility: through VisibilityStore, exactly like every other type
 *   - selection: through the shared SelectionStore
 *   - hierarchy presence: listed in the left sidebar like any object
 *   - persistence: a plain data record (this AssetDefinition/
 *     AssetInstance shape - an asset id + transform), never a THREE.Group
 */

/** Where one asset's GLB/GLTF file lives, and what it's called and grouped under - pure data, no Three.js import here (this stays importable from anywhere src/engine/ already is, including the backend). */
export interface AssetDefinition {
  id: string;
  label: string;
  /** Reuses the same category vocabulary as elements/catalog.ts's ElementCategory, so a future ribbon tab needs no second grouping scheme. */
  category: "structure" | "openings" | "rooms" | "finish" | "plumbing" | "electrical" | "interior" | "exterior";
  description: string;
  /** Relative to src/assets/ (see AssetLoader.ts) - never an absolute filesystem path or a remote URL committed into this repository. */
  url: string;
  /** A reasonable default footprint, in meters, for placement/ghost-preview sizing - the same role ElementKindDefinition.dimensions plays for catalog elements. */
  defaultScale: { x: number; y: number; z: number };
}

/** A local, hand-authored, non-copyrighted test fixture proving the loader works end to end - not a real furniture library. See AssetLoader.ts's own docs. */
export const PLACEHOLDER_ASSET: AssetDefinition = {
  id: "placeholder-box",
  label: "Placeholder Box",
  category: "interior",
  description: "A minimal hand-authored glTF test fixture (a single unit cube) - proves the GLB/GLTF loading path works. Not a real furniture asset.",
  url: "placeholder-box.gltf",
  defaultScale: { x: 1, y: 1, z: 1 }
};
