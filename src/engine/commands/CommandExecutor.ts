import type { WallStore } from "../wall/WallStore";
// Explicit .ts extension on this value import (unlike the type-only
// imports elsewhere in this file) is required so Node can run this
// file directly, e.g. from src/engine/commands/verify.ts - see
// allowImportingTsExtensions in tsconfig.json. Harmless for Vite too.
import { createWallData, duplicateWallData } from "../wall/createWall.ts";
import type {
  Command,
  CommandResult,
  AddWallCommand,
  UpdateWallCommand,
  DeleteWallCommand,
  DuplicateWallCommand,
  WallHistoryLike
} from "./types";

const KNOWN_COMMAND_TYPES = ["wall.add", "wall.update", "wall.delete", "wall.duplicate"] as const;

function isCommand(value: unknown): value is Command {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const type = (value as { type?: unknown }).type;
  return (KNOWN_COMMAND_TYPES as readonly unknown[]).includes(type);
}

/**
 * Turns a structured Command into real WallStore/WallHistoryController
 * calls. This is the intended entry point for callers that shouldn't
 * (or can't, at compile time) call those directly - a future feature
 * that turns an AI prompt into commands, a macro/scripting feature, or
 * today, a thin UI wiring shim. Does not parse natural language or any
 * other free-form input - see commands/README.md.
 *
 * Deliberately has no SelectionStore dependency: which object ends up
 * selected after a command runs is a UI-layer concern, not this layer's.
 */
export class CommandExecutor {
  private readonly wallStore: WallStore;
  private readonly wallHistory: WallHistoryLike;

  constructor(wallStore: WallStore, wallHistory: WallHistoryLike) {
    this.wallStore = wallStore;
    this.wallHistory = wallHistory;
  }

  /** Accepts `unknown` on purpose - this is the boundary where not-yet-trusted structured data (e.g. AI output) enters. */
  execute(input: unknown): CommandResult {
    if (!isCommand(input)) {
      return { success: false, message: 'Malformed command: expected an object with a known "type" field.' };
    }

    switch (input.type) {
      case "wall.add":
        return this.executeAdd(input);
      case "wall.update":
        return this.executeUpdate(input);
      case "wall.delete":
        return this.executeDelete(input);
      case "wall.duplicate":
        return this.executeDuplicate(input);
      default:
        return { success: false, message: `Unknown command type: "${(input as { type: string }).type}".` };
    }
  }

  private executeAdd(command: AddWallCommand): CommandResult {
    const wall = createWallData(command.wall ?? {});
    const result = this.wallHistory.add(wall);

    if (!result.valid) {
      return { success: false, errors: result.errors, message: "Could not add wall: validation failed." };
    }
    return { success: true, objectId: wall.id, message: "Wall added." };
  }

  private executeUpdate(command: UpdateWallCommand): CommandResult {
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

  private executeDelete(command: DeleteWallCommand): CommandResult {
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

  private executeDuplicate(command: DuplicateWallCommand): CommandResult {
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
}
