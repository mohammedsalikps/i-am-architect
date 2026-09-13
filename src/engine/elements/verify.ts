/**
 * Verification for the element system - the catalog-driven construction
 * objects (foundation, roof, stair, rooms, finishes, plumbing,
 * electrical, interior, exterior) - and for a complete house built from
 * every category. Same approach as every other verify.ts in this
 * project: no test framework, plain assertion helpers, run directly by
 * Node against the real engine (the real ProjectContext, CommandExecutor,
 * stores, history, persistence, geometry analysis, and mock AI). Run with:
 *   npm run verify
 * or directly:
 *   node --experimental-transform-types src/engine/elements/verify.ts
 * (transform-types because the history controllers use parameter
 * properties).
 */
import { ELEMENT_CATEGORIES, ELEMENT_KINDS, catalogProblems, constructionTypeRegistry, getElementKind } from "./catalog.ts";
import type { ElementKindDefinition } from "./catalog.ts";
import { createElementData } from "./createElement.ts";
import type { CreateElementOptions } from "./createElement.ts";
import { validateElement } from "./validateElement.ts";
import { ElementStore } from "./ElementStore.ts";
import { isInsideRoom, isRoom, objectsInRoom, roomArea } from "./rooms.ts";
import { ROOM_PRESETS, roomPresetOptions } from "./roomPresets.ts";
import { MATERIAL_LIBRARY, getMaterial, materialsFor } from "../materials/materialLibrary.ts";
import { WINDOW_SILL_HEIGHT, hostedTransform } from "../openings/hostOpening.ts";
import { createDoorData } from "../door/createDoor.ts";
import { validateDoor } from "../door/validateDoor.ts";
import { createProjectContext } from "../project/ProjectContext.ts";
import { loadProject, serializeProject } from "../project/projectPersistence.ts";
import { parseProjectDocument } from "../project/projectDocument.ts";
import { AI_SUPPORTED_OBJECT_TYPES, buildAIProjectSnapshot } from "../ai/types.ts";
import { parseAIProjectSnapshot } from "../ai/parseProjectSnapshot.ts";
import { buildAIProjectContext, parseAIProjectContext } from "../ai/aiProjectContext.ts";
import { MockAIProvider } from "../ai/MockAIProvider.ts";
import { AICommandPipeline } from "../ai/AICommandPipeline.ts";
import { buildSimpleHousePlan } from "../ai/housePlan.ts";
import { analyzeConstructionGeometry } from "../ai/geometry/analyzeConstructionGeometry.ts";
import { layoutHandles } from "../manipulation/manipulationMath.ts";
import { ObjectManipulator, createStoreObjectReader } from "../manipulation/ObjectManipulator.ts";
import { buildRibbonTabs } from "../../ui/ribbonTabs.ts";
import type { RibbonActions } from "../../ui/ribbonTabs.ts";

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

function assertClose(actual: number, expected: number, message: string, tolerance = 1e-6): void {
  if (!(Math.abs(actual - expected) <= tolerance)) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

function assertSameJson(actual: unknown, expected: unknown, message: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`${message}:\n  expected ${e}\n  got      ${a}`);
  }
}

type Project = ReturnType<typeof createProjectContext>;

function storesOf(project: Project) {
  return {
    wallStore: project.wallStore,
    pillarStore: project.pillarStore,
    beamStore: project.beamStore,
    slabStore: project.slabStore,
    doorStore: project.doorStore,
    windowStore: project.windowStore,
    elementStore: project.elementStore
  };
}

/** Runs a command that must succeed and create an object; returns its id. */
function create(project: Project, command: unknown): string {
  const result = project.commandExecutor.execute(command);
  assertTrue(result.success && result.objectId, `${JSON.stringify(command)} -> ${JSON.stringify(result)}`);
  return result.objectId;
}

function addElement(project: Project, options: CreateElementOptions): string {
  return create(project, { type: "element.add", element: options });
}

function succeed(project: Project, command: unknown): void {
  const result = project.commandExecutor.execute(command);
  assertTrue(result.success, `${JSON.stringify(command)} -> ${JSON.stringify(result)}`);
}

function allObjects(project: Project) {
  return [
    ...project.wallStore.getAll(),
    ...project.pillarStore.getAll(),
    ...project.beamStore.getAll(),
    ...project.slabStore.getAll(),
    ...project.doorStore.getAll(),
    ...project.windowStore.getAll(),
    ...project.elementStore.getAll()
  ];
}

/**
 * The whole manual-CAD lifecycle of one element kind, through the real
 * engine: create, validate, select, geometry, update (grounded), rename,
 * material, parameters, resize/move/rotate by mouse gestures (each one
 * undoable), duplicate, delete, undo, redo, and a save/reopen round trip.
 */
function exerciseKind(definition: ElementKindDefinition): void {
  const project = createProjectContext();
  const { commandExecutor: executor, elementStore, history, selectionStore } = project;
  const kind = definition.kind;
  const xKey = definition.axes.x;
  const yKey = definition.axes.y;

  // --- Create ---
  const id = addElement(project, { kind });
  assertTrue(id.startsWith(`${kind}-`), `${kind}: id "${id}" is "<kind>-<n>"`);
  const created = elementStore.get(id);
  assertTrue(created, `${kind}: stored`);
  assertEqual(created.kind, kind, `${kind}: kind`);
  assertEqual(created.label, definition.label, `${kind}: default label`);
  assertEqual(created.material, definition.defaultMaterial, `${kind}: default material`);
  assertTrue(validateElement(created).valid, `${kind}: the created element validates`);
  assertClose(created.position.y - created.dimensions[yKey] / 2, definition.baseY, `${kind}: its base rests at the kind's baseY`);
  for (const spec of definition.params) {
    assertEqual(created.params[spec.key], spec.default, `${kind}: default ${spec.key}`);
  }

  // --- Selection, manipulation reader, handles ---
  selectionStore.select(id);
  assertEqual(selectionStore.get(), id, `${kind}: selectable`);
  const read = createStoreObjectReader(storesOf(project))(id);
  assertTrue(read && read.type === "element" && read.kind === kind, `${kind}: the manipulation reader resolves it with its kind`);
  const layout = layoutHandles({ type: "element", kind, dimensions: created.dimensions });
  if (definition.linear) {
    assertTrue(
      layout && layout.resize.length === 3 && layout.endpoints.length === 2 && layout.rotate,
      `${kind}: two endpoint handles (in place of the lengthwise ones), three cross-section handles, and a rotation ring`
    );
  } else {
    assertTrue(layout && layout.resize.length === 5 && layout.endpoints.length === 0 && layout.rotate, `${kind}: five resize handles and a rotation ring`);
  }

  // --- Geometry ---
  const geometry = analyzeConstructionGeometry(buildAIProjectSnapshot(project));
  assertEqual(geometry.invalidObjects.length, 0, `${kind}: no invalid geometry`);
  const box = geometry.objects.find((object) => object.id === id);
  assertTrue(box, `${kind}: the geometry analysis describes it`);
  assertClose(box.size.x, created.dimensions[xKey], `${kind}: box X is its ${xKey}`);
  assertClose(box.size.y, created.dimensions[yKey], `${kind}: box Y is its ${yKey}`);

  // --- Update: a taller element keeps its base ---
  const ySpec = definition.dimensions.find((spec) => spec.key === yKey);
  assertTrue(ySpec, `${kind}: vertical dimension spec`);
  const taller = Math.round((created.dimensions[yKey] + ySpec.step * 2) * 1e6) / 1e6;
  succeed(project, { type: "element.update", id, changes: { dimensions: { ...created.dimensions, [yKey]: taller } } });
  const grown = elementStore.get(id);
  assertTrue(grown, `${kind}: still stored`);
  assertClose(grown.dimensions[yKey], taller, `${kind}: ${yKey} updated`);
  if (definition.linear) {
    assertClose(grown.position.y, created.position.y, `${kind}: its axis - and every joint on it - stays put when it gets thicker`);
  } else {
    assertClose(grown.position.y - taller / 2, definition.baseY, `${kind}: the base stays put when it grows`);
  }

  // --- update_object: name, material, color, parameters ---
  succeed(project, { type: "update_object", objectId: id, changes: { label: `My ${definition.label}` } });
  assertEqual(elementStore.get(id)?.label, `My ${definition.label}`, `${kind}: renamed`);
  const material = materialsFor(definition.materialCategories).find((entry) => entry.id !== grown.material) ?? MATERIAL_LIBRARY[1];
  succeed(project, { type: "update_object", objectId: id, changes: { material: material.id, color: "#123456" } });
  assertEqual(elementStore.get(id)?.material, material.id, `${kind}: material changed`);
  for (const spec of definition.params) {
    const value = spec.kind === "integer" ? spec.max : spec.options[spec.options.length - 1];
    succeed(project, { type: "update_object", objectId: id, changes: { params: { [spec.key]: value } } });
    assertEqual(elementStore.get(id)?.params[spec.key], value, `${kind}: ${spec.key} updated`);
  }

  // --- Mouse gestures: resize (+X handle), move, rotate - one undo step each ---
  const manipulator = new ObjectManipulator({ commandExecutor: executor, history, readObject: createStoreObjectReader(storesOf(project)) });
  const before = elementStore.get(id);
  assertTrue(before, `${kind}: before gestures`);
  const face = { x: before.position.x + before.dimensions[xKey] / 2, y: before.position.y, z: before.position.z };
  assertTrue(manipulator.begin(id, { kind: "resize", axis: "x", side: 1 }, face), `${kind}: a resize gesture starts`);
  manipulator.update({ x: face.x + 0.5, y: face.y, z: face.z });
  manipulator.end();
  assertClose(elementStore.get(id)?.dimensions[xKey] ?? NaN, before.dimensions[xKey] + 0.5, `${kind}: dragging the +X handle 0.5 m grows ${xKey} by 0.5 m`);

  const moveFrom = elementStore.get(id)?.position ?? { x: NaN, y: NaN, z: NaN };
  manipulator.begin(id, { kind: "move" }, { x: 0, y: 0, z: 0 });
  manipulator.update({ x: 1, y: 0, z: 2 });
  manipulator.end();
  const moved = elementStore.get(id)?.position ?? { x: NaN, y: NaN, z: NaN };
  assertClose(moved.x, moveFrom.x + 1, `${kind}: moved 1 m on X`);
  assertClose(moved.z, moveFrom.z + 2, `${kind}: moved 2 m on Z`);
  assertClose(moved.y, moveFrom.y, `${kind}: a move keeps its height`);

  manipulator.begin(id, { kind: "rotate" }, { x: moved.x + 1, y: moved.y, z: moved.z });
  manipulator.update({ x: moved.x, y: moved.y, z: moved.z - 1 });
  manipulator.end();
  assertClose(elementStore.get(id)?.rotation ?? NaN, Math.PI / 2, `${kind}: a quarter-turn drag rotates it 90 degrees`);
  history.undo();
  assertClose(elementStore.get(id)?.rotation ?? NaN, 0, `${kind}: undo un-rotates it`);
  history.redo();
  assertClose(elementStore.get(id)?.rotation ?? NaN, Math.PI / 2, `${kind}: redo rotates it again`);

  // --- Duplicate, delete, undo, redo ---
  const copyId = create(project, { type: "element.duplicate", id });
  assertTrue(copyId !== id, `${kind}: the duplicate has its own id`);
  const original = elementStore.get(id);
  const copy = elementStore.get(copyId);
  assertTrue(original && copy, `${kind}: both exist`);
  assertEqual(copy.kind, kind, `${kind}: duplicate kind`);
  assertEqual(copy.label, original.label, `${kind}: duplicate label`);
  assertEqual(copy.material, original.material, `${kind}: duplicate material`);
  assertSameJson(copy.dimensions, original.dimensions, `${kind}: duplicate dimensions`);
  assertSameJson(copy.params, original.params, `${kind}: duplicate params`);
  assertClose(copy.position.x, original.position.x + 0.75, `${kind}: duplicate offset on X`);

  succeed(project, { type: "element.delete", id: copyId });
  assertEqual(elementStore.get(copyId), undefined, `${kind}: deleted`);
  history.undo();
  assertTrue(elementStore.get(copyId), `${kind}: undo restores the deleted copy`);
  history.redo();
  assertEqual(elementStore.get(copyId), undefined, `${kind}: redo deletes it again`);
  history.undo();
  history.undo();
  assertEqual(elementStore.get(copyId), undefined, `${kind}: undoing the duplicate removes the copy`);
  history.redo();
  assertTrue(elementStore.get(copyId), `${kind}: redoing the duplicate brings it back`);

  // --- Save and reopen ---
  const document = JSON.parse(JSON.stringify(serializeProject(project)));
  const parsed = parseProjectDocument(document);
  assertTrue(parsed.ok, `${kind}: the saved document parses (${parsed.ok ? "" : parsed.error})`);
  const reopened = createProjectContext();
  const loaded = loadProject(reopened, document);
  assertTrue(loaded.ok, `${kind}: the saved document loads (${loaded.ok ? "" : loaded.error})`);
  assertSameJson(reopened.elementStore.getAll(), elementStore.getAll(), `${kind}: a reopened project holds identical elements`);
  const next = addElement(reopened, { kind });
  assertEqual(reopened.elementStore.getAll().filter((element) => element.id === next).length, 1, `${kind}: a new id after loading never collides`);

  // --- Deleting the selected element clears the selection ---
  selectionStore.select(id);
  succeed(project, { type: "element.delete", id });
  assertEqual(selectionStore.get(), null, `${kind}: deleting the selected element clears the selection`);
}

async function run(): Promise<void> {
  let passed = 0;
  let failed = 0;

  async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
    try {
      await fn();
      passed += 1;
      console.log(`  ok - ${name}`);
    } catch (error) {
      failed += 1;
      console.error(`  FAIL - ${name}`);
      console.error(error);
    }
  }

  console.log("Element system verification\n");

  // --- Registries ---

  await check("the element catalog is consistent: unique kinds, axes naming real dimensions, sane minimums, library materials, known shapes", () => {
    assertSameJson(catalogProblems(), [], "catalog problems");
    assertEqual(ELEMENT_KINDS.length, 33, "element kinds");
  });

  await check("the construction type registry lists the six original types and every element kind, and every ribbon category has something to build", () => {
    const registry = constructionTypeRegistry();
    assertEqual(registry.length, 6 + ELEMENT_KINDS.length, "registry size");
    assertSameJson(
      registry.filter((entry) => entry.kind === undefined).map((entry) => entry.command).sort(),
      ["beam.add", "door.add", "pillar.add", "slab.add", "wall.add", "window.add"],
      "original commands"
    );
    for (const definition of ELEMENT_KINDS) {
      const entry = registry.find((candidate) => candidate.kind === definition.kind);
      assertTrue(entry && entry.command === "element.add" && entry.category === definition.category, `${definition.kind} is registered`);
    }
    for (const category of ELEMENT_CATEGORIES) {
      assertTrue(registry.some((entry) => entry.category === category.id), `${category.label} has at least one type`);
    }
  });

  await check("the material library: unique ids, hex colors, sane appearance, and every kind's default material among the ones it suggests", () => {
    const ids = MATERIAL_LIBRARY.map((material) => material.id);
    assertEqual(new Set(ids).size, ids.length, "unique ids");
    for (const material of MATERIAL_LIBRARY) {
      assertTrue(/^#[0-9a-f]{6}$/i.test(material.color), `${material.id} color`);
      assertTrue(material.opacity > 0 && material.opacity <= 1, `${material.id} opacity`);
      assertTrue(material.roughness >= 0 && material.roughness <= 1 && material.metalness >= 0 && material.metalness <= 1, `${material.id} finish`);
    }
    for (const category of ["concrete", "brick", "plaster", "oak", "glass", "steel", "ceramic-tile", "paint", "clay-roof-tile", "pvc", "copper-wire"]) {
      assertTrue(getMaterial(category), `the library has ${category}`);
    }
    assertSameJson(materialsFor([]).map((material) => material.id), ["generic"], "no categories: generic only");
    assertTrue(materialsFor(["plumbing"]).every((material) => material.id === "generic" || material.category === "plumbing"), "filtered by category");
    for (const definition of ELEMENT_KINDS) {
      assertTrue(
        materialsFor(definition.materialCategories).some((material) => material.id === definition.defaultMaterial),
        `${definition.kind}'s default material is one it suggests`
      );
    }
  });

  // --- Every kind, end to end ---

  for (const definition of ELEMENT_KINDS) {
    await check(`${definition.category} / ${definition.kind}: create, validate, select, analyze, update, rename, material, params, resize/move/rotate, duplicate, delete, undo, redo, save/reopen`, () =>
      exerciseKind(definition)
    );
  }

  // --- Rejections ---

  await check("element commands reject invalid input and leave the model untouched", () => {
    const project = createProjectContext();
    const executor = project.commandExecutor;
    const unknown = executor.execute({ type: "element.add", element: { kind: "spaceship" } });
    assertTrue(!unknown.success && JSON.stringify(unknown).includes('Unknown element kind \\"spaceship\\"'), `unknown kind: ${JSON.stringify(unknown)}`);
    const rejected: [string, unknown][] = [
      ["no kind", { type: "element.add", element: {} }],
      ["zero rise", { type: "element.add", element: { kind: "roof", dimensions: { height: 0 } } }],
      ["below the kind's minimum", { type: "element.add", element: { kind: "stair", dimensions: { width: 0.1 } } }],
      ["a dimension the kind doesn't have", { type: "element.add", element: { kind: "roof", dimensions: { depth: 1 } } }],
      ["a material outside the library", { type: "element.add", element: { kind: "roof", material: "unobtainium" } }],
      ["a color that isn't #rrggbb", { type: "element.add", element: { kind: "roof", color: "red" } }],
      ["steps below the minimum", { type: "element.add", element: { kind: "stair", params: { steps: 2 } } }],
      ["fractional steps", { type: "element.add", element: { kind: "stair", params: { steps: 3.5 } } }],
      ["an unknown choice", { type: "element.add", element: { kind: "water-pipe", params: { system: "gas" } } }],
      ["an unknown parameter", { type: "element.add", element: { kind: "water-pipe", params: { pressure: 3 } } }],
      ["a blank label", { type: "element.add", element: { kind: "roof", label: "   " } }],
      ["a non-finite position", { type: "element.add", element: { kind: "roof", position: { x: Number.NaN } } }]
    ];
    for (const [label, command] of rejected) {
      assertTrue(!executor.execute(command).success, `rejected: ${label}`);
    }
    assertEqual(project.elementStore.getAll().length, 0, "nothing was created");
    assertEqual(project.history.canUndo(), false, "and nothing was recorded");

    const id = addElement(project, { kind: "roof" });
    assertTrue(!executor.execute({ type: "element.update", id, changes: { kind: "stair" } }).success, "an element's kind never changes");
    assertTrue(!executor.execute({ type: "element.update", id, changes: { dimensions: { length: -1, height: 1.6, width: 8.6 } } }).success, "negative length");
    assertEqual(project.elementStore.get(id)?.dimensions.length, 10.6, "a rejected update leaves it as it was");
    assertTrue(!executor.execute({ type: "element.delete", id: "roof-999999" }).success, "deleting a missing element fails");

    const wallId = create(project, { type: "wall.add", wall: {} });
    assertTrue(!executor.execute({ type: "update_object", objectId: wallId, changes: { label: "Nope" } }).success, "a label is only editable on elements");
    assertTrue(!executor.execute({ type: "update_object", objectId: wallId, changes: { params: { steps: 3 } } }).success, "params are only editable on elements");

    executor.execute({ type: "element.add", element: JSON.parse('{"kind":"pump","dimensions":{"__proto__":{"polluted":1}}}') });
    assertEqual(({} as Record<string, unknown>).polluted, undefined, "__proto__ in dimensions never reaches Object.prototype");

    const store = new ElementStore();
    const record = createElementData({ kind: "tree" });
    assertTrue(store.add(record).valid, "the first add");
    assertTrue(!store.add(record).valid, "a duplicate id is rejected");
  });

  // --- Openings hosted by walls ---

  await check("doors and windows can belong to a wall: in it, turned with it, hostId and placement kept through save/reopen, gone with the wall", () => {
    const wall = { position: { x: 0, y: 1.5, z: 0 }, rotation: Math.PI / 2, dimensions: { length: 4, height: 3, thickness: 0.2 } };
    const door = hostedTransform(wall, { width: 0.9, height: 2.1, thickness: 0.05 }, { offset: 0, sill: 0 });
    assertClose(door.position.x, 0, "centered in the wall's thickness");
    assertClose(door.position.y, 1.05, "on the wall's base");
    assertClose(door.position.z, 0, "centered along the wall");
    assertClose(door.rotation, Math.PI / 2, "turned with the wall");
    const window = hostedTransform(wall, { width: 0.9, height: 1.2, thickness: 0.05 }, { offset: 1, sill: WINDOW_SILL_HEIGHT });
    assertClose(window.position.z, -1, "1 m along a wall turned 90 degrees is 1 m toward -Z");
    assertClose(window.position.y, WINDOW_SILL_HEIGHT + 0.6, "at sill height");

    const project = createProjectContext();
    const wallId = create(project, { type: "wall.add", wall: {} });
    const doorId = create(project, { type: "door.add", door: { hostId: wallId } });
    assertEqual(project.doorStore.get(doorId)?.hostId, wallId, "hostId stored");
    assertSameJson(project.doorStore.get(doorId)?.hostPlacement, { offset: 0, sill: 0 }, "a door goes in at the wall's center, on its base");
    succeed(project, { type: "door.update", id: doorId, changes: { hostPlacement: { offset: 0.5, sill: 0 } } });
    assertEqual(project.doorStore.get(doorId)?.hostId, wallId, "placing it keeps the host");
    const freeWindow = create(project, { type: "window.add", window: {} });
    assertEqual(project.windowStore.get(freeWindow)?.hostId, null, "free-standing by default");
    const copy = create(project, { type: "door.duplicate", id: doorId });
    assertEqual(project.doorStore.get(copy)?.hostId, null, "a duplicate is free-standing");

    const saved = JSON.parse(JSON.stringify(serializeProject(project)));
    const reopened = createProjectContext();
    assertTrue(loadProject(reopened, saved).ok, "reopens");
    assertEqual(reopened.doorStore.get(doorId)?.hostId, wallId, "the host survives save/reopen");

    const bad = JSON.parse(JSON.stringify(saved));
    bad.objects.find((object: { id: string }) => object.id === doorId).hostId = "wall-999999";
    const parsed = parseProjectDocument(bad);
    assertTrue(!parsed.ok && parsed.error.includes("is not a wall"), `a document naming a missing host is rejected (${parsed.ok ? "accepted" : parsed.error})`);

    succeed(project, { type: "wall.delete", id: wallId });
    assertEqual(project.doorStore.get(doorId), undefined, "deleting the wall deletes the door in it");
    project.history.undo();
    assertEqual(project.doorStore.get(doorId)?.hostId, wallId, "and one undo brings both back, still hosted");

    assertTrue(!validateDoor({ ...createDoorData(), hostId: "" }).valid, "a blank hostId is invalid");
    assertTrue(validateDoor({ ...createDoorData(), hostId: null }).valid, "null is free-standing");
  });

  // --- Rooms ---

  await check("rooms: the six presets, floor area, and which objects stand in a room (rotation included)", () => {
    assertSameJson(
      ROOM_PRESETS.map((preset) => preset.name),
      ["Living Room", "Kitchen", "Master Bedroom", "Bedroom", "Bathroom", "Dining Room"],
      "presets"
    );
    const project = createProjectContext();
    for (const preset of ROOM_PRESETS) {
      const id = addElement(project, roomPresetOptions(preset, { x: -20, z: 0 }));
      const room = project.elementStore.get(id);
      assertTrue(room && isRoom(room), `${preset.name} is a room`);
      assertEqual(room.label, preset.name, `${preset.name} name`);
      assertClose(roomArea(room), Math.round(preset.length * preset.width * 100) / 100, `${preset.name} area`);
    }

    const bathroomId = addElement(project, roomPresetOptions(ROOM_PRESETS[4], { x: 10, z: 0 }));
    const inside = addElement(project, { kind: "toilet", position: { x: 10.5, z: 0.5 } });
    const outside = addElement(project, { kind: "sink", position: { x: 12, z: 0 } });
    const above = addElement(project, { kind: "light", position: { x: 10, y: 5, z: 0 } });
    const bathroom = project.elementStore.get(bathroomId);
    assertTrue(bathroom, "bathroom");
    const contents = objectsInRoom(bathroom, allObjects(project));
    assertTrue(contents.includes(inside), "the toilet is in the bathroom");
    assertTrue(!contents.includes(outside), "the sink outside it isn't");
    assertTrue(!contents.includes(above), "a light above the ceiling isn't");
    assertTrue(contents.every((id) => !isRoom(project.elementStore.get(id) ?? {})), "rooms never contain rooms");

    succeed(project, { type: "element.update", id: bathroomId, changes: { rotation: Math.PI / 2 } });
    const turned = project.elementStore.get(bathroomId);
    assertTrue(turned, "turned bathroom");
    assertTrue(isInsideRoom(turned, { x: 10, z: 1.1 }), "turned 90 degrees, its 2.4 m length runs along Z");
    assertTrue(!isInsideRoom(turned, { x: 11.1, z: 0 }), "and its 2 m width along X");
  });

  // --- Finishes and materials ---

  await check("paint: a painted wall or element is the same object - same id, size, and place - and one undo unpaints it", () => {
    const project = createProjectContext();
    const wallId = create(project, { type: "wall.add", wall: {} });
    const wallBefore = project.wallStore.get(wallId);
    succeed(project, { type: "update_object", objectId: wallId, changes: { material: "paint", color: "#88aa66" } });
    const painted = project.wallStore.get(wallId);
    assertTrue(wallBefore && painted, "the wall still exists");
    assertEqual(painted.material, "paint", "material");
    assertEqual(painted.color, "#88aa66", "color");
    assertSameJson(painted.dimensions, wallBefore.dimensions, "same size");
    assertSameJson(painted.position, wallBefore.position, "same place");
    project.history.undo();
    assertEqual(project.wallStore.get(wallId)?.material, wallBefore.material, "undo unpaints it");

    const sofa = addElement(project, { kind: "sofa" });
    succeed(project, { type: "update_object", objectId: sofa, changes: { material: "leather", color: "#6b4226" } });
    assertEqual(project.elementStore.get(sofa)?.material, "leather", "an element takes a library material");
    assertTrue(!project.commandExecutor.execute({ type: "update_object", objectId: sofa, changes: { material: "Velvet" } }).success, "but not free text");
    succeed(project, { type: "wall.update", id: wallId, changes: { material: "Exposed brick" } });
    assertEqual(project.wallStore.get(wallId)?.material, "Exposed brick", "the six original types still accept free-text materials");

    const flooring = addElement(project, { kind: "flooring", position: { x: 0, y: 0.21, z: 0 }, dimensions: { length: 5, width: 4 } });
    assertClose(project.elementStore.get(flooring)?.position.y ?? NaN, 0.21, "a flooring laid on a 0.2 m slab");
  });

  // --- AI ---

  await check("the AI layer sees elements and can create them: snapshot, backend sanitizer, mock provider vocabulary, one-step pipeline, and the house builder", async () => {
    const project = createProjectContext();
    const kitchen = addElement(project, { kind: "room", label: "Kitchen" });
    const snapshot = buildAIProjectSnapshot(project);
    const listed = snapshot.objects.find((object) => object.id === kitchen);
    assertTrue(listed, "the snapshot lists the element");
    assertEqual(listed.type, "element", "type");
    assertEqual(listed.kind, "room", "kind");
    assertEqual(listed.label, "Kitchen", "label");

    const sanitized = parseAIProjectSnapshot(JSON.parse(JSON.stringify(snapshot)));
    assertTrue(sanitized.ok && sanitized.snapshot.objects[0].kind === "room", "the backend sanitizer accepts it");
    const tampered = JSON.parse(JSON.stringify(snapshot));
    tampered.objects[0].kind = "spaceship";
    assertTrue(!parseAIProjectSnapshot(tampered).ok, "and rejects an unknown kind");

    // The exact browser -> backend path: AICommandPipeline builds the
    // context, BackendAIProvider sends it as JSON, and the backend parses
    // it with parseAIProjectContext() - which rebuilds the context itself.
    const sent = JSON.parse(JSON.stringify(buildAIProjectContext(snapshot)));
    assertEqual(sent.objects[0].kind, "room", "the context the browser sends keeps the element's kind");
    const received = parseAIProjectContext(sent);
    assertTrue(received.ok, `the backend accepts the browser's context (${received.ok ? "" : received.error})`);
    const receivedRoom = received.context.objects.find((object) => object.id === kitchen);
    assertEqual(receivedRoom?.kind, "room", "and the provider sees its kind");
    assertEqual(receivedRoom?.label, "Kitchen", "and its label");
    assertEqual(received.context.geometry.invalidObjects.length, 0, "and the server-side geometry covers it");

    const mock = new MockAIProvider();
    const request = (instruction: string) => ({
      instruction,
      projectContext: buildAIProjectContext(buildAIProjectSnapshot(project)),
      availableObjectTypes: AI_SUPPORTED_OBJECT_TYPES
    });
    assertSameJson(
      mock.interpret(request("Add a roof, add a water pipe; add a boundary wall and a light switch")).commands,
      [
        { type: "element.add", element: { kind: "roof" } },
        { type: "element.add", element: { kind: "water-pipe" } },
        { type: "element.add", element: { kind: "boundary-wall" } },
        { type: "element.add", element: { kind: "switch" } }
      ],
      "element keywords, the longest and earliest winning"
    );
    assertSameJson(mock.interpret(request("Add a wall around the garden")).commands, [{ type: "wall.add", wall: {} }], "a wall is still a wall");

    const pipeline = new AICommandPipeline(mock, project.commandExecutor, project.history);
    const result = await pipeline.run("Add a sofa and a table", buildAIProjectSnapshot(project));
    assertTrue(result.success, `the pipeline creates them: ${JSON.stringify(result)}`);
    const kinds = project.elementStore.getAll().map((element) => element.kind);
    assertTrue(kinds.includes("sofa") && kinds.includes("table"), "real elements");
    project.history.undo();
    assertSameJson(project.elementStore.getAll().map((element) => element.kind), ["room"], "one AI response is one undo step");

    const house = await pipeline.run("Build a simple house on a 10m x 8m footprint", buildAIProjectSnapshot(project));
    assertTrue(house.success, `the AI house builder still works: ${JSON.stringify(house.errors)}`);
    // 4 exterior + 4 interior (the default 5-room layout: see houseDesign.ts) - the deterministic house planner, not this mock provider, decides the room layout.
    assertEqual(project.wallStore.getAll().length, 8, "eight walls");
  });

  // --- Ribbon ---

  await check("the ribbon has no dead buttons: every catalog kind is on its category's tab, and every tool runs exactly one action", () => {
    const calls: string[] = [];
    let paintable = false;
    const actions: RibbonActions = {
      addWall: () => void calls.push("wall"),
      addPillar: () => void calls.push("pillar"),
      addBeam: () => void calls.push("beam"),
      addSlab: () => void calls.push("slab"),
      addDoor: () => void calls.push("door"),
      addWindow: () => void calls.push("window"),
      addElement: (kind) => void calls.push(`element:${kind}`),
      addRoom: (preset) => void calls.push(`room:${preset.name}`),
      paintSelected: (color) => void calls.push(`paint:${color}`),
      canPaintSelection: () => paintable,
      isPlacementActive: () => false
    };
    const tabs = buildRibbonTabs(actions);
    assertSameJson(
      tabs.map((tab) => tab.id),
      ["home", ...ELEMENT_CATEGORIES.map((category) => category.id)],
      "Home, then one tab per category"
    );
    for (const definition of ELEMENT_KINDS) {
      const tab = tabs.find((candidate) => candidate.id === definition.category);
      assertTrue(tab && tab.tools.some((tool) => tool.id === definition.kind), `${definition.kind} is on the ${definition.category} tab`);
    }
    for (const tab of tabs) {
      assertTrue(tab.tools.length > 0, `${tab.id} has tools`);
      const ids = tab.tools.map((tool) => tool.id);
      assertEqual(new Set(ids).size, ids.length, `${tab.id}: unique tools`);
      for (const tool of tab.tools) {
        calls.length = 0;
        tool.run(tool.colorInput?.initial);
        assertEqual(calls.length, 1, `${tab.id}/${tool.id} runs exactly one action`);
      }
    }
    const paint = tabs.find((tab) => tab.id === "finish")?.tools.find((tool) => tool.id === "paint");
    assertTrue(paint && paint.isEnabled, "Paint is on the Finish tab");
    assertEqual(paint.isEnabled(), false, "disabled with nothing to paint");
    paintable = true;
    assertEqual(paint.isEnabled(), true, "enabled once something is selected");
  });

  // --- The complete house ---

  await check("complete house: every category, built only through commands - unique ids, all valid, geometry analyzed, rooms and assemblies referencing real objects, identical after save/reopen", () => {
    const project = createProjectContext();
    const place = (kind: string, options: Omit<CreateElementOptions, "kind"> = {}): string => addElement(project, { kind, ...options });

    // Structure: foundation, then the AI house plan's slab, pillars, walls, door and windows, a roof and a stair.
    place("foundation");
    for (const command of buildSimpleHousePlan({ length: 10, width: 8 })) {
      create(project, command);
    }
    const walls = project.wallStore.getAll();
    assertEqual(walls.length, 4, "four perimeter walls");
    const frontWall = walls.reduce((a, b) => (b.position.z > a.position.z ? b : a));
    const sideWall = walls.reduce((a, b) => (b.position.x > a.position.x ? b : a));
    place("roof");
    place("stair", { position: { x: -3.6, z: -0.8 } });

    // Openings: a window in the east wall, a door and a window in the front wall - each one command.
    const hostedWindow = create(project, { type: "window.add", window: { hostId: sideWall.id, offset: -1.5, sill: WINDOW_SILL_HEIGHT } });
    const hostedDoor = create(project, { type: "door.add", door: { hostId: frontWall.id, offset: 3 } });
    const frontWindow = create(project, { type: "window.add", window: { hostId: frontWall.id, offset: -2.5 } });

    // Rooms, each with a floor finish on the slab; one ceiling; a painted wall.
    const roomAt: Record<string, { x: number; z: number }> = {
      "Living Room": { x: -2.4, z: 1.6 },
      Kitchen: { x: 3.1, z: 2.4 },
      "Master Bedroom": { x: -2.8, z: -2 },
      Bedroom: { x: 0.5, z: -2.3 },
      Bathroom: { x: 3.7, z: -2.9 },
      "Dining Room": { x: 3, z: -0.1 }
    };
    const roomIds: Record<string, string> = {};
    for (const preset of ROOM_PRESETS) {
      const at = roomAt[preset.name];
      roomIds[preset.name] = create(project, { type: "element.add", element: roomPresetOptions(preset, at) });
      place("flooring", { position: { x: at.x, y: 0.21, z: at.z }, dimensions: { length: preset.length, width: preset.width } });
    }
    place("ceiling", { dimensions: { length: 9.6, width: 7.6 } });
    succeed(project, { type: "update_object", objectId: frontWall.id, changes: { material: "paint", color: "#e8dcc8" } });

    // Plumbing: tank and pump outside, supply and drain runs of connected segments, and the bathroom fixtures.
    place("water-tank", { position: { x: 6.5, z: -3 } });
    place("pump", { position: { x: 6.5, z: -1.6 } });
    const supplyA = place("water-pipe", { position: { x: 5.6, y: 0.3, z: -2.4 }, params: { system: "cold" } });
    const supplyB = place("water-pipe", { position: { x: 8.7, y: 0.3, z: -2.4 }, params: { system: "cold" } });
    const drainA = place("drain-pipe", { position: { x: 4, z: -4.6 } });
    const drainB = place("drain-pipe", { position: { x: 7.1, z: -4.6 } });
    // 0.1 m apart: element.connect snaps the first segment's end onto the second's start.
    succeed(project, { type: "element.connect", from: { id: supplyA, endpoint: "end" }, to: { id: supplyB, endpoint: "start" } });
    succeed(project, { type: "element.connect", from: { id: drainA }, to: { id: drainB } });
    const fixtures = [
      place("sink", { position: { x: 3, z: -2.3 } }),
      place("toilet", { position: { x: 4.2, z: -3.4 } }),
      place("shower", { position: { x: 4.3, z: -2.4 } }),
      place("tap", { position: { x: 3, z: -2.45 } })
    ];

    // Electrical.
    place("distribution-board", { position: { x: -4.7, z: 3.7 } });
    const conduitA = place("conduit", { position: { x: 0, z: 0 } });
    const conduitB = place("conduit", { position: { x: 3.05, z: 0 } });
    const cableA = place("cable", { position: { x: 0, z: 1 } });
    const cableB = place("cable", { position: { x: -3.05, z: 1 } });
    succeed(project, { type: "element.connect", from: { id: conduitA }, to: { id: conduitB } });
    succeed(project, { type: "element.connect", from: { id: cableB, endpoint: "end" }, to: { id: cableA, endpoint: "start" } });
    place("switch", { position: { x: -0.5, z: 3.85 } });
    place("socket", { position: { x: -3, z: 3.85 } });
    place("light", { position: { x: -2.4, z: 1.6 } });

    // Interior.
    place("bed", { position: { x: -2.8, z: -2 } });
    place("wardrobe", { position: { x: -4.3, z: -3.2 } });
    place("table", { position: { x: 3, z: -0.1 } });
    place("chair", { position: { x: 3, z: 0.6 } });
    place("sofa", { position: { x: -2.4, z: 2.8 } });
    place("kitchen-cabinet", { position: { x: 4.3, z: 3.4 } });
    place("kitchen-counter", { position: { x: 2.6, z: 3.4 } });

    // Exterior: the plot, a path to the door, a boundary wall with a gate gap, planting.
    place("landscape");
    place("path", { position: { x: 0, z: 6 }, rotation: Math.PI / 2, dimensions: { length: 4 } });
    place("boundary-wall", { position: { x: -5.4, z: 8 }, dimensions: { length: 9.2 } });
    place("boundary-wall", { position: { x: 5.4, z: 8 }, dimensions: { length: 9.2 } });
    place("boundary-wall", { position: { x: 0, z: -8 }, dimensions: { length: 20 } });
    place("boundary-wall", { position: { x: -10, z: 0 }, rotation: Math.PI / 2, dimensions: { length: 16 } });
    place("boundary-wall", { position: { x: 10, z: 0 }, rotation: Math.PI / 2, dimensions: { length: 16 } });
    place("gate", { position: { x: 0, z: 8 } });
    place("tree", { position: { x: -7, z: 5 } });
    place("plant", { position: { x: 2, z: 5 } });

    // An assembly referencing the bathroom and its fixtures.
    const assemblyId = create(project, { type: "assembly.create", assembly: { name: "Bathroom" } });
    for (const objectId of [roomIds.Bathroom, ...fixtures]) {
      succeed(project, { type: "assembly.addObject", assemblyId, objectId });
    }

    const everything = allObjects(project);
    const ids = everything.map((object) => object.id);
    assertEqual(new Set(ids).size, ids.length, "every id is unique");

    const categoryOf = (object: (typeof everything)[number]): string =>
      object.type === "element"
        ? getElementKind(object.kind)?.category ?? "unknown"
        : object.type === "door" || object.type === "window"
          ? "openings"
          : "structure";
    assertSameJson(
      [...new Set(everything.map(categoryOf))].sort(),
      ELEMENT_CATEGORIES.map((category) => category.id).sort(),
      "all eight categories are in the house"
    );
    const presentKinds = new Set(project.elementStore.getAll().map((element) => element.kind));
    for (const definition of ELEMENT_KINDS) {
      assertTrue(presentKinds.has(definition.kind), `the house has a ${definition.kind}`);
    }

    for (const element of project.elementStore.getAll()) {
      const validation = validateElement(element);
      assertTrue(validation.valid, `${element.id} validates: ${JSON.stringify(validation.errors)}`);
    }
    const saved = JSON.parse(JSON.stringify(serializeProject(project)));
    const parsed = parseProjectDocument(saved);
    assertTrue(parsed.ok, `every object passes its own validator in the saved document (${parsed.ok ? "" : parsed.error})`);

    const snapshot = buildAIProjectSnapshot(project);
    const analysis = analyzeConstructionGeometry(snapshot);
    assertEqual(analysis.invalidObjects.length, 0, "no invalid geometry");
    assertEqual(analysis.objects.length, everything.length, "the geometry analysis describes every object");
    assertTrue(parseAIProjectSnapshot(JSON.parse(JSON.stringify(snapshot))).ok, "the backend sanitizer accepts the whole house");

    const read = createStoreObjectReader(storesOf(project));
    for (const id of ids) {
      assertTrue(read(id), `ProjectContext resolves ${id}`);
    }

    const bathroom = project.elementStore.get(roomIds.Bathroom);
    assertTrue(bathroom, "bathroom");
    const inBathroom = objectsInRoom(bathroom, everything);
    for (const fixture of fixtures) {
      assertTrue(inBathroom.includes(fixture), `${fixture} stands in the bathroom`);
    }
    const members = snapshot.assemblies.find((assembly) => assembly.id === assemblyId)?.objectIds ?? [];
    assertSameJson([...members].sort(), [roomIds.Bathroom, ...fixtures].sort(), "the assembly references the bathroom and its fixtures");
    assertTrue(
      snapshot.objects.filter((object) => object.assemblyIds.includes(assemblyId)).length === fixtures.length + 1,
      "and the snapshot marks each member"
    );

    assertEqual(project.windowStore.get(hostedWindow)?.hostId, sideWall.id, "the window belongs to the east wall");
    assertEqual(project.doorStore.get(hostedDoor)?.hostId, frontWall.id, "the door belongs to the front wall");
    assertEqual(project.windowStore.get(frontWindow)?.hostId, frontWall.id, "and so does the front window");

    // Relationships: every hosted opening fits its wall, every connection meets.
    assertEqual(analysis.hosts.length, 3, "three hosted openings");
    assertTrue(analysis.hosts.every((host) => host.valid), `every host relationship is valid: ${JSON.stringify(analysis.hosts)}`);
    assertEqual(analysis.connections.length, 4, "four connections: supply, drain, conduit, cable");
    assertTrue(analysis.connections.every((connection) => connection.valid), `every connection is valid: ${JSON.stringify(analysis.connections)}`);
    for (const [a, b] of [[supplyA, supplyB], [drainA, drainB], [conduitA, conduitB], [cableB, cableA]]) {
      assertTrue(project.elementStore.get(a)?.connections.some((connection) => connection.objectId === b), `${a} is connected to ${b}`);
    }
    assertEqual(project.wallStore.get(frontWall.id)?.material, "paint", "the front wall is painted - and still the same wall");

    const reopened = createProjectContext();
    const loaded = loadProject(reopened, saved);
    assertTrue(loaded.ok, `the house reopens (${loaded.ok ? "" : loaded.error})`);
    assertSameJson(serializeProject(reopened), serializeProject(project), "identical after save/reopen");
    assertEqual(reopened.history.canUndo(), false, "a reopened house starts with nothing to undo");
  });

  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) {
    throw new Error(`${failed} verification check(s) failed`);
  }
}

await run();
