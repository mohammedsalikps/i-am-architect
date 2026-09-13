/**
 * Unit verification for analyzeConstructionGeometry(). Same approach as
 * every other verify.ts in this project: no test framework, plain
 * assertion helpers, run directly by Node. Run with:
 *   npm run verify
 * or directly:
 *   node src/engine/ai/geometry/verify.ts
 *
 * Every snapshot here is hand-built plain data, and every expected box
 * and distance is worked out by hand from the dimensions and positions
 * given. The per-type dimension semantics aren't just asserted: they are
 * read out of the real mesh builders (src/scene/<type>/build<Type>Mesh.ts)
 * and validators, so this suite fails if the analyzer ever disagrees with
 * how an object is actually drawn or validated. The real-store path
 * (ProjectContext -> stores -> snapshot -> analysis) is covered in
 * ../e2e/verify.ts.
 *
 * Explicit .ts extensions below are required for Node's native
 * TypeScript support to resolve these relative imports (see
 * allowImportingTsExtensions in tsconfig.json).
 */
// "node:fs"/"node:url" below are typed by src/node-builtins.d.ts, a
// minimal shared ambient shim - see that file for why it exists instead
// of an @types/node dependency.
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { analyzeConstructionGeometry, ASSET_AXES, GEOMETRY_DECIMALS, LOCAL_AXIS_DIMENSIONS, localAxesFor } from "./analyzeConstructionGeometry.ts";
import { ELEMENT_KINDS } from "../../elements/catalog.ts";
import type { ConstructionGeometryAnalysis, DirectionalRelation, GeometryError, ObjectGeometry } from "./types.ts";
import { AI_SUPPORTED_OBJECT_TYPES, compareIds } from "../types.ts";
import type { AIContextObject, AIProjectSnapshot } from "../types.ts";
import type { ObjectType } from "../../objects/types.ts";
import { createWallData } from "../../wall/createWall.ts";
import { validateWall } from "../../wall/validateWall.ts";
import { createPillarData } from "../../pillar/createPillar.ts";
import { validatePillar } from "../../pillar/validatePillar.ts";
import { createBeamData } from "../../beam/createBeam.ts";
import { validateBeam } from "../../beam/validateBeam.ts";
import { createSlabData } from "../../slab/createSlab.ts";
import { validateSlab } from "../../slab/validateSlab.ts";
import { createDoorData } from "../../door/createDoor.ts";
import { validateDoor } from "../../door/validateDoor.ts";
import { createWindowData } from "../../window/createWindow.ts";
import { validateWindow } from "../../window/validateWindow.ts";

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

function assertSameJson(actual: unknown, expected: unknown, message: string): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`${message}: expected ${expectedJson}, got ${actualJson}`);
  }
}

function assertClose(actual: number, expected: number, message: string, tolerance = 1e-9): void {
  if (!(Math.abs(actual - expected) <= tolerance)) {
    throw new Error(`${message}: expected ${expected} (within ${tolerance}), got ${actual}`);
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

type Vector = { x: number; y: number; z: number };

function makeObject(id: string, type: ObjectType, dimensions: Record<string, number>, position: Vector, rotation = 0): AIContextObject {
  return {
    id,
    type,
    position: { ...position },
    rotation,
    dimensions: { ...dimensions },
    material: "generic",
    color: "#c9c9c9",
    assemblyIds: []
  };
}

const WALL_DIMENSIONS = { height: 2.7, length: 4, thickness: 0.2 };
const PILLAR_DIMENSIONS = { depth: 0.4, height: 2.7, width: 0.4 };

function wall(id: string, position: Vector, rotation = 0, dimensions: Record<string, number> = WALL_DIMENSIONS): AIContextObject {
  return makeObject(id, "wall", dimensions, position, rotation);
}

function makeSnapshot(objects: AIContextObject[]): AIProjectSnapshot {
  const count = (type: ObjectType): number => objects.filter((object) => object.type === type).length;
  return {
    wallCount: count("wall"),
    pillarCount: count("pillar"),
    beamCount: count("beam"),
    slabCount: count("slab"),
    doorCount: count("door"),
    windowCount: count("window"),
    assemblyCount: 0,
    selectedObjectId: null,
    objects,
    assemblies: []
  };
}

function analyze(objects: AIContextObject[]): ConstructionGeometryAnalysis {
  return analyzeConstructionGeometry(makeSnapshot(objects));
}

function geometryOf(analysis: ConstructionGeometryAnalysis, id: string): ObjectGeometry {
  const found = analysis.objects.find((object) => object.id === id);
  assertTrue(found, `no geometry for ${id}`);
  return found;
}

const NO_RELATION: DirectionalRelation = { leftOf: false, rightOf: false, inFrontOf: false, behind: false, above: false, below: false };

function relation(flags: Partial<DirectionalRelation>): DirectionalRelation {
  return { ...NO_RELATION, ...flags };
}

/** The pair's relationship, plus `first`'s directional facts relative to `second` (mirrored if the analysis stored the pair the other way round). */
function relationBetween(analysis: ConstructionGeometryAnalysis, first: string, second: string) {
  const pair = analysis.relationships.find(
    (relationship) => (relationship.a === first && relationship.b === second) || (relationship.a === second && relationship.b === first)
  );
  assertTrue(pair, `no relationship between ${first} and ${second}`);
  const r = pair.aRelativeToB;
  const firstRelativeToSecond =
    pair.a === first
      ? r
      : { leftOf: r.rightOf, rightOf: r.leftOf, inFrontOf: r.behind, behind: r.inFrontOf, above: r.below, below: r.above };
  return { pair, firstRelativeToSecond };
}

/** Every value is a finite, non-negative-zero number, a string, a boolean, an array, or a plain object - nothing else. */
function assertPlainJson(value: unknown, path: string): void {
  if (typeof value === "number") {
    assertTrue(Number.isFinite(value) && !Object.is(value, -0), `${path} must be a finite number and not -0, got ${value}`);
    return;
  }
  if (typeof value === "string" || typeof value === "boolean") {
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertPlainJson(item, `${path}[${index}]`));
    return;
  }
  assertTrue(
    typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype,
    `${path} must be a plain object, got ${String(value)}`
  );
  for (const [key, child] of Object.entries(value)) {
    assertPlainJson(child, `${path}.${key}`);
  }
}

function collectObjectReferences(value: unknown, into: Set<object> = new Set()): Set<object> {
  if (typeof value === "object" && value !== null) {
    into.add(value);
    for (const child of Object.values(value)) {
      collectObjectReferences(child, into);
    }
  }
  return into;
}

type ObjectRecord = {
  id: string;
  type: ObjectType;
  position: Vector;
  rotation: number;
  dimensions: object;
  material: string;
  color: string;
};

function toContextObject(data: ObjectRecord): AIContextObject {
  return {
    id: data.id,
    type: data.type,
    position: { ...data.position },
    rotation: data.rotation,
    dimensions: { ...(data.dimensions as Record<string, number>) },
    material: data.material,
    color: data.color,
    assemblyIds: []
  };
}

/** Sets (or, with `undefined`, removes) one dimension on a freshly created record - never on a snapshot under test. */
function setDimension(dimensions: object, key: string, value: number | undefined): void {
  const record = dimensions as Record<string, number>;
  if (value === undefined) {
    delete record[key];
  } else {
    record[key] = value;
  }
}

/**
 * Per type: build a fresh default record through the real factory, break
 * one dimension, and return both the real validator's verdict and the
 * snapshot object the analyzer would receive for the same record.
 */
const BROKEN_SAMPLES: Record<string, (key: string, value: number | undefined) => { object: AIContextObject; validatorErrors: GeometryError[] }> = {
  wall: (key, value) => {
    const data = createWallData();
    setDimension(data.dimensions, key, value);
    return { object: toContextObject(data), validatorErrors: validateWall(data).errors };
  },
  pillar: (key, value) => {
    const data = createPillarData();
    setDimension(data.dimensions, key, value);
    return { object: toContextObject(data), validatorErrors: validatePillar(data).errors };
  },
  beam: (key, value) => {
    const data = createBeamData();
    setDimension(data.dimensions, key, value);
    return { object: toContextObject(data), validatorErrors: validateBeam(data).errors };
  },
  slab: (key, value) => {
    const data = createSlabData();
    setDimension(data.dimensions, key, value);
    return { object: toContextObject(data), validatorErrors: validateSlab(data).errors };
  },
  door: (key, value) => {
    const data = createDoorData();
    setDimension(data.dimensions, key, value);
    return { object: toContextObject(data), validatorErrors: validateDoor(data).errors };
  },
  window: (key, value) => {
    const data = createWindowData();
    setDimension(data.dimensions, key, value);
    return { object: toContextObject(data), validatorErrors: validateWindow(data).errors };
  }
};

const FILE_NAMES: Record<string, string> = {
  wall: "Wall",
  pillar: "Pillar",
  beam: "Beam",
  slab: "Slab",
  door: "Door",
  window: "Window"
};

function readSource(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

function run(): void {
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

  console.log("Construction geometry analysis verification\n");

  // --- Dimension semantics, read from the real implementation ---

  check("the dimension-to-axis table matches every mesh builder's BoxGeometry(width, height, depth) arguments", () => {
    for (const type of Object.keys(FILE_NAMES)) {
      const source = readSource(`../../../scene/${type}/build${FILE_NAMES[type]}Mesh.ts`);
      const match = /new THREE\.BoxGeometry\(\s*\w+\.dimensions\.(\w+),\s*\w+\.dimensions\.(\w+),\s*\w+\.dimensions\.(\w+)\s*\)/.exec(source);
      assertTrue(match, `could not find build${FILE_NAMES[type]}Mesh's BoxGeometry call`);
      assertSameJson(LOCAL_AXIS_DIMENSIONS[type], { x: match[1], y: match[2], z: match[3] }, `${type} local axes vs its mesh builder`);
    }
  });

  check("the table covers exactly the AI-supported types, and exactly the dimensions each validator checks", () => {
    // Elements take their axes from the element catalog, per kind, and
    // assets from ASSET_AXES (a fixed width/height/depth, not one mesh
    // builder's BoxGeometry call) - see the next two checks.
    assertSameJson(
      Object.keys(LOCAL_AXIS_DIMENSIONS).sort(),
      AI_SUPPORTED_OBJECT_TYPES.filter((type) => type !== "element" && type !== "asset").sort(),
      "table types"
    );
    for (const type of Object.keys(FILE_NAMES)) {
      const source = readSource(`../../${type}/validate${FILE_NAMES[type]}.ts`);
      const validated = [...source.matchAll(/isPositiveFinite\(\w+\.dimensions\?\.(\w+)\)/g)].map((match) => match[1]).sort();
      assertSameJson(Object.values(LOCAL_AXIS_DIMENSIONS[type]).sort(), validated, `${type} dimensions vs validate${FILE_NAMES[type]}`);
    }
  });

  check("an element's axes are its catalog kind's, and an element of an unknown kind has none", () => {
    for (const definition of ELEMENT_KINDS) {
      assertSameJson(localAxesFor("element", definition.kind), definition.axes, `${definition.kind} axes`);
    }
    assertEqual(localAxesFor("element", "spaceship"), undefined, "unknown kind");
    assertEqual(localAxesFor("element"), undefined, "no kind");
    assertSameJson(localAxesFor("wall"), LOCAL_AXIS_DIMENSIONS.wall, "the six original types still use the table");
  });

  check("an asset's axes are always width/height/depth, regardless of which asset", () => {
    assertSameJson(localAxesFor("asset"), ASSET_AXES, "asset axes");
    assertSameJson(localAxesFor("asset", "sofa"), ASSET_AXES, "an assetId doesn't change the axes - every asset uses the same three");
  });

  // --- A. Unrotated wall ---

  check("A. an unrotated wall's box is its length on X, height on Y, thickness on Z around its center", () => {
    const analysis = analyze([wall("wall-1", { x: 1, y: 1.35, z: -2 })]);
    const geometry = geometryOf(analysis, "wall-1");
    assertSameJson(geometry.aabb, { min: { x: -1, y: 0, z: -2.1 }, max: { x: 3, y: 2.7, z: -1.9 } }, "aabb");
    assertSameJson(geometry.size, { x: 4, y: 2.7, z: 0.2 }, "size");
    assertSameJson(geometry.center, { x: 1, y: 1.35, z: -2 }, "center");
    assertSameJson(geometry.dimensions, WALL_DIMENSIONS, "dimensions copied");
    assertEqual(geometry.rotation, 0, "rotation");
    assertEqual(geometry.type, "wall", "type");
  });

  // --- B. Rotated wall ---

  check("B. a wall rotated 90 degrees around Y runs along Z: X extent = thickness, Z extent = length", () => {
    const geometry = geometryOf(analyze([wall("wall-1", { x: 0, y: 1.35, z: 0 }, Math.PI / 2)]), "wall-1");
    assertClose(geometry.aabb.min.x, -0.1, "min x");
    assertClose(geometry.aabb.max.x, 0.1, "max x");
    assertClose(geometry.aabb.min.z, -2, "min z");
    assertClose(geometry.aabb.max.z, 2, "max z");
    assertClose(geometry.size.x, 0.2, "size x");
    assertClose(geometry.size.z, 4, "size z");
    // Rounded to GEOMETRY_DECIMALS, so these are also exact - not 0.1000000000000001.
    assertSameJson(geometry.aabb, { min: { x: -0.1, y: 0, z: -2 }, max: { x: 0.1, y: 2.7, z: 2 } }, "exact aabb");
    assertEqual(geometry.rotation, Math.PI / 2, "rotation is reported as given");
  });

  check("B. a wall rotated 45 degrees has equal X and Z extents of (length + thickness) / sqrt(2)", () => {
    const geometry = geometryOf(analyze([wall("wall-1", { x: 0, y: 1.35, z: 0 }, Math.PI / 4)]), "wall-1");
    const expected = (4 + 0.2) * Math.SQRT1_2;
    assertClose(geometry.size.x, expected, "size x", 1e-8);
    assertClose(geometry.size.z, expected, "size z", 1e-8);
    assertEqual(geometry.size.y, 2.7, "height unaffected by a Y rotation");
    assertClose(geometry.aabb.max.x, expected / 2, "max x", 1e-8);
  });

  // --- C-F. The other five types ---

  check("C. pillar: width on X, height on Y, depth on Z - and width/depth swap when rotated 90 degrees", () => {
    const dims = { depth: 0.8, height: 3, width: 0.5 };
    const straight = geometryOf(analyze([makeObject("pillar-1", "pillar", dims, { x: 0, y: 1.5, z: 0 })]), "pillar-1");
    assertSameJson(straight.aabb, { min: { x: -0.25, y: 0, z: -0.4 }, max: { x: 0.25, y: 3, z: 0.4 } }, "aabb");
    assertSameJson(straight.size, { x: 0.5, y: 3, z: 0.8 }, "size");
    const turned = geometryOf(analyze([makeObject("pillar-1", "pillar", dims, { x: 0, y: 1.5, z: 0 }, Math.PI / 2)]), "pillar-1");
    assertSameJson(turned.size, { x: 0.8, y: 3, z: 0.5 }, "rotated size");
  });

  check("D. beam: length on X, height on Y, width on Z", () => {
    const geometry = geometryOf(
      analyze([makeObject("beam-1", "beam", { height: 0.4, length: 3, width: 0.3 }, { x: 1, y: 3, z: 2 })]),
      "beam-1"
    );
    assertSameJson(geometry.aabb, { min: { x: -0.5, y: 2.8, z: 1.85 }, max: { x: 2.5, y: 3.2, z: 2.15 } }, "aabb");
    assertSameJson(geometry.size, { x: 3, y: 0.4, z: 0.3 }, "size");
  });

  check("E. slab: length on X, thickness on Y, width on Z", () => {
    const geometry = geometryOf(
      analyze([makeObject("slab-1", "slab", { length: 5, thickness: 0.2, width: 4 }, { x: 0, y: 0.1, z: 0 })]),
      "slab-1"
    );
    assertSameJson(geometry.aabb, { min: { x: -2.5, y: 0, z: -2 }, max: { x: 2.5, y: 0.2, z: 2 } }, "aabb");
    assertSameJson(geometry.size, { x: 5, y: 0.2, z: 4 }, "size");
  });

  check("F. door and window: width on X, height on Y, thickness on Z", () => {
    const analysis = analyze([
      makeObject("door-1", "door", { height: 2.1, thickness: 0.05, width: 0.9 }, { x: 0, y: 1.05, z: 0 }),
      makeObject("window-1", "window", { height: 1, thickness: 0.08, width: 1.2 }, { x: 0, y: 1.5, z: 0 })
    ]);
    assertSameJson(geometryOf(analysis, "door-1").aabb, { min: { x: -0.45, y: 0, z: -0.025 }, max: { x: 0.45, y: 2.1, z: 0.025 } }, "door aabb");
    assertSameJson(geometryOf(analysis, "door-1").size, { x: 0.9, y: 2.1, z: 0.05 }, "door size");
    assertSameJson(geometryOf(analysis, "window-1").aabb, { min: { x: -0.6, y: 1, z: -0.04 }, max: { x: 0.6, y: 2, z: 0.04 } }, "window aabb");
    assertSameJson(geometryOf(analysis, "window-1").size, { x: 1.2, y: 1, z: 0.08 }, "window size");
  });

  // --- G. Objects at different positions ---

  check("G. separated objects: center, horizontal and vertical distances, gaps, and left/right/front/behind", () => {
    const analysis = analyze([
      wall("wall-1", { x: 0, y: 1.35, z: 0 }),
      makeObject("pillar-1", "pillar", PILLAR_DIMENSIONS, { x: 5, y: 1.35, z: 3 })
    ]);
    const { pair, firstRelativeToSecond } = relationBetween(analysis, "pillar-1", "wall-1");
    assertEqual(pair.a, "pillar-1", "pairs are ordered by id");
    assertSameJson(pair.centerDelta, { x: -5, y: 0, z: -3 }, "b minus a");
    assertClose(pair.centerDistance, Math.sqrt(34), "center distance");
    assertEqual(pair.centerDistance, 5.830951895, "center distance, rounded to 9 places");
    assertEqual(pair.horizontalDistance, 5.830951895, "all of it horizontal");
    assertEqual(pair.verticalDistance, 0, "same center height");
    // pillar x 4.8..5.2, z 2.8..3.2; wall x -2..2, z -0.1..0.1
    assertSameJson(firstRelativeToSecond, relation({ rightOf: true, inFrontOf: true }), "pillar relative to wall");
    assertSameJson(relationBetween(analysis, "wall-1", "pillar-1").firstRelativeToSecond, relation({ leftOf: true, behind: true }), "wall relative to pillar");
    assertSameJson(pair.overlap, { x: false, y: true, z: false, aabb: false }, "overlap");
    assertSameJson(pair.gap, { x: 2.8, y: 0, z: 2.7 }, "gap");
  });

  // --- H. Overlapping objects ---

  check("H. crossing walls overlap on every axis and have no directional relation", () => {
    const analysis = analyze([wall("wall-1", { x: 0, y: 1.35, z: 0 }), wall("wall-2", { x: 0, y: 1.35, z: 0 }, Math.PI / 2)]);
    const { pair } = relationBetween(analysis, "wall-1", "wall-2");
    assertSameJson(pair.overlap, { x: true, y: true, z: true, aabb: true }, "overlap");
    assertSameJson(pair.gap, { x: 0, y: 0, z: 0 }, "gap");
    assertSameJson(pair.aRelativeToB, NO_RELATION, "no directional relation");
    assertEqual(pair.centerDistance, 0, "same center");
  });

  check("H. X overlap without Z overlap is not a box overlap", () => {
    const analysis = analyze([
      wall("wall-1", { x: 0, y: 1.35, z: 0 }),
      wall("wall-2", { x: 0, y: 1.35, z: 0 }, Math.PI / 2),
      wall("wall-3", { x: 3, y: 1.35, z: 1 })
    ]);
    // wall-1 x -2..2, z -0.1..0.1; wall-3 x 1..5, z 0.9..1.1
    const oneThree = relationBetween(analysis, "wall-1", "wall-3");
    assertSameJson(oneThree.pair.overlap, { x: true, y: true, z: false, aabb: false }, "wall-1 / wall-3 overlap");
    assertSameJson(oneThree.firstRelativeToSecond, relation({ behind: true }), "wall-1 relative to wall-3");
    assertSameJson(oneThree.pair.gap, { x: 0, y: 0, z: 0.8 }, "wall-1 / wall-3 gap");
    // wall-2 (turned) x -0.1..0.1, z -2..2
    const twoThree = relationBetween(analysis, "wall-2", "wall-3");
    assertSameJson(twoThree.pair.overlap, { x: false, y: true, z: true, aabb: false }, "wall-2 / wall-3 overlap");
    assertSameJson(twoThree.firstRelativeToSecond, relation({ leftOf: true }), "wall-2 relative to wall-3");
    assertSameJson(twoThree.pair.gap, { x: 0.9, y: 0, z: 0 }, "wall-2 / wall-3 gap");
  });

  // --- I. Vertically separated objects ---

  check("I. a beam above a wall is 'above' with no false left/right/front/behind", () => {
    const analysis = analyze([
      wall("wall-1", { x: 0, y: 1.35, z: 0 }),
      makeObject("beam-1", "beam", { height: 0.4, length: 4, width: 0.2 }, { x: 0, y: 3.2, z: 0 })
    ]);
    const { pair, firstRelativeToSecond } = relationBetween(analysis, "beam-1", "wall-1");
    assertSameJson(firstRelativeToSecond, relation({ above: true }), "beam relative to wall");
    assertSameJson(relationBetween(analysis, "wall-1", "beam-1").firstRelativeToSecond, relation({ below: true }), "wall relative to beam");
    assertSameJson(pair.overlap, { x: true, y: false, z: true, aabb: false }, "overlap");
    assertSameJson(pair.centerDelta, { x: 0, y: -1.85, z: 0 }, "b minus a");
    assertEqual(pair.horizontalDistance, 0, "directly above");
    assertEqual(pair.verticalDistance, 1.85, "vertical distance");
    assertEqual(pair.centerDistance, 1.85, "center distance");
    assertSameJson(pair.gap, { x: 0, y: 0.3, z: 0 }, "0.3 m clear between wall top (2.7) and beam bottom (3.0)");
  });

  // --- J. Rotation really changes the result ---

  check("J. rotating an object changes its box, and can change a relationship", () => {
    const at = (rotation: number) => geometryOf(analyze([wall("wall-1", { x: 0, y: 1.35, z: 0 }, rotation)]), "wall-1");
    assertSameJson(at(0).size, { x: 4, y: 2.7, z: 0.2 }, "0 degrees");
    assertSameJson(at(Math.PI / 2).size, { x: 0.2, y: 2.7, z: 4 }, "90 degrees");
    assertTrue(JSON.stringify(at(Math.PI / 4).aabb) !== JSON.stringify(at(0).aabb), "45 degrees differs from 0");
    assertSameJson(at(Math.PI).aabb, at(0).aabb, "180 degrees covers the same box as 0");

    const pillar = makeObject("pillar-1", "pillar", PILLAR_DIMENSIONS, { x: 0, y: 1.35, z: 1.5 });
    const straight = relationBetween(analyze([wall("wall-1", { x: 0, y: 1.35, z: 0 }), pillar]), "pillar-1", "wall-1");
    assertEqual(straight.pair.overlap.aabb, false, "unrotated wall doesn't reach the pillar");
    assertSameJson(straight.firstRelativeToSecond, relation({ inFrontOf: true }), "pillar in front of the unrotated wall");
    const turned = relationBetween(analyze([wall("wall-1", { x: 0, y: 1.35, z: 0 }, Math.PI / 2), pillar]), "pillar-1", "wall-1");
    assertEqual(turned.pair.overlap.aabb, true, "the wall turned along Z runs through the pillar");
    assertSameJson(turned.firstRelativeToSecond, NO_RELATION, "no directional relation once overlapping");
  });

  // --- K. Deterministic ordering ---

  check("K. objects are sorted by id (wall-2 before wall-10) and pairs follow that order, whatever the input order", () => {
    const objects = [
      wall("wall-10", { x: 0, y: 1.35, z: 0 }),
      wall("wall-2", { x: 0, y: 1.35, z: 5 }),
      makeObject("pillar-1", "pillar", PILLAR_DIMENSIONS, { x: 5, y: 1.35, z: 0 }),
      makeObject("beam-3", "beam", { height: 0.4, length: 3, width: 0.3 }, { x: 0, y: 3, z: 0 }),
      makeObject("slab-1", "slab", { length: 5, thickness: 0.2, width: 4 }, { x: 10, y: 0.1, z: 10 })
    ];
    const analysis = analyze(objects);
    const ids = ["beam-3", "pillar-1", "slab-1", "wall-2", "wall-10"];
    assertSameJson(analysis.objects.map((object) => object.id), ids, "object order");

    const expectedPairs: string[] = [];
    for (let first = 0; first < ids.length; first += 1) {
      for (let second = first + 1; second < ids.length; second += 1) {
        expectedPairs.push(`${ids[first]}|${ids[second]}`);
      }
    }
    assertSameJson(analysis.relationships.map((pair) => `${pair.a}|${pair.b}`), expectedPairs, "pair order");
    assertEqual(analysis.relationships.length, (ids.length * (ids.length - 1)) / 2, "n(n-1)/2 pairs");
    assertTrue(analysis.relationships.every((pair) => compareIds(pair.a, pair.b) < 0), "a always sorts before b");

    assertSameJson(analyze([...objects].reverse()), analysis, "reversed input gives identical output");
    assertSameJson(analyze(objects), analysis, "a second run gives identical output");
  });

  // --- L. Empty project ---

  check("L. an empty project gives an empty analysis", () => {
    // hosts and connections arrived with wall hosting and endpoint connections.
    assertSameJson(analyze([]), { objects: [], relationships: [], invalidObjects: [], hosts: [], connections: [] }, "empty analysis");
  });

  // --- M. Snapshot immutability ---

  check("M. the input snapshot is left byte-for-byte unchanged, and the output shares no references with it", () => {
    const snapshot = makeSnapshot([
      wall("wall-2", { x: 0, y: 1.35, z: 0 }, Math.PI / 3),
      makeObject("pillar-1", "pillar", PILLAR_DIMENSIONS, { x: 3, y: 1.35, z: 2 }),
      wall("wall-1", { x: 0, y: 1.35, z: 5 }, 0, { height: 2.7, length: 0, thickness: 0.2 })
    ]);
    snapshot.objects[0].assemblyIds.push("assembly-1");
    const before = JSON.stringify(snapshot);
    // Frozen all the way down: any write to the snapshot would throw here (ES modules run in strict mode).
    deepFreeze(snapshot);

    const analysis = analyzeConstructionGeometry(snapshot);

    assertEqual(JSON.stringify(snapshot), before, "snapshot JSON unchanged");
    assertSameJson(snapshot.objects.map((object) => object.id), ["wall-2", "pillar-1", "wall-1"], "the input array was not re-sorted in place");
    const inputReferences = collectObjectReferences(snapshot);
    const shared = [...collectObjectReferences(analysis)].filter((reference) => inputReferences.has(reference));
    assertEqual(shared.length, 0, "no output object is an input object");
  });

  // --- Output shape ---

  check("the output is plain JSON data - it survives a JSON round trip unchanged", () => {
    const analysis = analyze([
      wall("wall-1", { x: 0, y: 1.35, z: 0 }, 0.7),
      makeObject("beam-1", "beam", { height: 0.4, length: 3, width: 0.3 }, { x: -1, y: 3, z: 2 }, -2),
      wall("wall-2", { x: 1, y: 1.35, z: 1 }, 0, { height: 2.7, length: -1, thickness: 0.2 })
    ]);
    assertPlainJson(analysis, "analysis");
    assertSameJson(JSON.parse(JSON.stringify(analysis)), analysis, "round trip");
  });

  check(`every derived number is rounded to ${GEOMETRY_DECIMALS} decimal places`, () => {
    const analysis = analyze([
      wall("wall-1", { x: 0.1 + 0.2, y: 1.35, z: -0.7 }, 0.3),
      makeObject("pillar-1", "pillar", PILLAR_DIMENSIONS, { x: Math.PI, y: 1.35, z: Math.E }, 1.1)
    ]);
    const scale = 10 ** GEOMETRY_DECIMALS;
    const derived: number[] = [];
    for (const object of analysis.objects) {
      derived.push(...Object.values(object.center), ...Object.values(object.size), ...Object.values(object.aabb.min), ...Object.values(object.aabb.max));
    }
    for (const pair of analysis.relationships) {
      derived.push(...Object.values(pair.centerDelta), ...Object.values(pair.gap), pair.centerDistance, pair.horizontalDistance, pair.verticalDistance);
    }
    for (const value of derived) {
      assertEqual(Math.round(value * scale) / scale, value, "rounded value");
    }
    assertEqual(geometryOf(analysis, "wall-1").center.x, 0.3, "0.1 + 0.2 is reported as 0.3");
  });

  // --- Invalid input ---

  check("zero, negative, NaN, and missing dimensions give the same errors as each type's real validator", () => {
    for (const type of Object.keys(BROKEN_SAMPLES)) {
      for (const key of Object.values(LOCAL_AXIS_DIMENSIONS[type])) {
        for (const value of [0, -1, Number.NaN, undefined]) {
          const { object, validatorErrors } = BROKEN_SAMPLES[type](key, value);
          const context = `${type}.${key} = ${String(value)}`;
          assertEqual(validatorErrors.length > 0, true, `${context}: the validator rejects it`);

          const analysis = analyzeConstructionGeometry(makeSnapshot([object]));
          assertEqual(analysis.objects.length, 0, `${context}: no box is produced`);
          assertEqual(analysis.invalidObjects.length, 1, `${context}: reported as invalid`);
          assertSameJson(
            analysis.invalidObjects[0].errors,
            validatorErrors.filter((error) => error.field.startsWith("dimensions.")),
            `${context}: same field and message as the validator`
          );
        }
      }
    }
  });

  check("an invalid object is left out of objects and relationships; the valid ones are still analyzed", () => {
    const analysis = analyze([
      wall("wall-1", { x: 0, y: 1.35, z: 0 }),
      wall("wall-2", { x: 5, y: 1.35, z: 0 }, 0, { height: 2.7, length: 4, thickness: 0 }),
      makeObject("pillar-1", "pillar", { depth: -0.4, height: 2.7, width: 0.4 }, { x: 3, y: 1.35, z: 3 }),
      makeObject("pillar-2", "pillar", PILLAR_DIMENSIONS, { x: 3, y: 1.35, z: 3 })
    ]);
    assertSameJson(analysis.objects.map((object) => object.id), ["pillar-2", "wall-1"], "valid objects");
    assertSameJson(analysis.relationships.map((pair) => `${pair.a}|${pair.b}`), ["pillar-2|wall-1"], "only valid pairs");
    assertSameJson(
      analysis.invalidObjects,
      [
        { id: "pillar-1", type: "pillar", errors: [{ field: "dimensions.depth", message: "Depth must be a finite number greater than 0." }] },
        { id: "wall-2", type: "wall", errors: [{ field: "dimensions.thickness", message: "Thickness must be a finite number greater than 0." }] }
      ],
      "invalid objects, sorted by id"
    );
  });

  check("a non-finite position or rotation, or an unsupported type, is reported rather than boxed", () => {
    const analysis = analyze([
      wall("wall-1", { x: Number.NaN, y: 1.35, z: 0 }, Number.POSITIVE_INFINITY),
      makeObject("roof-1", "roof", { length: 4 }, { x: 0, y: 3, z: 0 })
    ]);
    assertEqual(analysis.objects.length, 0, "nothing boxed");
    assertSameJson(
      analysis.invalidObjects,
      [
        { id: "roof-1", type: "roof", errors: [{ field: "type", message: 'Geometry isn\'t defined for object type "roof".' }] },
        {
          id: "wall-1",
          type: "wall",
          errors: [
            { field: "position.x", message: "Position X must be a finite number." },
            { field: "rotation", message: "Rotation Y must be a finite number." }
          ]
        }
      ],
      "invalid objects"
    );
  });

  // --- Rotation and floating-point edge cases ---

  check("rotations beyond one full revolution, and negative rotations, give the same box", () => {
    const boxAt = (rotation: number) => geometryOf(analyze([wall("wall-1", { x: 2, y: 1.35, z: -1 }, rotation)]), "wall-1");
    for (const base of [0, 0.3, 1, Math.PI / 2, 2.5]) {
      const reference = JSON.stringify(boxAt(base).aabb);
      for (const turns of [-2, -1, 1, 2, 5]) {
        assertEqual(JSON.stringify(boxAt(base + turns * 2 * Math.PI).aabb), reference, `${base} + ${turns} turns`);
      }
      // A box is symmetric, so turning the other way covers the same AABB.
      assertEqual(JSON.stringify(boxAt(-base).aabb), reference, `-${base}`);
    }
    assertEqual(boxAt(0.3 + 2 * Math.PI).rotation, 0.3 + 2 * Math.PI, "the rotation itself is reported as given, not normalized");
  });

  check("floating-point noise can't make touching boxes overlap: 0.1 + 0.2 and 0.3 give identical results", () => {
    const withNoise = analyze([
      wall("wall-1", { x: 0.1, y: 1.35, z: 0 }, 0, { height: 2.7, length: 0.2, thickness: 0.2 }),
      wall("wall-2", { x: 0.1 + 0.2, y: 1.35, z: 0 }, 0, { height: 2.7, length: 0.2, thickness: 0.2 })
    ]);
    const exact = analyze([
      wall("wall-1", { x: 0.1, y: 1.35, z: 0 }, 0, { height: 2.7, length: 0.2, thickness: 0.2 }),
      wall("wall-2", { x: 0.3, y: 1.35, z: 0 }, 0, { height: 2.7, length: 0.2, thickness: 0.2 })
    ]);
    assertSameJson(withNoise, exact, "identical analyses");
    const { pair } = relationBetween(withNoise, "wall-1", "wall-2");
    assertEqual(geometryOf(withNoise, "wall-1").aabb.max.x, 0.2, "wall-1 ends at x = 0.2");
    assertEqual(geometryOf(withNoise, "wall-2").aabb.min.x, 0.2, "wall-2 starts at x = 0.2");
    assertEqual(pair.overlap.x, false, "touching is not overlapping");
    assertEqual(pair.aRelativeToB.leftOf, true, "a box touching another's face is still entirely to one side");
    assertEqual(pair.gap.x, 0, "no gap");

    const turned = geometryOf(analyze([wall("wall-1", { x: 0, y: 1.35, z: 0 }, Math.PI / 2)]), "wall-1");
    assertEqual(turned.size.x, 0.2, "cos(pi/2) noise is rounded away");
  });

  // --- Purity ---

  check("the geometry module imports nothing but plain type/ordering helpers - no Three.js, DOM, stores, providers, or clocks", () => {
    const directory = fileURLToPath(new URL(".", import.meta.url));
    const files = readdirSync(directory).filter((name) => name.endsWith(".ts") && name !== "verify.ts");
    assertTrue(files.length >= 2, "found the module's source files");
    // The element catalog is pure data (which dimension spans each axis of each element kind).
    const allowedImports = new Set(["../types", "../types.ts", "./types", "../../objects/types", "../../elements/catalog.ts"]);
    for (const file of files) {
      const source = readFileSync(`${directory}/${file}`, "utf8");
      for (const [, specifier] of source.matchAll(/from\s+"([^"]+)"/g)) {
        assertTrue(allowedImports.has(specifier), `${file} imports "${specifier}"`);
      }
      const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      for (const forbidden of [/THREE/, /\bdocument\b/, /\bwindow\s*\./, /\bDate\b/, /Math\.random/, /performance\./, /\bfetch\s*\(/, /\bprocess\./, /Store\b/, /CommandExecutor/, /Provider/]) {
        assertTrue(!forbidden.test(code), `${file} must not use ${forbidden}`);
      }
    }
  });

  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) {
    throw new Error(`${failed} verification check(s) failed`);
  }
}

run();
