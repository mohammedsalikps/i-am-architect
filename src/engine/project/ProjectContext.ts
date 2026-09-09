import { WallStore } from "../wall/WallStore";
import { AssemblyStore } from "../assemblies/AssemblyStore";
import { SelectionStore } from "../selection/SelectionStore";
import { HistoryManager } from "../history/HistoryManager";
import { WallHistoryController } from "../history/wallHistory";
import { CommandExecutor } from "../commands/CommandExecutor";

/**
 * The application's shared composition-root state: one instance each
 * of every store/controller the UI and CommandExecutor need, wired
 * together consistently. main.ts calls createProjectContext() once and
 * threads the returned pieces through, instead of constructing them
 * individually - that's what guarantees exactly one AssemblyStore (and
 * one of everything else) exists for the whole running app, and that
 * CommandExecutor holds the SAME AssemblyStore instance every other
 * consumer sees, not a private default of its own (CommandExecutor's
 * constructor still has that default - see its own docs - but nothing
 * in the running app should end up relying on it; this module is what
 * prevents that).
 *
 * Deliberately excludes app-bootstrapping decisions (e.g. "create a
 * default wall on startup") - this module only wires infrastructure
 * together, it doesn't decide what a new project's initial content is.
 * That stays in main.ts.
 *
 * Ownership is unchanged from before this module existed: stores own
 * domain data, CommandExecutor owns command execution, SelectionStore
 * is UI state, HistoryManager is wall-history infrastructure only -
 * assemblies have no undo/redo yet (see assemblies/README.md). This
 * module introduces no new behavior, only composition.
 */
export interface ProjectContext {
  wallStore: WallStore;
  assemblyStore: AssemblyStore;
  selectionStore: SelectionStore;
  history: HistoryManager;
  wallHistory: WallHistoryController;
  commandExecutor: CommandExecutor;
}

/** Builds one fresh, fully-wired ProjectContext. Each call produces independent instances - nothing here is a module-level singleton. */
export function createProjectContext(): ProjectContext {
  const wallStore = new WallStore();
  const assemblyStore = new AssemblyStore();
  const selectionStore = new SelectionStore();
  const history = new HistoryManager();
  const wallHistory = new WallHistoryController(wallStore, selectionStore, history);
  const commandExecutor = new CommandExecutor(wallStore, wallHistory, assemblyStore);

  return { wallStore, assemblyStore, selectionStore, history, wallHistory, commandExecutor };
}
