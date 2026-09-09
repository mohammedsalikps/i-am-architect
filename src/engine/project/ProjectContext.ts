import { WallStore } from "../wall/WallStore";
import { PillarStore } from "../pillar/PillarStore";
import { BeamStore } from "../beam/BeamStore";
import { SlabStore } from "../slab/SlabStore";
import { DoorStore } from "../door/DoorStore";
import { WindowStore } from "../window/WindowStore";
import { AssemblyStore } from "../assemblies/AssemblyStore";
import { SelectionStore } from "../selection/SelectionStore";
import { HistoryManager } from "../history/HistoryManager";
import { WallHistoryController } from "../history/wallHistory";
import { PillarHistoryController } from "../history/pillarHistory";
import { BeamHistoryController } from "../history/beamHistory";
import { SlabHistoryController } from "../history/slabHistory";
import { DoorHistoryController } from "../history/doorHistory";
import { WindowHistoryController } from "../history/windowHistory";
import { CommandExecutor } from "../commands/CommandExecutor";

/**
 * The application's shared composition-root state: one instance each
 * of every store/controller the UI and CommandExecutor need, wired
 * together consistently. main.ts calls createProjectContext() once and
 * threads the returned pieces through, instead of constructing them
 * individually - that's what guarantees exactly one AssemblyStore (and
 * one of everything else) exists for the whole running app, and that
 * CommandExecutor holds the SAME AssemblyStore/PillarStore/BeamStore/
 * SlabStore/DoorStore/WindowStore instance every other consumer sees,
 * not a private default of its own (CommandExecutor's constructor
 * still has defaults for those - see its own docs - but nothing in the
 * running app should end up relying on them; this module is what
 * prevents that).
 *
 * wallHistory, pillarHistory, beamHistory, slabHistory, doorHistory,
 * and windowHistory all share the SAME HistoryManager instance, so
 * every object type's undo/redo interleaves into one global undo
 * stack - not six independent ones. selectionStore is likewise shared
 * across every object type (it was already generic, not wall-specific),
 * which is what gives "one selected construction object at a time"
 * across all of them with no extra code.
 *
 * Deliberately excludes app-bootstrapping decisions (e.g. "create a
 * default wall on startup") - this module only wires infrastructure
 * together, it doesn't decide what a new project's initial content is.
 * That stays in main.ts.
 *
 * Ownership is unchanged from before this module existed: stores own
 * domain data, CommandExecutor owns command execution, SelectionStore
 * is UI state, HistoryManager is shared undo/redo infrastructure -
 * assemblies have no undo/redo yet (see assemblies/README.md). This
 * module introduces no new behavior, only composition.
 */
export interface ProjectContext {
  wallStore: WallStore;
  pillarStore: PillarStore;
  beamStore: BeamStore;
  slabStore: SlabStore;
  doorStore: DoorStore;
  windowStore: WindowStore;
  assemblyStore: AssemblyStore;
  selectionStore: SelectionStore;
  history: HistoryManager;
  wallHistory: WallHistoryController;
  pillarHistory: PillarHistoryController;
  beamHistory: BeamHistoryController;
  slabHistory: SlabHistoryController;
  doorHistory: DoorHistoryController;
  windowHistory: WindowHistoryController;
  commandExecutor: CommandExecutor;
}

/** Builds one fresh, fully-wired ProjectContext. Each call produces independent instances - nothing here is a module-level singleton. */
export function createProjectContext(): ProjectContext {
  const wallStore = new WallStore();
  const pillarStore = new PillarStore();
  const beamStore = new BeamStore();
  const slabStore = new SlabStore();
  const doorStore = new DoorStore();
  const windowStore = new WindowStore();
  const assemblyStore = new AssemblyStore();
  const selectionStore = new SelectionStore();
  const history = new HistoryManager();
  const wallHistory = new WallHistoryController(wallStore, selectionStore, history);
  const pillarHistory = new PillarHistoryController(pillarStore, selectionStore, history);
  const beamHistory = new BeamHistoryController(beamStore, selectionStore, history);
  const slabHistory = new SlabHistoryController(slabStore, selectionStore, history);
  const doorHistory = new DoorHistoryController(doorStore, selectionStore, history);
  const windowHistory = new WindowHistoryController(windowStore, selectionStore, history);
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
    windowHistory
  );

  return {
    wallStore,
    pillarStore,
    beamStore,
    slabStore,
    doorStore,
    windowStore,
    assemblyStore,
    selectionStore,
    history,
    wallHistory,
    pillarHistory,
    beamHistory,
    slabHistory,
    doorHistory,
    windowHistory,
    commandExecutor
  };
}
