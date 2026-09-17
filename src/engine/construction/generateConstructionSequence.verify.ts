import { generateConstructionSequence, classifyConstructionObject } from "./generateConstructionSequence.ts";
import type { AIContextObject } from "../ai/types.ts";

let passed = 0;
let failed = 0;

function check(name: string, run: () => void): void {
  try {
    run();
    passed += 1;
  } catch (error) {
    failed += 1;
    console.error(`FAIL: ${name}`);
    console.error(error);
  }
}

function assertTrue(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  }
}

/** A minimal, valid AIContextObject - only the fields a test cares about need overriding. */
function object(overrides: Partial<AIContextObject> & Pick<AIContextObject, "id" | "type">): AIContextObject {
  return {
    position: { x: 0, y: 0, z: 0 },
    rotation: 0,
    dimensions: {},
    material: "generic",
    color: "#ffffff",
    assemblyIds: [],
    ...overrides
  };
}

check("classifies the six original types", () => {
  assertEqual(classifyConstructionObject(object({ id: "wall-1", type: "wall" })), "walls", "wall");
  assertEqual(classifyConstructionObject(object({ id: "pillar-1", type: "pillar" })), "structure", "pillar");
  assertEqual(classifyConstructionObject(object({ id: "beam-1", type: "beam" })), "structure", "beam");
  assertEqual(classifyConstructionObject(object({ id: "slab-1", type: "slab" })), "structure", "slab");
  assertEqual(classifyConstructionObject(object({ id: "door-1", type: "door" })), "openings", "door");
  assertEqual(classifyConstructionObject(object({ id: "window-1", type: "window" })), "openings", "window");
});

check("classifies elements by kind, excluding rooms", () => {
  assertEqual(classifyConstructionObject(object({ id: "element-1", type: "element", kind: "foundation" })), "foundation", "foundation");
  assertEqual(classifyConstructionObject(object({ id: "element-2", type: "element", kind: "roof" })), "roof", "roof");
  assertEqual(classifyConstructionObject(object({ id: "element-3", type: "element", kind: "stair" })), "structure", "stair");
  assertEqual(classifyConstructionObject(object({ id: "element-4", type: "element", kind: "flooring" })), "finish", "flooring");
  assertEqual(classifyConstructionObject(object({ id: "element-5", type: "element", kind: "ceiling" })), "finish", "ceiling");
  assertEqual(classifyConstructionObject(object({ id: "element-6", type: "element", kind: "water-pipe" })), "services", "water-pipe");
  assertEqual(classifyConstructionObject(object({ id: "element-7", type: "element", kind: "switch" })), "services", "switch");
  assertEqual(classifyConstructionObject(object({ id: "element-8", type: "element", kind: "sofa" })), "interior", "sofa");
  assertEqual(classifyConstructionObject(object({ id: "element-9", type: "element", kind: "tree" })), "exterior", "tree");
  assertEqual(classifyConstructionObject(object({ id: "element-10", type: "element", kind: "room" })), null, "room excluded");
});

check("classifies assets as interior (no outdoor asset in the catalog today)", () => {
  assertEqual(classifyConstructionObject(object({ id: "asset-1", type: "asset", assetId: "sofa" })), "interior", "sofa asset");
});

check("a simple house without plumbing/electrical objects does not show those steps", () => {
  const objects: AIContextObject[] = [
    object({ id: "wall-1", type: "wall", dimensions: { length: 4, height: 2.7, thickness: 0.2 } }),
    object({ id: "door-1", type: "door" })
  ];
  const sequence = generateConstructionSequence(objects);
  const categories = sequence.steps.map((step) => step.category);
  assertTrue(categories.includes("walls"), "has walls step");
  assertTrue(categories.includes("openings"), "has openings step");
  assertTrue(!categories.includes("services"), "no services step");
});

check("full sample project: correct phases, ordering, real ids, no invented objects", () => {
  const objects: AIContextObject[] = [
    object({ id: "element-foundation-1", type: "element", kind: "foundation", dimensions: { length: 10, depth: 0.6, width: 8 } }),
    object({ id: "pillar-1", type: "pillar" }),
    object({ id: "pillar-2", type: "pillar" }),
    object({ id: "pillar-3", type: "pillar" }),
    object({ id: "pillar-4", type: "pillar" }),
    object({ id: "beam-1", type: "beam" }),
    object({ id: "slab-1", type: "slab" }),
    object({ id: "wall-1", type: "wall", material: "brick", dimensions: { length: 5, height: 2.7, thickness: 0.2 } }),
    object({ id: "wall-2", type: "wall", material: "brick", dimensions: { length: 4, height: 2.7, thickness: 0.2 } }),
    object({ id: "wall-3", type: "wall", material: "gypsum", dimensions: { length: 3, height: 2.7, thickness: 0.1 } }),
    object({ id: "door-1", type: "door" }),
    object({ id: "window-1", type: "window" }),
    object({ id: "window-2", type: "window" }),
    object({ id: "element-roof-1", type: "element", kind: "roof", dimensions: { length: 10, height: 1.6, width: 8 } }),
    object({ id: "element-pipe-1", type: "element", kind: "water-pipe", dimensions: { length: 3, diameter: 0.025 } }),
    object({ id: "element-cable-1", type: "element", kind: "cable", dimensions: { length: 4, diameter: 0.008 } }),
    object({ id: "element-room-1", type: "element", kind: "room" }),
    object({ id: "asset-sofa-1", type: "asset", assetId: "sofa", label: "Sofa" }),
    object({ id: "asset-bed-1", type: "asset", assetId: "bed", label: "Bed" })
  ];

  const sequence = generateConstructionSequence(objects, { projectId: "project-1" });
  assertEqual(sequence.projectId, "project-1", "carries the given projectId");

  const categoryOrder = sequence.steps.map((step) => step.category);
  assertEqual(
    categoryOrder.join(","),
    ["foundation", "structure", "walls", "openings", "services", "roof", "interior"].join(","),
    "phases present, in fixed phase order, finish/exterior skipped since nothing maps to them"
  );

  sequence.steps.forEach((step, index) => assertEqual(step.order, index + 1, `step ${step.category} has correct 1-based order`));

  const allRealIds = new Set(objects.map((object) => object.id));
  for (const step of sequence.steps) {
    for (const id of step.objectIds) {
      assertTrue(allRealIds.has(id), `step ${step.category} references a real object id (${id})`);
      assertTrue(id !== "fake-id", "never a fabricated id");
    }
  }
  const roomStepReference = sequence.steps.some((step) => step.objectIds.includes("element-room-1"));
  assertTrue(!roomStepReference, "the room element is excluded from every step");

  const structureStep = sequence.steps.find((step) => step.category === "structure");
  assertTrue(structureStep !== undefined, "structure step exists");
  assertEqual(structureStep!.objectIds.length, 6, "4 pillars + 1 beam + 1 slab");

  const wallsStep = sequence.steps.find((step) => step.category === "walls")!;
  const wallCountComponent = wallsStep.requiredComponents.find((c) => c.name === "Wall count")!;
  assertEqual(wallCountComponent.quantity, 3, "wall count is real and correct");
  const brickComponent = wallsStep.requiredComponents.find((c) => c.name === "Wall material - brick")!;
  assertEqual(brickComponent.quantity, 2, "2 brick walls counted by real material field");
  const lengthComponent = wallsStep.requiredComponents.find((c) => c.name === "Total wall length")!;
  assertEqual(lengthComponent.quantity, 12, "total wall length summed from real dimensions (5+4+3)");

  const foundationStep = sequence.steps.find((step) => step.category === "foundation")!;
  const concreteComponent = foundationStep.requiredComponents.find((c) => c.name === "Concrete (foundation)")!;
  assertEqual(concreteComponent.quantity, "Not calculated", "never fabricates a concrete volume");

  const servicesStep = sequence.steps.find((step) => step.category === "services")!;
  const pipeComponent = servicesStep.requiredComponents.find((c) => c.name === "Water Pipe")!;
  assertEqual(pipeComponent.quantity, 3, "linear service quantity is a real summed length, not a unit count");
  assertEqual(pipeComponent.unit, "m", "linear service unit is meters");

  const interiorStep = sequence.steps.find((step) => step.category === "interior")!;
  assertEqual(interiorStep.objectIds.length, 2, "2 furniture assets");
});

check("steps are stable and re-derivable: regenerating from the same objects yields the same steps and components", () => {
  const objects: AIContextObject[] = [
    object({ id: "wall-1", type: "wall", dimensions: { length: 5 } }),
    object({ id: "door-1", type: "door" })
  ];
  const first = generateConstructionSequence(objects);
  const second = generateConstructionSequence(objects);
  assertEqual(JSON.stringify(first.steps), JSON.stringify(second.steps), "same project objects always classify into the same steps");
});

console.log(`generateConstructionSequence.verify: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  throw new Error(`${failed} verification check(s) failed`);
}
