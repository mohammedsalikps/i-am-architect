import type { CreateWallOptions } from "../wall/createWall";
import type { WallData, WallId } from "../wall/types";
import type { WallValidationResult, WallValidationError } from "../wall/validateWall";

/**
 * A Command is structured data describing one construction-object
 * operation - never arbitrary executable code. This is what lets a
 * future caller (an AI feature translating a prompt into commands, a
 * macro/scripting feature, or - today - a thin UI action) request a
 * mutation without calling WallStore/WallHistoryController directly.
 * See commands/README.md.
 *
 * Only wall commands exist today. A future object type adds its own
 * namespaced command interfaces here (e.g. "pillar.add") and joins the
 * Command union below - CommandExecutor gets one new switch case,
 * nothing about the existing shapes needs to change.
 */

export interface AddWallCommand {
  type: "wall.add";
  /** Same shape as createWallData()'s options - flat, all optional, sensible defaults fill the rest. */
  wall: CreateWallOptions;
}

export interface UpdateWallCommand {
  type: "wall.update";
  id: WallId;
  /** Same shape WallStore.update() takes - see its docs for the "complete replacement object" convention on nested fields. */
  changes: Partial<Omit<WallData, "id" | "type">>;
}

export interface DeleteWallCommand {
  type: "wall.delete";
  id: WallId;
}

export interface DuplicateWallCommand {
  type: "wall.duplicate";
  id: WallId;
}

export type Command = AddWallCommand | UpdateWallCommand | DeleteWallCommand | DuplicateWallCommand;

export interface CommandResult {
  success: boolean;
  /** The wall that was added/updated/deleted/duplicated, when applicable. */
  objectId?: WallId;
  /** Field-level validation errors, when the command failed because the resulting wall data was invalid. */
  errors?: WallValidationError[];
  /** A short, human-readable outcome description - for logs/debugging, not yet surfaced in the UI. */
  message?: string;
}

/**
 * The subset of WallHistoryController's public API CommandExecutor
 * actually depends on. Declared as its own structural interface
 * (rather than importing the WallHistoryController class directly) so
 * a real WallHistoryController instance satisfies it automatically
 * (main.ts needs no special handling), while a lightweight stand-in
 * can satisfy it too (verify.ts uses one, since WallHistoryController's
 * constructor can't run under Node's native TypeScript support - see
 * verify.ts for why).
 */
export interface WallHistoryLike {
  add(wall: WallData): WallValidationResult;
  update(id: WallId, changes: Partial<Omit<WallData, "id" | "type">>): WallValidationResult;
  remove(id: WallId): void;
}
