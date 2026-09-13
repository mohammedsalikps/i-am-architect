/**
 * Node-runnable unit verification for the design-asset catalog - same
 * "no test framework, plain assertion helpers" convention as every other
 * verify.ts in this project.
 *
 * This checks only what's genuinely Node-testable without a browser:
 * ASSET_DEFINITIONS' own data shape (every entry complete, every
 * material a real library id, every url relative), that every asset's
 * .gltf file on disk is well-formed glTF JSON with a real mesh, and the
 * catalog's lookup/search helpers. It does NOT exercise
 * src/scene/assets/AssetLoader.ts's actual THREE.GLTFLoader parse or
 * AssetLayer's scene wiring - those need a browser (fetch/DOM/WebGL),
 * verified instead by hand in the running app (see the milestone report).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ASSET_CATEGORIES, ASSET_DEFINITIONS, assetDefinitionsIn, getAssetDefinition, searchAssetDefinitions } from "./catalog.ts";
import { getMaterial } from "../materials/materialLibrary.ts";

function assertTrue(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;
const CATEGORY_IDS = new Set(ASSET_CATEGORIES.map((entry) => entry.id));

async function run(): Promise<void> {
  let passed = 0;
  let failed = 0;

  function check(name: string, fn: () => void): void {
    try {
      fn();
      passed += 1;
      console.log(`  ok - ${name}`);
    } catch (error) {
      failed += 1;
      console.error(`  FAIL - ${name}`);
      console.error(error);
    }
  }

  console.log("Asset catalog verification\n");

  check("the catalog is non-empty and every definition is complete", () => {
    assertTrue(ASSET_DEFINITIONS.length > 0, "at least one asset");
    const ids = new Set<string>();
    for (const definition of ASSET_DEFINITIONS) {
      assertTrue(definition.id.length > 0, `${definition.id}: id`);
      assertTrue(!ids.has(definition.id), `${definition.id}: id is unique`);
      ids.add(definition.id);
      assertTrue(definition.label.length > 0, `${definition.id}: label`);
      assertTrue(CATEGORY_IDS.has(definition.category), `${definition.id}: category "${definition.category}" is a real category`);
      assertTrue(definition.description.length > 0, `${definition.id}: description`);
      assertTrue(definition.url.endsWith(".gltf"), `${definition.id}: url points at a .gltf file`);
      assertTrue(
        !/^([a-z]+:)?\/\//i.test(definition.url) && !definition.url.startsWith("/"),
        `${definition.id}: url is relative, not absolute/remote - nothing is fetched from the internet`
      );
      for (const axis of ["width", "height", "depth"] as const) {
        assertTrue(Number.isFinite(definition.defaultDimensions[axis]) && definition.defaultDimensions[axis] > 0, `${definition.id}: defaultDimensions.${axis} is a positive number`);
      }
      assertTrue(!!getMaterial(definition.defaultMaterial), `${definition.id}: defaultMaterial "${definition.defaultMaterial}" is a real material library id`);
      assertTrue(HEX_COLOR_PATTERN.test(definition.defaultColor), `${definition.id}: defaultColor is a 6-digit hex string`);
      assertTrue(definition.keywords.length > 0, `${definition.id}: at least one keyword`);
      assertTrue(definition.version >= 1, `${definition.id}: version`);
    }
  });

  check("every asset's .gltf file on disk is well-formed glTF 2.0 JSON with a real mesh, and its measured box matches its catalog defaultDimensions", () => {
    interface GltfNode {
      mesh?: number;
      matrix?: number[];
      translation?: number[];
      children?: number[];
    }
    interface GltfDocument {
      asset?: { version?: string };
      scene?: number;
      scenes?: { nodes: number[] }[];
      nodes?: GltfNode[];
      meshes?: { primitives: { attributes: Record<string, number> }[] }[];
      accessors?: { min?: number[]; max?: number[] }[];
      buffers?: { uri?: string }[];
    }

    /**
     * This project's own generator (scripts/generate-asset-models.mjs)
     * only ever emits pure translation+diagonal-scale node matrices (no
     * rotation - no mesh ever has one) - confirmed against the raw node
     * dump for both a translation-only asset (sofa) and a scaled one
     * (plant's canopy, scaled on Y to give it a rounder canopy). A
     * column-major TRS-only 4x4 matrix's diagonal is the scale and its
     * last row (indices 12-14) is the translation.
     */
    function transformOf(node: GltfNode): { scale: [number, number, number]; translation: [number, number, number] } {
      if (node.matrix) {
        const m = node.matrix;
        return { scale: [m[0], m[5], m[10]], translation: [m[12], m[13], m[14]] };
      }
      return { scale: [1, 1, 1], translation: node.translation ? [node.translation[0], node.translation[1], node.translation[2]] : [0, 0, 0] };
    }

    /** The world-space AABB of every mesh reachable from `nodeIndex`, composing each ancestor's own scale and translation (see transformOf). */
    function collectBounds(
      doc: GltfDocument,
      nodeIndex: number,
      parentScale: [number, number, number],
      parentTranslation: [number, number, number],
      min: number[],
      max: number[]
    ): void {
      const node = doc.nodes![nodeIndex];
      const local = transformOf(node);
      const scale: [number, number, number] = [parentScale[0] * local.scale[0], parentScale[1] * local.scale[1], parentScale[2] * local.scale[2]];
      const translation: [number, number, number] = [
        parentTranslation[0] + parentScale[0] * local.translation[0],
        parentTranslation[1] + parentScale[1] * local.translation[1],
        parentTranslation[2] + parentScale[2] * local.translation[2]
      ];

      if (node.mesh !== undefined) {
        for (const primitive of doc.meshes![node.mesh].primitives) {
          const accessor = doc.accessors![primitive.attributes.POSITION];
          if (accessor?.min && accessor?.max) {
            for (let axis = 0; axis < 3; axis += 1) {
              // scale can flip which of min/max is smaller if it were ever negative - not the case for this generator, but take both orderings to be safe.
              const a = accessor.min[axis] * scale[axis] + translation[axis];
              const b = accessor.max[axis] * scale[axis] + translation[axis];
              min[axis] = Math.min(min[axis], a, b);
              max[axis] = Math.max(max[axis], a, b);
            }
          }
        }
      }
      for (const child of node.children ?? []) {
        collectBounds(doc, child, scale, translation, min, max);
      }
    }

    for (const definition of ASSET_DEFINITIONS) {
      const path = fileURLToPath(new URL(`../../assets/${definition.url}`, import.meta.url));
      const raw = readFileSync(path, "utf8");
      const parsed = JSON.parse(raw) as GltfDocument;
      assertEqual(parsed.asset?.version, "2.0", `${definition.id}: glTF version`);
      assertTrue(Array.isArray(parsed.meshes) && parsed.meshes.length > 0, `${definition.id}: at least one mesh`);
      assertTrue(Array.isArray(parsed.accessors) && parsed.accessors.length > 0, `${definition.id}: at least one accessor`);
      assertTrue(!!parsed.buffers?.[0]?.uri?.startsWith("data:"), `${definition.id}: the buffer is embedded (data: URI) - nothing fetched remotely`);

      // Walks the node graph (translation only - see collectBounds's own
      // note) composing every mesh's own POSITION accessor bounds into
      // the model's real assembled bounding box - what
      // THREE.Box3().setFromObject() would derive in the browser (see
      // AssetLoader.ts) - so this confirms the catalog's hand-copied
      // defaultDimensions actually matches the file, not just that both
      // look plausible.
      const min = [Infinity, Infinity, Infinity];
      const max = [-Infinity, -Infinity, -Infinity];
      for (const rootIndex of parsed.scenes![parsed.scene ?? 0].nodes) {
        collectBounds(parsed, rootIndex, [1, 1, 1], [0, 0, 0], min, max);
      }
      assertTrue(Number.isFinite(min[0]), `${definition.id}: at least one mesh contributed to the bounding box`);
      const measured = { width: max[0] - min[0], height: max[1] - min[1], depth: max[2] - min[2] };
      const tolerance = 0.005;
      for (const axis of ["width", "height", "depth"] as const) {
        assertTrue(
          Math.abs(measured[axis] - definition.defaultDimensions[axis]) < tolerance,
          `${definition.id}: catalog defaultDimensions.${axis} (${definition.defaultDimensions[axis]}) matches the file's measured ${axis} (${measured[axis].toFixed(3)})`
        );
      }
    }
  });

  check("getAssetDefinition finds a known id and returns undefined for an unknown one", () => {
    const first = ASSET_DEFINITIONS[0];
    assertEqual(getAssetDefinition(first.id)?.id, first.id, "known id");
    assertEqual(getAssetDefinition("not-a-real-asset"), undefined, "unknown id");
  });

  check("assetDefinitionsIn filters by category, and the deliberately-empty category returns nothing", () => {
    const living = assetDefinitionsIn("living");
    assertTrue(living.length > 0, "living has entries");
    assertTrue(living.every((entry) => entry.category === "living"), "every entry is actually living");
    assertEqual(assetDefinitionsIn("outdoor").length, 0, "outdoor is deliberately empty - exercises the real empty state, not a fake one");
    assertEqual(assetDefinitionsIn().length, ASSET_DEFINITIONS.length, "no category given returns everything");
  });

  check("searchAssetDefinitions matches by label, category and keyword, case-insensitively", () => {
    assertTrue(
      searchAssetDefinitions("Sofa").some((entry) => entry.id === "sofa"),
      "matches by label, case-insensitively"
    );
    assertTrue(
      searchAssetDefinitions("couch").some((entry) => entry.id === "sofa"),
      "matches by keyword"
    );
    assertTrue(
      searchAssetDefinitions("bedroom").length >= 3,
      "matches by category/keyword across several assets"
    );
    assertEqual(searchAssetDefinitions("not-a-real-search-term").length, 0, "no match returns nothing");
    assertEqual(searchAssetDefinitions("   ").length, ASSET_DEFINITIONS.length, "blank query returns everything");
  });

  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) {
    throw new Error(`${failed} verification check(s) failed`);
  }
}

run().catch((error) => {
  console.error(error);
  throw error;
});
