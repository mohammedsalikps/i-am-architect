// Explicit .ts extensions on every value import below let Node run this
// module directly (see allowImportingTsExtensions in tsconfig.json),
// which is what lets src/engine/ai/e2e/verify.ts drive the REAL
// composition root - real stores, real *HistoryController classes, real
// shared HistoryManager - instead of stand-ins. Harmless for Vite,
// which resolves these identically either way.
import { WallStore } from "../wall/WallStore.ts";
import { PillarStore } from "../pillar/PillarStore.ts";
import { BeamStore } from "../beam/BeamStore.ts";
import { SlabStore } from "../slab/SlabStore.ts";
import { DoorStore } from "../door/DoorStore.ts";
import { WindowStore } from "../window/WindowStore.ts";
import { ElementStore } from "../elements/ElementStore.ts";
import { AssemblyStore } from "../assemblies/AssemblyStore.ts";
import { SelectionStore } from "../selection/SelectionStore.ts";
import { HistoryManager } from "../history/HistoryManager.ts";
import { WallHistoryController } from "../history/wallHistory.ts";
import { PillarHistoryController } from "../history/pillarHistory.ts";
import { BeamHistoryController } from "../history/beamHistory.ts";
import { SlabHistoryController } from "../history/slabHistory.ts";
import { DoorHistoryController } from "../history/doorHistory.ts";
import { WindowHistoryController } from "../history/windowHistory.ts";
import { ElementHistoryController } from "../history/elementHistory.ts";
import { CommandExecutor } from "../commands/CommandExecutor.ts";
import { ProjectMetaStore } from "./ProjectMetaStore.ts";

// The project-level save/load operations, next to clearProject() below -
// see projectPersistence.ts.
export { loadProject, serializeProject } from "./projectPersistence.ts";
export type { LoadProjectResult, PersistableProject } from "./projectPersistence.ts";

/**
 * The application's shared composition-root state: one instance each
 * of every store/controller the UI and CommandExecutor need, wired
 * together consistently. main.ts calls createProjectContext() once and
 * threads the returned pieces through, instead of constructing them
 * individually - that's what guarantees exactly one AssemblyStore (and
 * one of everything else) exists for the whole running app, and that
 * CommandExecutor holds the SAME stores every other consumer sees, not a
 * private default of its own (CommandExecutor's constructor still has
 * defaults for those - see its own docs - but nothing in the running app
 * should end up relying on them; this module is what prevents that).
 *
 * Every history controller - one per original type, plus the one for
 * every element kind - shares the SAME HistoryManager instance, so every
 * edit interleaves into one global undo stack. selectionStore is likewise
 * shared across every object type, which is what gives "one selected
 * construction object at a time" with no extra code.
 *
 * elementStore holds every parametric element kind in the catalog
 * (foundation, roof, stair, flooring, plumbing, electrical, interior,
 * exterior, rooms - see elements/catalog.ts); the six original types keep
 * their own stores.
 *
 * projectMeta is the project's identity - which saved project, if any,
 * the model belongs to, and its name. It is not part of the construction
 * model and not undoable. The project-level operations are
 * clearProject() (New Project), serializeProject() and loadProject()
 * (see projectPersistence.ts and project/README.md).
 *
 * Deliberately excludes app-bootstrapping decisions (e.g. "create a
 * default wall on startup") - this module only wires infrastructure
 * together, it doesn't decide what a new project's initial content is.
 * That stays in main.ts.
 */
export interface ProjectContext {
  wallStore: WallStore;
  pillarStore: PillarStore;
  beamStore: BeamStore;
  slabStore: SlabStore;
  doorStore: DoorStore;
  windowStore: WindowStore;
  elementStore: ElementStore;
  assemblyStore: AssemblyStore;
  selectionStore: SelectionStore;
  history: HistoryManager;
  wallHistory: WallHistoryController;
  pillarHistory: PillarHistoryController;
  beamHistory: BeamHistoryController;
  slabHistory: SlabHistoryController;
  doorHistory: DoorHistoryController;
  windowHistory: WindowHistoryController;
  elementHistory: ElementHistoryController;
  commandExecutor: CommandExecutor;
  projectMeta: ProjectMetaStore;
}

/**
 * Empties a project for "New Project": every construction object and
 * every assembly is removed through the same commands the UI uses (so
 * each store's own rules apply), then the selection and the undo history
 * are cleared - a new project starts with nothing to undo, exactly like a
 * fresh page load - and the project becomes a new, unsaved "Untitled
 * Project". Ids keep counting up, so nothing ever reuses an id.
 */
export function clearProject(context: ProjectContext): void {
  const deletions = [
    ...context.wallStore.getAll().map((object) => ({ type: "wall.delete", id: object.id })),
    ...context.pillarStore.getAll().map((object) => ({ type: "pillar.delete", id: object.id })),
    ...context.beamStore.getAll().map((object) => ({ type: "beam.delete", id: object.id })),
    ...context.slabStore.getAll().map((object) => ({ type: "slab.delete", id: object.id })),
    ...context.doorStore.getAll().map((object) => ({ type: "door.delete", id: object.id })),
    ...context.windowStore.getAll().map((object) => ({ type: "window.delete", id: object.id })),
    ...context.elementStore.getAll().map((object) => ({ type: "element.delete", id: object.id })),
    ...context.assemblyStore.getAll().map((assembly) => ({ type: "assembly.delete", id: assembly.id }))
  ];
  for (const command of deletions) {
    context.commandExecutor.execute(command);
  }
  context.selectionStore.clear();
  context.history.clearHistory();
  context.projectMeta.reset();
}

/** Builds one fresh, fully-wired ProjectContext. Each call produces independent instances - nothing here is a module-level singleton. */
export function createProjectContext(): ProjectContext {
  const wallStore = new WallStore();
  const pillarStore = new PillarStore();
  const beamStore = new BeamStore();
  const slabStore = new SlabStore();
  const doorStore = new DoorStore();
  const windowStore = new WindowStore();
  const elementStore = new ElementStore();
  const assemblyStore = new AssemblyStore();
  const selectionStore = new SelectionStore();
  const history = new HistoryManager();
  const wallHistory = new WallHistoryController(wallStore, selectionStore, history);
  const pillarHistory = new PillarHistoryController(pillarStore, selectionStore, history);
  const beamHistory = new BeamHistoryController(beamStore, selectionStore, history);
  const slabHistory = new SlabHistoryController(slabStore, selectionStore, history);
  const doorHistory = new DoorHistoryController(doorStore, selectionStore, history);
  const windowHistory = new WindowHistoryController(windowStore, selectionStore, history);
  const elementHistory = new ElementHistoryController(elementStore, selectionStore, history);
  const commandExecutor = new CommandExecutor(
    wallStore,
    wallHistory,
    assemblyStore,
    pillarStore,
    pillarHistory,
    beamStore,
    beamHistory,
    slabStore,
    slabHistory,
    doorStore,
    doorHistory,
    windowStore,
    windowHistory,
    elementStore,
    elementHistory
  );
  const projectMeta = new ProjectMetaStore();

  return {
    wallStore,
    pillarStore,
    beamStore,
    slabStore,
    doorStore,
    windowStore,
    elementStore,
    assemblyStore,
    selectionStore,
    history,
    wallHistory,
    pillarHistory,
    beamHistory,
    slabHistory,
    doorHistory,
    windowHistory,
    elementHistory,
    commandExecutor,
    projectMeta
  };
}
