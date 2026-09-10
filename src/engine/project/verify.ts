/**
 * Verification for project persistence: the project document, its
 * validation, the repositories, loading (hydration) into the real
 * ProjectContext, and the Save/Open controller. Same approach as every
 * other verify.ts in this project: no test framework, plain assertion
 * helpers, run directly by Node. Run with:
 *   npm run verify
 *
 * Like the end-to-end suite, this runs with
 * `--experimental-transform-types`, because it drives the REAL
 * ProjectContext - real stores, real *HistoryController classes, the real
 * shared HistoryManager - whose controllers use TypeScript
 * parameter-property constructors (see ai/e2e/verify.ts's header).
 *
 * Every model is built through CommandExecutor, the way the UI builds
 * one, and every load goes through loadProject(). Nothing here makes a
 * network call: the HTTP client is exercised with a mock transport, and
 * backend/verify.ts runs it against the real server.
 *
 * Explicit .ts extensions below are required for Node to resolve these
 * relative imports (see allowImportingTsExtensions in tsconfig.json).
 */
import { clearProject, createProjectContext, loadProject, serializeProject } from "./ProjectContext.ts";
import type { PersistableProject, ProjectContext } from "./ProjectContext.ts";
import { PROJECT_DOCUMENT_VERSION, parseProjectDocument } from "./projectDocument.ts";
import type { ProjectDocument } from "./projectDocument.ts";
import { InMemoryProjectRepository } from "./InMemoryProjectRepository.ts";
import { HttpProjectRepository } from "./HttpProjectRepository.ts";
import type { ProjectFetch, ProjectHttpResponse } from "./HttpProjectRepository.ts";
import { ProjectNotFoundError, ProjectValidationError } from "./ProjectRepository.ts";
import type { ProjectInput, ProjectRecord, ProjectRepository, ProjectSummary } from "./ProjectRepository.ts";
import { ProjectPersistenceController } from "./ProjectPersistenceController.ts";
import { DEFAULT_PROJECT_NAME } from "./ProjectMetaStore.ts";

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
    throw new Error(`${message}:\n  expected ${expectedJson}\n  got      ${actualJson}`);
  }
}

async function assertRejects(fn: () => Promise<unknown>, check: (error: unknown) => boolean, message: string): Promise<void> {
  try {
    await fn();
  } catch (error) {
    assertTrue(check(error), `${message}: unexpected error ${String(error)}`);
    return;
  }
  throw new Error(`${message}: expected a rejection`);
}

function execute(context: ProjectContext, command: Record<string, unknown>): string {
  const result = context.commandExecutor.execute(command);
  assertTrue(result.success && result.objectId, `${String(command.type)} should succeed: ${result.message}`);
  return result.objectId;
}

/** All six object types plus an assembly - built through CommandExecutor, as the UI and the AI build them. */
function buildSampleProject(context: ProjectContext) {
  const wall = execute(context, {
    type: "wall.add",
    wall: { length: 6.5, height: 3, thickness: 0.25, rotation: Math.PI / 2, position: { x: 1.5, y: 1.5, z: -2 }, material: "brick", color: "#aa5533" }
  });
  const pillar = execute(context, { type: "pillar.add", pillar: { width: 0.5, depth: 0.45, position: { x: 4, z: 1 }, material: "steel" } });
  const beam = execute(context, { type: "beam.add", beam: { length: 5, position: { x: 0, y: 3, z: 3 } } });
  const slab = execute(context, { type: "slab.add", slab: { length: 10, width: 8, material: "concrete" } });
  const door = execute(context, { type: "door.add", door: { position: { x: 0, z: -4 }, color: "#654321" } });
  const windowId = execute(context, { type: "window.add", window: { rotation: 0.3, position: { x: 2, y: 1.5, z: 4 } } });
  const assembly = execute(context, { type: "assembly.create", assembly: { name: "Ground Floor", description: "Level 0" } });
  for (const objectId of [wall, door, windowId]) {
    execute(context, { type: "assembly.addObject", assemblyId: assembly, objectId });
  }
  return { wall, pillar, beam, slab, door, window: windowId, assembly, objects: [wall, pillar, beam, slab, door, windowId] };
}

/** Every object and assembly exactly as the stores hold them. */
function modelJson(context: PersistableProject): string {
  return JSON.stringify({
    objects: [
      ...context.wallStore.getAll(),
      ...context.pillarStore.getAll(),
      ...context.beamStore.getAll(),
      ...context.slabStore.getAll(),
      ...context.doorStore.getAll(),
      ...context.windowStore.getAll()
    ],
    assemblies: context.assemblyStore.getAll()
  });
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** A clock that moves one second per call, and sequential ids - deterministic repositories for tests. */
function testRepository(): InMemoryProjectRepository {
  let tick = 0;
  let id = 0;
  return new InMemoryProjectRepository({
    now: () => new Date(Date.UTC(2026, 0, 1, 12, 0, tick++)),
    newId: () => `project-${++id}`
  });
}

function makeDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function jsonResponse(status: number, body: unknown): ProjectHttpResponse {
  const serialized = JSON.stringify(body);
  return { ok: status >= 200 && status < 300, status, json: async () => JSON.parse(serialized) };
}

type FetchCall = { url: string; method: string; body: unknown };

function mockFetch(handler: (call: FetchCall) => ProjectHttpResponse | Promise<ProjectHttpResponse>): ProjectFetch & { calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetchImpl: ProjectFetch = async (url, init) => {
    const call = { url, method: init.method, body: init.body === undefined ? undefined : JSON.parse(init.body) };
    calls.push(call);
    return handler(call);
  };
  return Object.assign(fetchImpl, { calls });
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

  console.log("Project persistence verification\n");

  // --- The document ---

  await check("a new project is empty and serializes to an empty version-1 document", () => {
    const context = createProjectContext();
    assertSameJson(serializeProject(context), { version: PROJECT_DOCUMENT_VERSION, objects: [], assemblies: [] }, "document");
    assertEqual(context.projectMeta.get().name, DEFAULT_PROJECT_NAME, "an untitled project");
    assertEqual(context.projectMeta.get().id, null, "not saved yet");
  });

  await check("serializing captures all six object types exactly as the stores hold them, and the assembly", () => {
    const context = createProjectContext();
    const sample = buildSampleProject(context);

    const document = serializeProject(context);
    assertSameJson(
      document.objects.map((object) => object.type),
      ["wall", "pillar", "beam", "slab", "door", "window"],
      "one object of each type"
    );
    assertSameJson(document.objects, JSON.parse(modelJson(context)).objects, "every field of every object, identical to its store record");
    assertEqual(document.assemblies.length, 1, "one assembly");
    assertEqual(document.assemblies[0].name, "Ground Floor", "assembly name");
    assertEqual(document.assemblies[0].description, "Level 0", "assembly description");
    assertSameJson(document.assemblies[0].objectIds, [sample.wall, sample.door, sample.window], "assembly members, in order");
  });

  await check("the document is JSON-safe and deserializes back to itself", () => {
    const context = createProjectContext();
    buildSampleProject(context);
    const document = serializeProject(context);

    const json = JSON.stringify(document);
    const roundTripped = JSON.parse(json) as unknown;
    assertEqual(JSON.stringify(roundTripped), json, "a JSON round trip changes nothing - no functions, undefined, NaN, or class instances");
    const parsed = parseProjectDocument(roundTripped);
    assertTrue(parsed.ok, `the round-tripped document is valid: ${parsed.ok ? "" : parsed.error}`);
    assertEqual(JSON.stringify(parsed.document), json, "and parses back to the same document");
  });

  await check("an assembly's deleted members aren't saved - with no undo history to bring them back, they'd be dangling references", () => {
    const context = createProjectContext();
    const sample = buildSampleProject(context);
    execute(context, { type: "wall.delete", id: sample.wall });
    assertTrue(context.assemblyStore.get(sample.assembly)?.objectIds.includes(sample.wall), "precondition: the store still lists the deleted wall");

    const document = serializeProject(context);
    assertSameJson(document.assemblies[0].objectIds, [sample.door, sample.window], "only live members are written");
    assertTrue(parseProjectDocument(document).ok, "so the document is valid");
  });

  // --- Repository ---

  await check("InMemoryProjectRepository: create, get, list and save a project", async () => {
    const context = createProjectContext();
    buildSampleProject(context);
    const document = serializeProject(context);
    const repository = testRepository();

    const created = await repository.create({ name: "My 2 Bedroom House", document });
    assertEqual(created.id, "project-1", "a new id");
    assertEqual(created.name, "My 2 Bedroom House", "the name");
    assertEqual(created.createdAt, "2026-01-01T12:00:00.000Z", "createdAt");
    assertEqual(created.updatedAt, created.createdAt, "updatedAt starts at createdAt");
    assertSameJson(created.document, document, "the document");

    assertSameJson(await repository.get("project-1"), created, "get returns what was stored");
    assertEqual(await repository.get("project-99"), null, "an unknown id is null");

    const other = await repository.create({ name: "Garage", document: serializeProject(createProjectContext()) });
    execute(context, { type: "wall.add", wall: {} });
    const saved = await repository.save("project-1", { name: "My 2 Bedroom House (v2)", document: serializeProject(context) });
    assertEqual(saved.createdAt, created.createdAt, "save keeps createdAt");
    assertTrue(saved.updatedAt > created.updatedAt, "and moves updatedAt forward");
    assertEqual(saved.document.objects.length, 7, "the new document");

    const list: ProjectSummary[] = await repository.list();
    assertSameJson(
      list.map((summary) => [summary.id, summary.name, summary.objectCount, summary.assemblyCount]),
      [
        ["project-1", "My 2 Bedroom House (v2)", 7, 1],
        [other.id, "Garage", 0, 0]
      ],
      "summaries, most recently updated first"
    );
  });

  await check("InMemoryProjectRepository validates every write, reports a missing project, and hands out copies", async () => {
    const repository = testRepository();
    const document = serializeProject(createProjectContext());

    await assertRejects(() => repository.create({ name: "   ", document }), (error) => error instanceof ProjectValidationError, "blank name");
    await assertRejects(
      () => repository.create({ name: "Bad", document: { ...document, version: 2 } as unknown as ProjectDocument }),
      (error) => error instanceof ProjectValidationError && error.message.includes("version"),
      "invalid document"
    );
    await assertRejects(() => repository.save("project-404", { name: "X", document }), (error) => error instanceof ProjectNotFoundError, "missing project");

    const created = await repository.create({ name: "Original", document });
    created.name = "tampered";
    (created.document.objects as unknown[]).push("junk");
    const stored = await repository.get(created.id);
    assertEqual(stored?.name, "Original", "mutating a returned record doesn't touch the stored one");
    assertEqual(stored?.document.objects.length, 0, "nor its document");
  });

  // --- Loading ---

  await check("save -> load into another workspace restores every object with its id, dimensions, position, rotation, material and color, and the assembly", async () => {
    const source = createProjectContext();
    buildSampleProject(source);
    const repository = testRepository();
    const record = await repository.create({ name: "Sample", document: serializeProject(source) });

    const target = createProjectContext();
    const loaded = await repository.get(record.id);
    assertTrue(loaded, "loaded from the repository");
    const result = loadProject(target, loaded.document);

    assertTrue(result.ok, `load succeeds: ${result.ok ? "" : result.error}`);
    assertEqual(modelJson(target), modelJson(source), "the restored model is identical - same ids, same values, same assembly");
    assertEqual(target.history.canUndo(), false, "nothing to undo after a load");
    assertEqual(target.history.canRedo(), false, "nothing to redo either");
    assertEqual(target.selectionStore.get(), null, "nothing selected");
  });

  await check("loading replaces what was there before, and clears its selection and history", () => {
    const source = createProjectContext();
    buildSampleProject(source);
    const document = serializeProject(source);

    const target = createProjectContext();
    const leftover = execute(target, { type: "pillar.add", pillar: {} });
    execute(target, { type: "assembly.create", assembly: { name: "Old" } });
    target.selectionStore.select(leftover);
    assertTrue(target.history.canUndo(), "precondition: the target has history");

    assertTrue(loadProject(target, document).ok, "load succeeds");
    assertEqual(target.pillarStore.get(leftover), undefined, "the old objects are gone");
    assertEqual(modelJson(target), modelJson(source), "only the loaded model remains");
    assertEqual(target.selectionStore.get(), null, "selection cleared");
    assertEqual(target.history.canUndo(), false, "history cleared");
  });

  // --- Validation ---

  const validContext = createProjectContext();
  const validSample = buildSampleProject(validContext);
  const validDocument = serializeProject(validContext);

  type Mutator = (document: Record<string, any>) => unknown;
  const invalidDocuments: { name: string; mutate: Mutator; error: string }[] = [
    { name: "not an object", mutate: () => "a project", error: "must be an object" },
    { name: "null", mutate: () => null, error: "must be an object" },
    { name: "an unknown version", mutate: (doc) => ({ ...doc, version: 2 }), error: "Unsupported project document version" },
    { name: "objects not an array", mutate: (doc) => ({ ...doc, objects: {} }), error: '"objects" must be an array' },
    { name: "assemblies missing", mutate: (doc) => ({ version: doc.version, objects: doc.objects }), error: '"assemblies" must be an array' },
    { name: "an object that isn't an object", mutate: (doc) => ({ ...doc, objects: [...doc.objects, 42] }), error: "must be an object" },
    {
      name: "an unknown object type",
      mutate: (doc) => ({ ...doc, objects: [...doc.objects, { ...doc.objects[0], id: "roof-1", type: "roof" }] }),
      error: "is not a supported object type"
    },
    {
      name: "a duplicate object id",
      mutate: (doc) => ({ ...doc, objects: [...doc.objects, { ...doc.objects[0] }] }),
      error: "duplicate object id"
    },
    {
      name: "a malformed object id",
      mutate: (doc) => ({ ...doc, objects: [{ ...doc.objects[0], id: "wall-01; DROP TABLE" }, ...doc.objects.slice(1)] }),
      error: 'the id must look like "wall-<number>"'
    },
    {
      name: "an id of the wrong type",
      mutate: (doc) => ({ ...doc, objects: [{ ...doc.objects[0], id: "pillar-900" }, ...doc.objects.slice(1)] }),
      error: 'the id must look like "wall-<number>"'
    },
    {
      name: "a zero dimension",
      mutate: (doc) => ({ ...doc, objects: [{ ...doc.objects[0], dimensions: { ...doc.objects[0].dimensions, length: 0 } }, ...doc.objects.slice(1)] }),
      error: "dimensions.length must be a finite number greater than 0"
    },
    {
      name: "a negative dimension",
      mutate: (doc) => ({ ...doc, objects: [doc.objects[0], { ...doc.objects[1], dimensions: { ...doc.objects[1].dimensions, height: -2 } }, ...doc.objects.slice(2)] }),
      error: "dimensions.height must be a finite number greater than 0"
    },
    {
      name: "a missing dimension",
      mutate: (doc) => ({ ...doc, objects: [{ ...doc.objects[0], dimensions: { length: 4, height: 3 } }, ...doc.objects.slice(1)] }),
      error: "dimensions.thickness must be a finite number greater than 0"
    },
    {
      name: "a dimension the type doesn't have",
      mutate: (doc) => ({ ...doc, objects: [{ ...doc.objects[0], dimensions: { ...doc.objects[0].dimensions, width: 1 } }, ...doc.objects.slice(1)] }),
      error: 'a wall has no "width" dimension'
    },
    {
      name: "a non-numeric dimension",
      mutate: (doc) => ({ ...doc, objects: [{ ...doc.objects[0], dimensions: { ...doc.objects[0].dimensions, length: "6" } }, ...doc.objects.slice(1)] }),
      error: "dimensions.length must be a finite number greater than 0"
    },
    {
      name: "a non-finite position",
      mutate: (doc) => ({ ...doc, objects: [{ ...doc.objects[0], position: { x: 1, y: null, z: 0 } }, ...doc.objects.slice(1)] }),
      error: "position must have finite numeric x, y and z"
    },
    {
      name: "a non-numeric rotation",
      mutate: (doc) => ({ ...doc, objects: [{ ...doc.objects[0], rotation: "90deg" }, ...doc.objects.slice(1)] }),
      error: "rotation must be a finite number"
    },
    {
      name: "a bad color",
      mutate: (doc) => ({ ...doc, objects: [{ ...doc.objects[0], color: "red" }, ...doc.objects.slice(1)] }),
      error: "Color must be a 6-digit hex string"
    },
    {
      name: "a blank material",
      mutate: (doc) => ({ ...doc, objects: [{ ...doc.objects[0], material: " " }, ...doc.objects.slice(1)] }),
      error: "material must be a non-empty string"
    },
    {
      name: "an assembly member that isn't in the project",
      mutate: (doc) => ({ ...doc, assemblies: [{ ...doc.assemblies[0], objectIds: [...doc.assemblies[0].objectIds, "wall-9999"] }] }),
      error: 'member "wall-9999" is not an object in this project'
    },
    {
      name: "a duplicate assembly id",
      mutate: (doc) => ({ ...doc, assemblies: [doc.assemblies[0], { ...doc.assemblies[0], name: "Copy" }] }),
      error: "duplicate assembly id"
    },
    {
      name: "an assembly listing a member twice",
      mutate: (doc) => ({ ...doc, assemblies: [{ ...doc.assemblies[0], objectIds: [doc.objects[0].id, doc.objects[0].id] }] }),
      error: "must not contain duplicates"
    },
    {
      name: "an assembly with a blank name",
      mutate: (doc) => ({ ...doc, assemblies: [{ ...doc.assemblies[0], name: "" }] }),
      error: "Assembly name must be non-empty"
    },
    {
      name: "an object assemblyId naming no assembly",
      mutate: (doc) => ({ ...doc, objects: [{ ...doc.objects[0], assemblyId: "assembly-777" }, ...doc.objects.slice(1)] }),
      error: 'assemblyId "assembly-777" is not an assembly in this project'
    }
  ];

  await check("the validator rejects every kind of malformed project - shape, types, ids, dimensions, transforms, colors, assembly references", () => {
    for (const testCase of invalidDocuments) {
      const parsed = parseProjectDocument(testCase.mutate(clone(validDocument) as Record<string, any>));
      assertTrue(!parsed.ok, `${testCase.name}: should be rejected`);
      assertTrue(parsed.error.includes(testCase.error), `${testCase.name}: expected an error mentioning ${JSON.stringify(testCase.error)}, got ${JSON.stringify(parsed.error)}`);
    }
    assertTrue(parseProjectDocument(clone(validDocument)).ok, "while the unmodified document passes");
  });

  await check("an invalid project never touches the current one - model, selection and undo history all stay as they were", () => {
    const context = createProjectContext();
    const sample = buildSampleProject(context);
    execute(context, { type: "update_object", objectId: sample.pillar, changes: { rotation: 1 } });
    context.selectionStore.select(sample.slab);
    const before = modelJson(context);

    for (const testCase of invalidDocuments) {
      const result = loadProject(context, testCase.mutate(clone(validDocument) as Record<string, any>));
      assertTrue(!result.ok, `${testCase.name}: the load fails`);
      assertEqual(modelJson(context), before, `${testCase.name}: the model is untouched`);
      assertEqual(context.selectionStore.get(), sample.slab, `${testCase.name}: the selection is untouched`);
      assertTrue(context.history.canUndo(), `${testCase.name}: the undo history is untouched`);
    }

    context.history.undo();
    assertEqual(context.pillarStore.get(sample.pillar)?.rotation, 0, "and undo still reverses the edit from before the failed loads");
  });

  await check("if a store refuses an object mid-load anyway, the previous model is put back", () => {
    const context = createProjectContext();
    buildSampleProject(context);
    const before = modelJson(context);
    const refusedId = validSample.door;
    // A door store that refuses one object - something the document
    // validator can't produce, so this stands in for an unexpected
    // store-level failure.
    const refusingDoors = {
      getAll: () => context.doorStore.getAll(),
      remove: (id: string) => context.doorStore.remove(id),
      add: (door: Parameters<ProjectContext["doorStore"]["add"]>[0]) =>
        door.id === refusedId ? { valid: false, errors: [{ field: "id", message: "refused" }] } : context.doorStore.add(door)
    };
    const project = { ...context, doorStore: refusingDoors } as unknown as PersistableProject;

    const result = loadProject(project, validDocument);

    assertTrue(!result.ok && result.error.includes("refused"), `the load fails, saying why: ${result.ok ? "" : result.error}`);
    assertEqual(modelJson(context), before, "and the model that was there before is back, exactly");
  });

  // --- After a load ---

  await check("after a load, editing works normally: updates, deletes and undo/redo all behave as usual", () => {
    const target = createProjectContext();
    assertTrue(loadProject(target, validDocument).ok, "load");
    const wallId = validSample.wall;

    execute(target, { type: "update_object", objectId: wallId, changes: { dimensions: { length: 9 } } });
    assertEqual(target.wallStore.get(wallId)?.dimensions.length, 9, "a restored wall resizes");
    execute(target, { type: "wall.delete", id: validSample.wall });
    assertEqual(target.wallStore.get(wallId), undefined, "and deletes");

    target.history.undo();
    assertEqual(target.wallStore.get(wallId)?.dimensions.length, 9, "undo brings it back");
    target.history.undo();
    assertEqual(target.wallStore.get(wallId)?.dimensions.length, 6.5, "undo reverts the resize");
    assertEqual(target.history.canUndo(), false, "and that was all - the load itself isn't an undo step");
    target.history.redo();
    assertEqual(target.wallStore.get(wallId)?.dimensions.length, 9, "redo replays it");
  });

  await check("after a load, new objects and assemblies never reuse a loaded id", () => {
    const document = clone(validDocument);
    // Ids far above anything created so far in this process.
    const renamed: Record<string, string> = {};
    document.objects = document.objects.map((object, index) => {
      const id = `${object.type}-${900 + index}`;
      renamed[object.id] = id;
      return { ...object, id };
    }) as typeof document.objects;
    document.assemblies = document.assemblies.map((assembly) => ({
      ...assembly,
      id: "assembly-950",
      objectIds: assembly.objectIds.map((objectId) => renamed[objectId])
    }));

    const target = createProjectContext();
    assertTrue(loadProject(target, document).ok, "load");
    const loadedIds = new Set(document.objects.map((object) => object.id));

    const newIds = ["wall", "pillar", "beam", "slab", "door", "window"].map((type) => execute(target, { type: `${type}.add`, [type]: {} }));
    for (const id of newIds) {
      assertTrue(!loadedIds.has(id), `${id} is new`);
      assertTrue(Number(id.split("-")[1]) > 900, `${id} numbers past the loaded ids`);
    }
    assertEqual(target.wallStore.getAll().length, 2, "the loaded wall is still there - not overwritten by the new one");
    const assembly = execute(target, { type: "assembly.create", assembly: { name: "New" } });
    assertTrue(Number(assembly.split("-")[1]) > 950, `${assembly} numbers past the loaded assembly`);
  });

  // --- New Project ---

  await check("New Project still clears the model, selection and history - and starts a new, unsaved project", async () => {
    const context = createProjectContext();
    const sample = buildSampleProject(context);
    const controller = new ProjectPersistenceController({ repository: testRepository(), project: context });
    context.projectMeta.rename("Villa");
    assertTrue(await controller.save(), "saved");
    context.selectionStore.select(sample.wall);

    clearProject(context);

    assertSameJson(serializeProject(context), { version: 1, objects: [], assemblies: [] }, "an empty model");
    assertEqual(context.selectionStore.get(), null, "nothing selected");
    assertEqual(context.history.canUndo(), false, "nothing to undo");
    assertSameJson(context.projectMeta.get(), { id: null, name: DEFAULT_PROJECT_NAME, createdAt: null, updatedAt: null }, "a new, unsaved Untitled Project");
  });

  // --- Save / Open ---

  await check("Save stores a new project the first time, then updates the same project, keeping its name", async () => {
    const context = createProjectContext();
    buildSampleProject(context);
    const repository = testRepository();
    const controller = new ProjectPersistenceController({ repository, project: context });
    assertTrue(context.projectMeta.rename("  My 2 Bedroom House  "), "renamed");
    assertEqual(context.projectMeta.get().name, "My 2 Bedroom House", "names are trimmed");

    assertTrue(await controller.save(), "first save");
    const id = context.projectMeta.get().id;
    assertEqual(id, "project-1", "the project now has an id");
    assertEqual(controller.getState().status, "saved", "state");
    assertEqual(controller.getState().message, 'Saved "My 2 Bedroom House".', "message");

    execute(context, { type: "beam.add", beam: {} });
    assertTrue(await controller.save(), "second save");
    assertEqual(context.projectMeta.get().id, id, "the same project");
    const list = await repository.list();
    assertEqual(list.length, 1, "still one stored project");
    assertEqual(list[0].objectCount, 7, "with the new beam");
    assertEqual(list[0].name, "My 2 Bedroom House", "and its name");
  });

  await check("Save changes nothing in the workspace - not the model, the selection, or undo/redo", async () => {
    const context = createProjectContext();
    const sample = buildSampleProject(context);
    execute(context, { type: "update_object", objectId: sample.beam, changes: { rotation: 0.5 } });
    execute(context, { type: "update_object", objectId: sample.beam, changes: { rotation: 1 } });
    context.history.undo();
    context.selectionStore.select(sample.door);
    const before = { model: modelJson(context), undo: context.history.canUndo(), redo: context.history.canRedo() };
    assertTrue(before.undo && before.redo, "precondition: both undo and redo are available");

    const controller = new ProjectPersistenceController({ repository: testRepository(), project: context });
    assertTrue(await controller.save(), "saved");

    assertEqual(modelJson(context), before.model, "model unchanged");
    assertEqual(context.selectionStore.get(), sample.door, "selection unchanged");
    assertEqual(context.history.canUndo(), before.undo, "undo unchanged");
    assertEqual(context.history.canRedo(), before.redo, "redo unchanged");
    context.history.redo();
    assertEqual(context.beamStore.get(sample.beam)?.rotation, 1, "redo still replays the undone edit - saving added no entry");
  });

  await check("only one save runs at a time - a second Save while one is in flight is refused", async () => {
    const context = createProjectContext();
    buildSampleProject(context);
    const inner = testRepository();
    const gate = makeDeferred<void>();
    let creates = 0;
    const slowRepository: ProjectRepository = {
      create: async (input: ProjectInput) => {
        creates += 1;
        await gate.promise;
        return inner.create(input);
      },
      save: (id, input) => inner.save(id, input),
      get: (id) => inner.get(id),
      list: () => inner.list()
    };
    const controller = new ProjectPersistenceController({ repository: slowRepository, project: context });

    const first = controller.save();
    assertEqual(controller.getState().status, "saving", "saving");
    assertEqual(await controller.save(), false, "the second save is refused");
    assertEqual(await controller.open("project-1"), false, "and so is opening, meanwhile");
    gate.resolve();
    assertEqual(await first, true, "the first save completes");
    assertEqual(creates, 1, "exactly one write reached the repository");
  });

  await check("a failed save reports the error and leaves the project as it was", async () => {
    const context = createProjectContext();
    buildSampleProject(context);
    const before = modelJson(context);
    const failing: ProjectRepository = {
      create: async () => {
        throw new Error("Could not reach the project server: connection refused");
      },
      save: async () => {
        throw new Error("unreachable");
      },
      get: async () => null,
      list: async () => []
    };
    const controller = new ProjectPersistenceController({ repository: failing, project: context });

    assertEqual(await controller.save(), false, "save fails");
    assertEqual(controller.getState().status, "error", "state");
    assertEqual(controller.getState().message, "Save failed: Could not reach the project server: connection refused", "message");
    assertEqual(context.projectMeta.get().id, null, "still unsaved");
    assertEqual(modelJson(context), before, "the model is untouched");
    assertEqual(controller.isBusy(), false, "and Save can be tried again");
  });

  await check("if the stored copy has disappeared (a restarted in-memory server), Save stores the project again as new", async () => {
    const context = createProjectContext();
    buildSampleProject(context);
    const repository = testRepository();
    context.projectMeta.adopt({ id: "project-lost", name: "Lost", createdAt: "2025-01-01T00:00:00.000Z", updatedAt: "2025-01-01T00:00:00.000Z" });
    const controller = new ProjectPersistenceController({ repository, project: context });

    assertTrue(await controller.save(), "saved");
    assertEqual(context.projectMeta.get().id, "project-1", "under a new id");
    assertTrue(controller.getState().message?.includes("saved as a new project"), "and the message says so");
  });

  await check("Open replaces the model with the saved project, takes on its name, and starts with empty history", async () => {
    const source = createProjectContext();
    buildSampleProject(source);
    const repository = testRepository();
    const record = await repository.create({ name: "Beach House", document: serializeProject(source) });

    const target = createProjectContext();
    execute(target, { type: "wall.add", wall: {} });
    const controller = new ProjectPersistenceController({ repository, project: target });

    assertTrue(await controller.open(record.id), "opened");
    assertEqual(modelJson(target), modelJson(source), "the saved model");
    assertSameJson(
      target.projectMeta.get(),
      { id: record.id, name: "Beach House", createdAt: record.createdAt, updatedAt: record.updatedAt },
      "the saved project's identity"
    );
    assertEqual(target.history.canUndo(), false, "no history");
    assertEqual(controller.getState().message, 'Opened "Beach House".', "message");
  });

  await check("Open of a missing or corrupted project fails clearly and leaves the current project untouched", async () => {
    const context = createProjectContext();
    buildSampleProject(context);
    context.projectMeta.rename("Current");
    const before = modelJson(context);
    const corrupt: ProjectRecord = {
      id: "corrupt",
      name: "Corrupt",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      document: { ...clone(validDocument), objects: [{ ...clone(validDocument.objects[0]), type: "sofa" }] } as unknown as ProjectDocument
    };
    const repository: ProjectRepository = {
      create: async () => {
        throw new Error("not used");
      },
      save: async () => {
        throw new Error("not used");
      },
      get: async (id) => (id === "corrupt" ? corrupt : null),
      list: async () => []
    };
    const controller = new ProjectPersistenceController({ repository, project: context });

    assertEqual(await controller.open("missing"), false, "a missing project fails");
    assertEqual(controller.getState().message, "That project is no longer stored.", "message");

    assertEqual(await controller.open("corrupt"), false, "a corrupted project fails");
    assertTrue(controller.getState().message?.includes("is not a supported object type"), `says why: ${controller.getState().message}`);
    assertTrue(controller.getState().message?.includes("The current project was not changed."), "and that nothing changed");
    assertEqual(modelJson(context), before, "the model is untouched");
    assertEqual(context.projectMeta.get().name, "Current", "and so is the project's identity");
  });

  await check("project names: blank and over-long names are refused, others are trimmed", () => {
    const context = createProjectContext();
    assertEqual(context.projectMeta.rename("   "), false, "blank refused");
    assertEqual(context.projectMeta.rename("x".repeat(121)), false, "over 120 characters refused");
    assertEqual(context.projectMeta.get().name, DEFAULT_PROJECT_NAME, "the name is unchanged");
    assertEqual(context.projectMeta.rename(" Studio "), true, "a real name");
    assertEqual(context.projectMeta.get().name, "Studio", "trimmed");
  });

  // --- HttpProjectRepository (mock transport; backend/verify.ts runs it against the real server) ---

  await check("HttpProjectRepository speaks the /api/projects contract", async () => {
    const document = serializeProject(createProjectContext());
    const record: ProjectRecord = { id: "p1", name: "Shed", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", document };
    const fetchImpl = mockFetch((call) => {
      if (call.method === "GET" && call.url.endsWith("/api/projects")) {
        return jsonResponse(200, { projects: [{ id: "p1", name: "Shed", createdAt: record.createdAt, updatedAt: record.updatedAt, objectCount: 0, assemblyCount: 0 }] });
      }
      if (call.method === "POST") {
        return jsonResponse(201, { project: record });
      }
      if (call.method === "PUT") {
        return jsonResponse(200, { project: record });
      }
      return call.url.endsWith("/p1") ? jsonResponse(200, { project: record }) : jsonResponse(404, { error: "No saved project." });
    });
    const repository = new HttpProjectRepository({ baseUrl: "http://localhost:8787/", fetch: fetchImpl });

    assertSameJson(await repository.create({ name: "Shed", document }), record, "create");
    assertSameJson(await repository.save("p1", { name: "Shed", document }), record, "save");
    assertSameJson(await repository.get("p1"), record, "get");
    assertEqual(await repository.get("nope"), null, "404 is null");
    assertEqual((await repository.list())[0].name, "Shed", "list");
    assertSameJson(
      fetchImpl.calls.map((call) => `${call.method} ${call.url}`),
      [
        "POST http://localhost:8787/api/projects",
        "PUT http://localhost:8787/api/projects/p1",
        "GET http://localhost:8787/api/projects/p1",
        "GET http://localhost:8787/api/projects/nope",
        "GET http://localhost:8787/api/projects"
      ],
      "methods and URLs"
    );
    assertSameJson(fetchImpl.calls[0].body, { name: "Shed", document }, "the body is { name, document }");
  });

  await check("HttpProjectRepository maps server and network failures to clear errors", async () => {
    const document = serializeProject(createProjectContext());
    const repositoryWith = (handler: () => ProjectHttpResponse | Promise<ProjectHttpResponse>) =>
      new HttpProjectRepository({ baseUrl: "http://localhost:8787", fetch: mockFetch(handler) });

    await assertRejects(
      () => repositoryWith(() => jsonResponse(400, { error: "Invalid project document: bad" })).create({ name: "X", document }),
      (error) => error instanceof ProjectValidationError && error.message.includes("bad"),
      "400 -> ProjectValidationError"
    );
    await assertRejects(
      () => repositoryWith(() => jsonResponse(404, { error: "gone" })).save("p9", { name: "X", document }),
      (error) => error instanceof ProjectNotFoundError,
      "404 on save -> ProjectNotFoundError"
    );
    await assertRejects(
      () => repositoryWith(() => jsonResponse(500, { error: "Project storage failed." })).list(),
      (error) => error instanceof Error && error.message.includes("status 500"),
      "500 -> error with the status"
    );
    await assertRejects(
      () =>
        repositoryWith(() => {
          throw new Error("Failed to fetch");
        }).list(),
      (error) => error instanceof Error && error.message === "Could not reach the project server: Failed to fetch",
      "network failure"
    );
    await assertRejects(
      () => repositoryWith(() => jsonResponse(200, { project: { id: 5 } })).get("p1"),
      (error) => error instanceof Error && error.message.includes("malformed"),
      "a malformed project"
    );
    assertTrue(
      (() => {
        try {
          new HttpProjectRepository({ baseUrl: "", fetch: mockFetch(() => jsonResponse(200, {})) });
          return false;
        } catch {
          return true;
        }
      })(),
      "a base URL is required"
    );
  });

  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) {
    throw new Error(`${failed} verification check(s) failed`);
  }
}

// See src/engine/ai/verify.ts's matching comment for why this rethrows
// instead of setting `process.exitCode`.
run().catch((error) => {
  console.error(error);
  throw error;
});
