// Explicit .ts extensions on these value imports let Node run this file
// directly (the verify suites do). Harmless for Vite.
import { PROJECT_DOCUMENT_VERSION, parseProjectDocument, toPersistedObject } from "./projectDocument.ts";
import { reserveWallIds } from "../wall/createWall.ts";
import { reservePillarIds } from "../pillar/createPillar.ts";
import { reserveBeamIds } from "../beam/createBeam.ts";
import { reserveSlabIds } from "../slab/createSlab.ts";
import { reserveDoorIds } from "../door/createDoor.ts";
import { reserveWindowIds } from "../window/createWindow.ts";
import { reserveAssemblyIds } from "../assemblies/AssemblyStore.ts";
import type { PersistedObject, PersistedObjectType, ProjectDocument } from "./projectDocument";
import type { AssemblyData } from "../assemblies/types";
import type { ProjectContext } from "./ProjectContext";

/**
 * Turning the live model into a ProjectDocument and back. Both work on the
 * stores ProjectContext already holds - no scene, UI, or AI code is
 * involved - and the scene follows along through the stores' ordinary
 * subscriptions, exactly as it does for any other change.
 */

/** The parts of ProjectContext that saving and loading touch. */
export type PersistableProject = Pick<
  ProjectContext,
  "wallStore" | "pillarStore" | "beamStore" | "slabStore" | "doorStore" | "windowStore" | "assemblyStore" | "selectionStore" | "history"
>;

/**
 * The current model as a plain, JSON-safe document: every object exactly
 * as its store holds it, and every assembly. Only reads - saving is never
 * an undo step and never changes the selection.
 *
 * An assembly keeps a deleted member's id so that undoing the delete
 * restores the membership (see assemblies/README.md). History isn't saved,
 * so that id could never come back - only live members are written.
 */
export function serializeProject(project: PersistableProject): ProjectDocument {
  const records: PersistedObject[] = [
    ...project.wallStore.getAll(),
    ...project.pillarStore.getAll(),
    ...project.beamStore.getAll(),
    ...project.slabStore.getAll(),
    ...project.doorStore.getAll(),
    ...project.windowStore.getAll()
  ];
  const objects = records.map(toPersistedObject);
  const liveIds = new Set(objects.map((object) => object.id));

  const assemblies: AssemblyData[] = project.assemblyStore.getAll().map((assembly) => ({
    id: assembly.id,
    name: assembly.name,
    ...(typeof assembly.description === "string" ? { description: assembly.description } : {}),
    objectIds: assembly.objectIds.filter((objectId) => liveIds.has(objectId)),
    createdAt: assembly.createdAt,
    updatedAt: assembly.updatedAt
  }));

  return { version: PROJECT_DOCUMENT_VERSION, objects, assemblies };
}

export type LoadProjectResult = { ok: true; document: ProjectDocument } | { ok: false; error: string };

interface ModelState {
  objects: PersistedObject[];
  assemblies: AssemblyData[];
}

/** Everything currently in the stores, exactly - including stale assembly members - so a failed load can put it back. */
function captureModel(project: PersistableProject): ModelState {
  return {
    objects: [
      ...project.wallStore.getAll(),
      ...project.pillarStore.getAll(),
      ...project.beamStore.getAll(),
      ...project.slabStore.getAll(),
      ...project.doorStore.getAll(),
      ...project.windowStore.getAll()
    ],
    assemblies: project.assemblyStore.getAll()
  };
}

function addObject(project: PersistableProject, object: PersistedObject): { valid: boolean; errors: { message: string }[] } {
  switch (object.type) {
    case "wall":
      return project.wallStore.add(object);
    case "pillar":
      return project.pillarStore.add(object);
    case "beam":
      return project.beamStore.add(object);
    case "slab":
      return project.slabStore.add(object);
    case "door":
      return project.doorStore.add(object);
    case "window":
      return project.windowStore.add(object);
  }
}

/** Empties every store, then fills them from `state`. Returns an error message if a store refused something. */
function replaceModel(project: PersistableProject, state: ModelState): string | null {
  for (const store of [project.wallStore, project.pillarStore, project.beamStore, project.slabStore, project.doorStore, project.windowStore]) {
    for (const record of store.getAll()) {
      store.remove(record.id);
    }
  }
  for (const assembly of project.assemblyStore.getAll()) {
    project.assemblyStore.remove(assembly.id);
  }

  for (const object of state.objects) {
    const result = addObject(project, object);
    if (!result.valid) {
      return `${object.id}: ${result.errors[0]?.message ?? "rejected by its store"}`;
    }
  }
  for (const assembly of state.assemblies) {
    const result = project.assemblyStore.add(assembly);
    if (!result.valid) {
      return `${assembly.id}: ${result.errors[0]?.message ?? "rejected by its store"}`;
    }
  }
  return null;
}

const RESERVE_IDS: Readonly<Record<PersistedObjectType, (ids: string[]) => void>> = {
  wall: reserveWallIds,
  pillar: reservePillarIds,
  beam: reserveBeamIds,
  slab: reserveSlabIds,
  door: reserveDoorIds,
  window: reserveWindowIds
};

/**
 * Replaces the current model with a saved project - validate the whole
 * document, then hydrate, never the other way round:
 *
 * 1. parseProjectDocument() checks every object and assembly. If anything
 *    is wrong, nothing is touched and the error says what.
 * 2. The stores are emptied and refilled directly from the document -
 *    a controlled hydration path, not a replay of UI actions or undoable
 *    commands - so each object keeps its saved id and every value
 *    exactly. Each store still validates what it is given; if one ever
 *    refused an object the document validator accepted, the previous
 *    model is put back and the load fails.
 * 3. The id counters move past the loaded ids, so objects created
 *    afterwards never collide with loaded ones.
 * 4. Selection is cleared and the undo history emptied: a loaded project
 *    starts with nothing to undo, just like a fresh page.
 *
 * The scene and every panel rebuild from the stores' notifications, the
 * same way they do for any edit.
 */
export function loadProject(project: PersistableProject, value: unknown): LoadProjectResult {
  const parsed = parseProjectDocument(value);
  if (!parsed.ok) {
    return { ok: false, error: parsed.error };
  }
  if (project.history.isGrouping()) {
    return { ok: false, error: "Another edit (such as a drag) is still in progress. Finish it, then open the project again." };
  }

  const previous = captureModel(project);
  const failure = replaceModel(project, parsed.document);
  if (failure !== null) {
    replaceModel(project, previous);
    return { ok: false, error: `The project could not be restored (${failure}).` };
  }

  for (const type of Object.keys(RESERVE_IDS) as PersistedObjectType[]) {
    RESERVE_IDS[type](parsed.document.objects.filter((object) => object.type === type).map((object) => object.id));
  }
  reserveAssemblyIds(parsed.document.assemblies.map((assembly) => assembly.id));

  project.selectionStore.clear();
  project.history.clearHistory();
  return { ok: true, document: parsed.document };
}
