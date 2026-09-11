/**
 * Node-runnable unit verification for the GLB/GLTF asset foundation -
 * same "no test framework, plain assertion helpers" convention as every
 * other verify.ts in this project.
 *
 * This checks only what's genuinely Node-testable without a browser:
 * PLACEHOLDER_ASSET's own data shape, and that the placeholder .gltf
 * file on disk is well-formed glTF JSON (a real, parseable asset, not a
 * stub). It does NOT exercise src/scene/assets/AssetLoader.ts's actual
 * THREE.GLTFLoader parse - that needs a browser (fetch/DOM), the same
 * reason ManipulationController/PlacementController's pointer-handling
 * layers have no Node verify.ts of their own either; see
 * engine/assets/types.ts for why this whole area stops at "loading
 * foundation" this milestone.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PLACEHOLDER_ASSET } from "./types.ts";

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

  console.log("Asset foundation verification\n");

  check("PLACEHOLDER_ASSET has a complete, non-empty definition", () => {
    assertTrue(PLACEHOLDER_ASSET.id.length > 0, "id");
    assertTrue(PLACEHOLDER_ASSET.label.length > 0, "label");
    assertTrue(PLACEHOLDER_ASSET.description.length > 0, "description");
    assertTrue(PLACEHOLDER_ASSET.url.endsWith(".gltf"), "url points at a .gltf file");
    assertTrue(!/^([a-z]+:)?\/\//i.test(PLACEHOLDER_ASSET.url) && !PLACEHOLDER_ASSET.url.startsWith("/"), "url is relative, not absolute/remote - nothing is fetched from the internet");
    for (const axis of ["x", "y", "z"] as const) {
      assertTrue(PLACEHOLDER_ASSET.defaultScale[axis] > 0, `defaultScale.${axis} is positive`);
    }
  });

  check("the placeholder .gltf file on disk is well-formed glTF 2.0 JSON with a real mesh", () => {
    const path = fileURLToPath(new URL(`../../assets/${PLACEHOLDER_ASSET.url}`, import.meta.url));
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as {
      asset?: { version?: string };
      meshes?: unknown[];
      accessors?: { count?: number }[];
      buffers?: { uri?: string }[];
    };
    assertEqual(parsed.asset?.version, "2.0", "glTF version");
    assertTrue(Array.isArray(parsed.meshes) && parsed.meshes.length > 0, "at least one mesh");
    assertTrue(Array.isArray(parsed.accessors) && parsed.accessors.length > 0, "at least one accessor");
    assertTrue((parsed.accessors?.[0]?.count ?? 0) > 0, "the position accessor has real vertices");
    assertTrue(!!parsed.buffers?.[0]?.uri?.startsWith("data:"), "the buffer is embedded (data: URI) - no separate .bin file to keep track of, and nothing fetched remotely");
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
