import type { WallStore } from "../wall/WallStore";
// Explicit .ts extensions on these value imports (unlike the type-only
// imports elsewhere in this file) are required so Node can run this
// file directly, e.g. from src/engine/commands/verify.ts - see
// allowImportingTsExtensions in tsconfig.json. Harmless for Vite too.
import { createWallData, duplicateWallData } from "../wall/createWall.ts";
import { createPillarData, duplicatePillarData } from "../pillar/createPillar.ts";
import { PillarStore } from "../pillar/PillarStore.ts";
import { AssemblyStore, createAssemblyData } from "../assemblies/AssemblyStore.ts";
import type {
  Command,
  CommandResult,
  AddWallCommand,
  UpdateWallCommand,
  DeleteWallCommand,
  DuplicateWallCommand,
  AddPillarCommand,
  UpdatePillarCommand,
  DeletePillarCommand,
  DuplicatePillarCommand,
  CreateAssemblyCommand,
  UpdateAssemblyCommand,
  DeleteAssemblyCommand,
  AddObjectToAssemblyCommand,
  RemoveObjectFromAssemblyCommand,
  WallHistoryLike,
  PillarHistoryLike
} from "./types";

const KNOWN_COMMAND_TYPES = [
  "wall.add",
  "wall.update",
  "wall.delete",
  "wall.duplicate",
  "pillar.add",
  "pillar.update",
  "pillar.delete",
  "pillar.duplicate",
  "assembly.create",
  "assembly.update",
  "assembly.delete",
  "assembly.addObject",
  "assembly.removeObject"
] as const;

function isCommand(value: unknown): value is Command {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const type = (value as { type?: unknown }).type;
  return (KNOWN_COMMAND_TYPES as readonly unknown[]).includes(type);
}

/**
 * Turns a structured Command into real WallStore/WallHistoryController/
 * AssemblyStore calls. This is the intended entry point for callers
 * that shouldn't (or can't, at compile time) call those directly - a
 * future feature that turns an AI prompt into commands, a macro/
 * scripting feature, or today, a thin UI wiring shim. Does not parse
 * natural language or any other free-form input - see commands/README.md.
 *
 * Deliberately has no SelectionStore dependency: which object ends up
 * selected after a command runs is a UI-layer concern, not this layer's.
 *
 * assemblyStore defaults to a fresh instance so existing callers that
 * only pass (wallStore, wallHistory) - e.g. main.ts - keep compiling
 * unchanged; assembly commands simply aren't reachable from those
 * callers unless they choose to pass a shared AssemblyStore in.
 *
 * pillarStore/pillarHistory follow the same "defaulted, so existing
 * callers keep compiling" idea, but pillarHistory's default can't just
 * be "a fresh PillarHistoryController" the way assemblyStore's default
 * is "a fresh AssemblyStore" - PillarHistoryController needs a shared
 * SelectionStore and HistoryManager to be meaningful, and manufacturing
 * throwaway instances of those here would be worse than not defaulting
 * at all. Instead the default pillarHistory is a thin pass-through
 * straight to the default pillarStore: real undo/redo, just not
 * recorded anywhere. Every real caller (main.ts, via ProjectContext)
 * always supplies a real PillarHistoryController explicitly; the
 * default only exists so wall-only/assembly-only call sites (e.g. the
 * existing tests in commands/verify.ts) keep compiling unchanged.
 */
export class CommandExecutor {
  private readonly wallStore: WallStore;
  private readonly wallHistory: WallHistoryLike;
  private readonly pillarStore: PillarStore;
  private readonly pillarHistory: PillarHistoryLike;
  private readonly assemblyStore: AssemblyStore;

  constructor(
    wallStore: WallStore,
    wallHistory: WallHistoryLike,
    assemblyStore: AssemblyStore = new AssemblyStore(),
    pillarStore: PillarStore = new PillarStore(),
    pillarHistory: PillarHistoryLike = {
      add: (pillar) => pillarStore.add(pillar),
      update: (id, changes) => pillarStore.update(id, changes),
      remove: (id) => pillarStore.remove(id)
    }
  ) {
    this.wallStore = wallStore;
    this.wallHistory = wallHistory;
    this.assemblyStore = assemblyStore;
    this.pillarStore = pillarStore;
    this.pillarHistory = pillarHistory;
  }

  /** Accepts `unknown` on purpose - this is the boundary where not-yet-trusted structured data (e.g. AI output) enters. */
  execute(input: unknown): CommandResult {
    if (!isCommand(input)) {
      return { success: false, message: 'Malformed command: expected an object with a known "type" field.' };
    }

    switch (input.type) {
      case "wall.add":
        return this.executeAddWall(input);
      case "wall.update":
        return this.executeUpdateWall(input);
      case "wall.delete":
        return this.executeDeleteWall(input);
      case "wall.duplicate":
        return this.executeDuplicateWall(input);
      case "pillar.add":
        return this.executeAddPillar(input);
      case "pillar.update":
        return this.executeUpdatePillar(input);
      case "pillar.delete":
        return this.executeDeletePillar(input);
      case "pillar.duplicate":
        return this.executeDuplicatePillar(input);
      case "assembly.create":
        return this.executeCreateAssembly(input);
      case "assembly.update":
        return this.executeUpdateAssembly(input);
      case "assembly.delete":
        return this.executeDeleteAssembly(input);
      case "assembly.addObject":
        return this.executeAddObjectToAssembly(input);
      case "assembly.removeObject":
        return this.executeRemoveObjectFromAssembly(input);
      default:
        return { success: false, message: `Unknown command type: "${(input as { type: string }).type}".` };
    }
  }

  private executeAddWall(command: AddWallCommand): CommandResult {
    const wall = createWallData(command.wall ?? {});
    const result = this.wallHistory.add(wall);

    if (!result.valid) {
      return { success: false, errors: result.errors, message: "Could not add wall: validation failed." };
    }
    return { success: true, objectId: wall.id, message: "Wall added." };
  }

  private executeUpdateWall(command: UpdateWallCommand): CommandResult {
    if (!command.id) {
      return { success: false, message: "wall.update command is missing an id." };
    }

    const result = this.wallHistory.update(command.id, command.changes ?? {});
    if (!result.valid) {
      return {
        success: false,
        objectId: command.id,
        errors: result.errors,
        message: "Could not update wall: validation failed."
      };
    }
    return { success: true, objectId: command.id, message: "Wall updated." };
  }

  private executeDeleteWall(command: DeleteWallCommand): CommandResult {
    if (!command.id) {
      return { success: false, message: "wall.delete command is missing an id." };
    }

    const existing = this.wallStore.get(command.id);
    if (!existing) {
      return { success: false, objectId: command.id, message: `No wall found with id "${command.id}".` };
    }

    this.wallHistory.remove(command.id);
    return { success: true, objectId: command.id, message: "Wall deleted." };
  }

  private executeDuplicateWall(command: DuplicateWallCommand): CommandResult {
    if (!command.id) {
      return { success: false, message: "wall.duplicate command is missing an id." };
    }

    const source = this.wallStore.get(command.id);
    if (!source) {
      return { success: false, objectId: command.id, message: `No wall found with id "${command.id}".` };
    }

    const duplicate = duplicateWallData(source);
    const result = this.wallHistory.add(duplicate);
    if (!result.valid) {
      // duplicateWallData() always produces valid data from an already-valid
      // source wall, so this shouldn't happen in practice - stay defensive.
      return {
        success: false,
        objectId: command.id,
        errors: result.errors,
        message: "Could not duplicate wall: validation failed."
      };
    }
    return { success: true, objectId: duplicate.id, message: "Wall duplicated." };
  }

  private executeAddPillar(command: AddPillarCommand): CommandResult {
    const pillar = createPillarData(command.pillar ?? {});
    const result = this.pillarHistory.add(pillar);

    if (!result.valid) {
      return { success: false, errors: result.errors, message: "Could not add pillar: validation failed." };
    }
    return { success: true, objectId: pillar.id, message: "Pillar added." };
  }

  private executeUpdatePillar(command: UpdatePillarCommand): CommandResult {
    if (!command.id) {
      return { success: false, message: "pillar.update command is missing an id." };
    }

    const result = this.pillarHistory.update(command.id, command.changes ?? {});
    if (!result.valid) {
      return {
        success: false,
        objectId: command.id,
        errors: result.errors,
        message: "Could not update pillar: validation failed."
      };
    }
    return { success: true, objectId: command.id, message: "Pillar updated." };
  }

  private executeDeletePillar(command: DeletePillarCommand): CommandResult {
    if (!command.id) {
      return { success: false, message: "pillar.delete command is missing an id." };
    }

    const existing = this.pillarStore.get(command.id);
    if (!existing) {
      return { success: false, objectId: command.id, message: `No pillar found with id "${command.id}".` };
    }

    this.pillarHistory.remove(command.id);
    return { success: true, objectId: command.id, message: "Pillar deleted." };
  }

  private executeDuplicatePillar(command: DuplicatePillarCommand): CommandResult {
    if (!command.id) {
      return { success: false, message: "pillar.duplicate command is missing an id." };
    }

    const source = this.pillarStore.get(command.id);
    if (!source) {
      return { success: false, objectId: command.id, message: `No pillar found with id "${command.id}".` };
    }

    const duplicate = duplicatePillarData(source);
    const result = this.pillarHistory.add(duplicate);
    if (!result.valid) {
      // duplicatePillarData() always produces valid data from an already-valid
      // source pillar, so this shouldn't happen in practice - stay defensive.
      return {
        success: false,
        objectId: command.id,
        errors: result.errors,
        message: "Could not duplicate pillar: validation failed."
      };
    }
    return { success: true, objectId: duplicate.id, message: "Pillar duplicated." };
  }

  private executeCreateAssembly(command: CreateAssemblyCommand): CommandResult {
    if (!command.assembly || !command.assembly.name) {
      return { success: false, message: "assembly.create command is missing a name." };
    }

    const assembly = createAssemblyData(command.assembly);
    const result = this.assemblyStore.add(assembly);
    if (!result.valid) {
      return { success: false, errors: result.errors, message: "Could not create assembly: validation failed." };
    }
    return { success: true, objectId: assembly.id, message: "Assembly created." };
  }

  private executeUpdateAssembly(command: UpdateAssemblyCommand): CommandResult {
    if (!command.id) {
      return { success: false, message: "assembly.update command is missing an id." };
    }

    // updatedAt always reflects when the write actually happened - never trust a caller-supplied value.
    const result = this.assemblyStore.update(command.id, { ...command.changes, updatedAt: Date.now() });
    if (!result.valid) {
      return {
        success: false,
        objectId: command.id,
        errors: result.errors,
        message: "Could not update assembly: validation failed."
      };
    }
    return { success: true, objectId: command.id, message: "Assembly updated." };
  }

  private executeDeleteAssembly(command: DeleteAssemblyCommand): CommandResult {
    if (!command.id) {
      return { success: false, message: "assembly.delete command is missing an id." };
    }

    const existing = this.assemblyStore.get(command.id);
    if (!existing) {
      return { success: false, objectId: command.id, message: `No assembly found with id "${command.id}".` };
    }

    this.assemblyStore.remove(command.id);
    return { success: true, objectId: command.id, message: "Assembly deleted." };
  }

  private executeAddObjectToAssembly(command: AddObjectToAssemblyCommand): CommandResult {
    if (!command.assemblyId || !command.objectId) {
      return { success: false, message: "assembly.addObject command is missing assemblyId or objectId." };
    }

    const assembly = this.assemblyStore.get(command.assemblyId);
    if (!assembly) {
      return {
        success: false,
        objectId: command.assemblyId,
        message: `No assembly found with id "${command.assemblyId}".`
      };
    }
    if (assembly.objectIds.includes(command.objectId)) {
      return { success: false, objectId: command.assemblyId, message: "Object is already in this assembly." };
    }

    const result = this.assemblyStore.update(command.assemblyId, {
      objectIds: [...assembly.objectIds, command.objectId],
      updatedAt: Date.now()
    });
    if (!result.valid) {
      return {
        success: false,
        objectId: command.assemblyId,
        errors: result.errors,
        message: "Could not add object to assembly."
      };
    }
    return { success: true, objectId: command.assemblyId, message: "Object added to assembly." };
  }

  private executeRemoveObjectFromAssembly(command: RemoveObjectFromAssemblyCommand): CommandResult {
    if (!command.assemblyId || !command.objectId) {
      return { success: false, message: "assembly.removeObject command is missing assemblyId or objectId." };
    }

    const assembly = this.assemblyStore.get(command.assemblyId);
    if (!assembly) {
      return {
        success: false,
        objectId: command.assemblyId,
        message: `No assembly found with id "${command.assemblyId}".`
      };
    }
    if (!assembly.objectIds.includes(command.objectId)) {
      return { success: false, objectId: command.assemblyId, message: "Object is not in this assembly." };
    }

    const result = this.assemblyStore.update(command.assemblyId, {
      objectIds: assembly.objectIds.filter((id) => id !== command.objectId),
      updatedAt: Date.now()
    });
    if (!result.valid) {
      return {
        success: false,
        objectId: command.assemblyId,
        errors: result.errors,
        message: "Could not remove object from assembly."
      };
    }
    return { success: true, objectId: command.assemblyId, message: "Object removed from assembly." };
  }
}
