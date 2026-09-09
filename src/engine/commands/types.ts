import type { CreateWallOptions } from "../wall/createWall";
import type { WallData, WallId } from "../wall/types";
import type { WallValidationResult } from "../wall/validateWall";
import type { CreatePillarOptions } from "../pillar/createPillar";
import type { PillarData, PillarId } from "../pillar/types";
import type { PillarValidationResult } from "../pillar/validatePillar";
import type { CreateBeamOptions } from "../beam/createBeam";
import type { BeamData, BeamId } from "../beam/types";
import type { BeamValidationResult } from "../beam/validateBeam";
import type { AssemblyData, AssemblyId } from "../assemblies/types";
import type { ObjectId } from "../objects/types";

/**
 * A Command is structured data describing one construction-object or
 * assembly operation - never arbitrary executable code. This is what
 * lets a future caller (an AI feature translating a prompt into
 * commands, a macro/scripting feature, or - today - a thin UI action)
 * request a mutation without calling WallStore/WallHistoryController/
 * PillarStore/PillarHistoryController/BeamStore/BeamHistoryController/
 * AssemblyStore directly. See commands/README.md.
 *
 * The "pillar.*" and "beam.*" commands below are the second and third
 * object types to follow this pattern (after "wall.*") - a future
 * object type adds its own namespaced command interfaces here and
 * joins the Command union below the same way, giving CommandExecutor
 * one new switch case per command without changing any existing shape.
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

export interface AddPillarCommand {
  type: "pillar.add";
  /** Same shape as createPillarData()'s options - flat, all optional, sensible defaults fill the rest. */
  pillar: CreatePillarOptions;
}

export interface UpdatePillarCommand {
  type: "pillar.update";
  id: PillarId;
  /** Same shape PillarStore.update() takes - see its docs for the "complete replacement object" convention on nested fields. */
  changes: Partial<Omit<PillarData, "id" | "type">>;
}

export interface DeletePillarCommand {
  type: "pillar.delete";
  id: PillarId;
}

export interface DuplicatePillarCommand {
  type: "pillar.duplicate";
  id: PillarId;
}

export interface AddBeamCommand {
  type: "beam.add";
  /** Same shape as createBeamData()'s options - flat, all optional, sensible defaults fill the rest. */
  beam: CreateBeamOptions;
}

export interface UpdateBeamCommand {
  type: "beam.update";
  id: BeamId;
  /** Same shape BeamStore.update() takes - see its docs for the "complete replacement object" convention on nested fields. */
  changes: Partial<Omit<BeamData, "id" | "type">>;
}

export interface DeleteBeamCommand {
  type: "beam.delete";
  id: BeamId;
}

export interface DuplicateBeamCommand {
  type: "beam.duplicate";
  id: BeamId;
}

export interface CreateAssemblyCommand {
  type: "assembly.create";
  /** Same shape as createAssemblyData()'s options - id/createdAt/updatedAt are always generated, never caller-supplied. */
  assembly: { name: string; description?: string; objectIds?: ObjectId[] };
}

export interface UpdateAssemblyCommand {
  type: "assembly.update";
  id: AssemblyId;
  /** Same shape AssemblyStore.update() takes. updatedAt is always overwritten by the executor with the current time. */
  changes: Partial<Omit<AssemblyData, "id">>;
}

export interface DeleteAssemblyCommand {
  type: "assembly.delete";
  id: AssemblyId;
}

export interface AddObjectToAssemblyCommand {
  type: "assembly.addObject";
  assemblyId: AssemblyId;
  objectId: ObjectId;
}

export interface RemoveObjectFromAssemblyCommand {
  type: "assembly.removeObject";
  assemblyId: AssemblyId;
  objectId: ObjectId;
}

export type Command =
  | AddWallCommand
  | UpdateWallCommand
  | DeleteWallCommand
  | DuplicateWallCommand
  | AddPillarCommand
  | UpdatePillarCommand
  | DeletePillarCommand
  | DuplicatePillarCommand
  | AddBeamCommand
  | UpdateBeamCommand
  | DeleteBeamCommand
  | DuplicateBeamCommand
  | CreateAssemblyCommand
  | UpdateAssemblyCommand
  | DeleteAssemblyCommand
  | AddObjectToAssemblyCommand
  | RemoveObjectFromAssemblyCommand;

export interface CommandResult {
  success: boolean;
  /** The wall or assembly id this command primarily affected, when applicable. */
  objectId?: string;
  /** Field-level validation errors, when the command failed because the resulting data was invalid. */
  errors?: { field: string; message: string }[];
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

/** The pillar equivalent of WallHistoryLike - same reasoning, same shape. */
export interface PillarHistoryLike {
  add(pillar: PillarData): PillarValidationResult;
  update(id: PillarId, changes: Partial<Omit<PillarData, "id" | "type">>): PillarValidationResult;
  remove(id: PillarId): void;
}

/** The beam equivalent of WallHistoryLike/PillarHistoryLike - same reasoning, same shape. */
export interface BeamHistoryLike {
  add(beam: BeamData): BeamValidationResult;
  update(id: BeamId, changes: Partial<Omit<BeamData, "id" | "type">>): BeamValidationResult;
  remove(id: BeamId): void;
}
