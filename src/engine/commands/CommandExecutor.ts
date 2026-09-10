import type { WallStore } from "../wall/WallStore";
// Explicit .ts extensions on these value imports (unlike the type-only
// imports elsewhere in this file) are required so Node can run this
// file directly, e.g. from src/engine/commands/verify.ts - see
// allowImportingTsExtensions in tsconfig.json. Harmless for Vite too.
import { createWallData, duplicateWallData } from "../wall/createWall.ts";
import { createPillarData, duplicatePillarData } from "../pillar/createPillar.ts";
import { PillarStore } from "../pillar/PillarStore.ts";
import { createBeamData, duplicateBeamData } from "../beam/createBeam.ts";
import { BeamStore } from "../beam/BeamStore.ts";
import { createSlabData, duplicateSlabData } from "../slab/createSlab.ts";
import { SlabStore } from "../slab/SlabStore.ts";
import { createDoorData, duplicateDoorData } from "../door/createDoor.ts";
import { DoorStore } from "../door/DoorStore.ts";
import { createWindowData, duplicateWindowData } from "../window/createWindow.ts";
import { WindowStore } from "../window/WindowStore.ts";
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
  AddBeamCommand,
  UpdateBeamCommand,
  DeleteBeamCommand,
  DuplicateBeamCommand,
  AddSlabCommand,
  UpdateSlabCommand,
  DeleteSlabCommand,
  DuplicateSlabCommand,
  AddDoorCommand,
  UpdateDoorCommand,
  DeleteDoorCommand,
  DuplicateDoorCommand,
  AddWindowCommand,
  UpdateWindowCommand,
  DeleteWindowCommand,
  DuplicateWindowCommand,
  CreateAssemblyCommand,
  UpdateAssemblyCommand,
  DeleteAssemblyCommand,
  AddObjectToAssemblyCommand,
  RemoveObjectFromAssemblyCommand,
  UpdateObjectCommand,
  WallHistoryLike,
  PillarHistoryLike,
  BeamHistoryLike,
  SlabHistoryLike,
  DoorHistoryLike,
  WindowHistoryLike
} from "./types";
import { resolveConstructionObject } from "../objects/resolveConstructionObject.ts";

const KNOWN_COMMAND_TYPES = [
  "wall.add",
  "wall.update",
  "wall.delete",
  "wall.duplicate",
  "pillar.add",
  "pillar.update",
  "pillar.delete",
  "pillar.duplicate",
  "beam.add",
  "beam.update",
  "beam.delete",
  "beam.duplicate",
  "slab.add",
  "slab.update",
  "slab.delete",
  "slab.duplicate",
  "door.add",
  "door.update",
  "door.delete",
  "door.duplicate",
  "window.add",
  "window.update",
  "window.delete",
  "window.duplicate",
  "assembly.create",
  "assembly.update",
  "assembly.delete",
  "assembly.addObject",
  "assembly.removeObject",
  "update_object"
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
 *
 * beamStore/beamHistory, slabStore/slabHistory, doorStore/doorHistory,
 * and windowStore/windowHistory, all follow the exact same defaulting
 * idea as pillarStore/pillarHistory - see the paragraph above.
 */
export class CommandExecutor {
  private readonly wallStore: WallStore;
  private readonly wallHistory: WallHistoryLike;
  private readonly pillarStore: PillarStore;
  private readonly pillarHistory: PillarHistoryLike;
  private readonly beamStore: BeamStore;
  private readonly beamHistory: BeamHistoryLike;
  private readonly slabStore: SlabStore;
  private readonly slabHistory: SlabHistoryLike;
  private readonly doorStore: DoorStore;
  private readonly doorHistory: DoorHistoryLike;
  private readonly windowStore: WindowStore;
  private readonly windowHistory: WindowHistoryLike;
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
    },
    beamStore: BeamStore = new BeamStore(),
    beamHistory: BeamHistoryLike = {
      add: (beam) => beamStore.add(beam),
      update: (id, changes) => beamStore.update(id, changes),
      remove: (id) => beamStore.remove(id)
    },
    slabStore: SlabStore = new SlabStore(),
    slabHistory: SlabHistoryLike = {
      add: (slab) => slabStore.add(slab),
      update: (id, changes) => slabStore.update(id, changes),
      remove: (id) => slabStore.remove(id)
    },
    doorStore: DoorStore = new DoorStore(),
    doorHistory: DoorHistoryLike = {
      add: (door) => doorStore.add(door),
      update: (id, changes) => doorStore.update(id, changes),
      remove: (id) => doorStore.remove(id)
    },
    windowStore: WindowStore = new WindowStore(),
    windowHistory: WindowHistoryLike = {
      add: (windowData) => windowStore.add(windowData),
      update: (id, changes) => windowStore.update(id, changes),
      remove: (id) => windowStore.remove(id)
    }
  ) {
    this.wallStore = wallStore;
    this.wallHistory = wallHistory;
    this.assemblyStore = assemblyStore;
    this.pillarStore = pillarStore;
    this.pillarHistory = pillarHistory;
    this.beamStore = beamStore;
    this.beamHistory = beamHistory;
    this.slabStore = slabStore;
    this.slabHistory = slabHistory;
    this.doorStore = doorStore;
    this.doorHistory = doorHistory;
    this.windowStore = windowStore;
    this.windowHistory = windowHistory;
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
      case "beam.add":
        return this.executeAddBeam(input);
      case "beam.update":
        return this.executeUpdateBeam(input);
      case "beam.delete":
        return this.executeDeleteBeam(input);
      case "beam.duplicate":
        return this.executeDuplicateBeam(input);
      case "slab.add":
        return this.executeAddSlab(input);
      case "slab.update":
        return this.executeUpdateSlab(input);
      case "slab.delete":
        return this.executeDeleteSlab(input);
      case "slab.duplicate":
        return this.executeDuplicateSlab(input);
      case "door.add":
        return this.executeAddDoor(input);
      case "door.update":
        return this.executeUpdateDoor(input);
      case "door.delete":
        return this.executeDeleteDoor(input);
      case "door.duplicate":
        return this.executeDuplicateDoor(input);
      case "window.add":
        return this.executeAddWindow(input);
      case "window.update":
        return this.executeUpdateWindow(input);
      case "window.delete":
        return this.executeDeleteWindow(input);
      case "window.duplicate":
        return this.executeDuplicateWindow(input);
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
      case "update_object":
        return this.executeUpdateObject(input);
      default:
        return { success: false, message: `Unknown command type: "${(input as { type: string }).type}".` };
    }
  }

  /**
   * Edits an existing object of any type, by id (see UpdateObjectCommand).
   * A translation layer, not a new mutation path: it resolves the id
   * through the shared resolver, merges the partial change over the
   * object's current values, and hands the complete change to that type's
   * existing `<type>.update` command. Store validation, the grounding rule,
   * and the single history entry are therefore exactly what a UI edit
   * gets. It never creates an object, and never touches selection or
   * assembly membership.
   */
  private executeUpdateObject(command: UpdateObjectCommand): CommandResult {
    // The command arrived as untrusted data - check the id's real type.
    const objectId: unknown = command.objectId;
    if (typeof objectId !== "string" || objectId.length === 0) {
      return { success: false, message: "update_object command is missing an objectId." };
    }

    const resolved = resolveConstructionObject(objectId, {
      wallStore: this.wallStore,
      pillarStore: this.pillarStore,
      beamStore: this.beamStore,
      slabStore: this.slabStore,
      doorStore: this.doorStore,
      windowStore: this.windowStore
    });
    const current = resolved ? this.readConstructionObject(resolved.type, objectId) : undefined;
    if (!resolved || !current) {
      return { success: false, objectId, message: `No construction object found with id "${objectId}".` };
    }

    const built = this.buildObjectChanges(current, command.changes);
    if (!built.ok) {
      return {
        success: false,
        objectId,
        errors: built.errors,
        message: `Could not update ${resolved.type}: unsupported change.`
      };
    }

    // The complete change runs through the type's own update command.
    return this.execute({ type: `${resolved.type}.update`, id: objectId, changes: built.changes });
  }

  /** The current state of an object resolveConstructionObject() found - a copy from the store, never a live reference. */
  private readConstructionObject(
    type: string,
    id: string
  ): { dimensions: object; position: { x: number; y: number; z: number } } | undefined {
    switch (type) {
      case "wall":
        return this.wallStore.get(id);
      case "pillar":
        return this.pillarStore.get(id);
      case "beam":
        return this.beamStore.get(id);
      case "slab":
        return this.slabStore.get(id);
      case "door":
        return this.doorStore.get(id);
      case "window":
        return this.windowStore.get(id);
      default:
        return undefined;
    }
  }

  /**
   * Checks an untrusted `changes` object against the object's current
   * state and merges it into a complete change for the type's update
   * command. Only properties the object already has are accepted:
   * dimensions it already has, x/y/z position, rotation around the
   * vertical axis, material, and color.
   *
   * Types are checked here; ranges and formats (positive dimensions,
   * finite numbers, hex colors) are left to the store's own validator.
   * The one exception is material: validateWall doesn't check it (the
   * other five validators do), so a non-empty string is required here
   * rather than letting an edit blank a wall's material.
   *
   * Position is only sent when the change includes it, so a dimensions-only
   * change still gets the store's grounding rule (see WallStore.update).
   */
  private buildObjectChanges(
    current: { dimensions: object; position: { x: number; y: number; z: number } },
    raw: unknown
  ): { ok: true; changes: Record<string, unknown> } | { ok: false; errors: { field: string; message: string }[] } {
    const isPlainObject = (value: unknown): value is Record<string, unknown> =>
      typeof value === "object" && value !== null && !Array.isArray(value);

    if (!isPlainObject(raw)) {
      return { ok: false, errors: [{ field: "changes", message: "changes must be an object." }] };
    }

    const errors: { field: string; message: string }[] = [];
    const changes: Record<string, unknown> = {};
    const currentDimensions = current.dimensions as Record<string, unknown>;

    for (const [key, value] of Object.entries(raw)) {
      switch (key) {
        case "dimensions": {
          if (!isPlainObject(value)) {
            errors.push({ field: "changes.dimensions", message: "dimensions must be an object." });
            break;
          }
          const merged: Record<string, unknown> = { ...currentDimensions };
          for (const [dimension, amount] of Object.entries(value)) {
            if (!Object.prototype.hasOwnProperty.call(currentDimensions, dimension)) {
              errors.push({
                field: `changes.dimensions.${dimension}`,
                message: `"${dimension}" is not a dimension of this object.`
              });
            } else if (typeof amount !== "number") {
              errors.push({ field: `changes.dimensions.${dimension}`, message: `"${dimension}" must be a number.` });
            } else {
              merged[dimension] = amount;
            }
          }
          changes.dimensions = merged;
          break;
        }
        case "position": {
          if (!isPlainObject(value)) {
            errors.push({ field: "changes.position", message: "position must be an object." });
            break;
          }
          const merged = { ...current.position };
          for (const [axis, amount] of Object.entries(value)) {
            if (axis !== "x" && axis !== "y" && axis !== "z") {
              errors.push({ field: `changes.position.${axis}`, message: `"${axis}" is not a position axis - use x, y, or z.` });
            } else if (typeof amount !== "number") {
              errors.push({ field: `changes.position.${axis}`, message: `position.${axis} must be a number.` });
            } else {
              merged[axis] = amount;
            }
          }
          changes.position = merged;
          break;
        }
        case "rotation": {
          const radians = isPlainObject(value) && Object.keys(value).length === 1 && "y" in value ? value.y : value;
          if (typeof radians !== "number") {
            errors.push({
              field: "changes.rotation",
              message: 'rotation must be radians around the vertical axis - a number, or { "y": radians }. The model has no other rotation.'
            });
          } else {
            changes.rotation = radians;
          }
          break;
        }
        case "material":
          if (typeof value !== "string" || value.trim().length === 0) {
            errors.push({ field: "changes.material", message: "material must be a non-empty string." });
          } else {
            changes.material = value;
          }
          break;
        case "color":
          if (typeof value !== "string") {
            errors.push({ field: "changes.color", message: "color must be a string, e.g. #c9c9c9." });
          } else {
            changes.color = value;
          }
          break;
        default:
          errors.push({ field: `changes.${key}`, message: `"${key}" is not an editable property.` });
      }
    }

    if (errors.length > 0) {
      return { ok: false, errors };
    }
    if (Object.keys(changes).length === 0) {
      return { ok: false, errors: [{ field: "changes", message: "changes must include at least one property to edit." }] };
    }
    return { ok: true, changes };
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

  private executeAddBeam(command: AddBeamCommand): CommandResult {
    const beam = createBeamData(command.beam ?? {});
    const result = this.beamHistory.add(beam);

    if (!result.valid) {
      return { success: false, errors: result.errors, message: "Could not add beam: validation failed." };
    }
    return { success: true, objectId: beam.id, message: "Beam added." };
  }

  private executeUpdateBeam(command: UpdateBeamCommand): CommandResult {
    if (!command.id) {
      return { success: false, message: "beam.update command is missing an id." };
    }

    const result = this.beamHistory.update(command.id, command.changes ?? {});
    if (!result.valid) {
      return {
        success: false,
        objectId: command.id,
        errors: result.errors,
        message: "Could not update beam: validation failed."
      };
    }
    return { success: true, objectId: command.id, message: "Beam updated." };
  }

  private executeDeleteBeam(command: DeleteBeamCommand): CommandResult {
    if (!command.id) {
      return { success: false, message: "beam.delete command is missing an id." };
    }

    const existing = this.beamStore.get(command.id);
    if (!existing) {
      return { success: false, objectId: command.id, message: `No beam found with id "${command.id}".` };
    }

    this.beamHistory.remove(command.id);
    return { success: true, objectId: command.id, message: "Beam deleted." };
  }

  private executeDuplicateBeam(command: DuplicateBeamCommand): CommandResult {
    if (!command.id) {
      return { success: false, message: "beam.duplicate command is missing an id." };
    }

    const source = this.beamStore.get(command.id);
    if (!source) {
      return { success: false, objectId: command.id, message: `No beam found with id "${command.id}".` };
    }

    const duplicate = duplicateBeamData(source);
    const result = this.beamHistory.add(duplicate);
    if (!result.valid) {
      // duplicateBeamData() always produces valid data from an already-valid
      // source beam, so this shouldn't happen in practice - stay defensive.
      return {
        success: false,
        objectId: command.id,
        errors: result.errors,
        message: "Could not duplicate beam: validation failed."
      };
    }
    return { success: true, objectId: duplicate.id, message: "Beam duplicated." };
  }

  private executeAddSlab(command: AddSlabCommand): CommandResult {
    const slab = createSlabData(command.slab ?? {});
    const result = this.slabHistory.add(slab);

    if (!result.valid) {
      return { success: false, errors: result.errors, message: "Could not add slab: validation failed." };
    }
    return { success: true, objectId: slab.id, message: "Slab added." };
  }

  private executeUpdateSlab(command: UpdateSlabCommand): CommandResult {
    if (!command.id) {
      return { success: false, message: "slab.update command is missing an id." };
    }

    const result = this.slabHistory.update(command.id, command.changes ?? {});
    if (!result.valid) {
      return {
        success: false,
        objectId: command.id,
        errors: result.errors,
        message: "Could not update slab: validation failed."
      };
    }
    return { success: true, objectId: command.id, message: "Slab updated." };
  }

  private executeDeleteSlab(command: DeleteSlabCommand): CommandResult {
    if (!command.id) {
      return { success: false, message: "slab.delete command is missing an id." };
    }

    const existing = this.slabStore.get(command.id);
    if (!existing) {
      return { success: false, objectId: command.id, message: `No slab found with id "${command.id}".` };
    }

    this.slabHistory.remove(command.id);
    return { success: true, objectId: command.id, message: "Slab deleted." };
  }

  private executeDuplicateSlab(command: DuplicateSlabCommand): CommandResult {
    if (!command.id) {
      return { success: false, message: "slab.duplicate command is missing an id." };
    }

    const source = this.slabStore.get(command.id);
    if (!source) {
      return { success: false, objectId: command.id, message: `No slab found with id "${command.id}".` };
    }

    const duplicate = duplicateSlabData(source);
    const result = this.slabHistory.add(duplicate);
    if (!result.valid) {
      // duplicateSlabData() always produces valid data from an already-valid
      // source slab, so this shouldn't happen in practice - stay defensive.
      return {
        success: false,
        objectId: command.id,
        errors: result.errors,
        message: "Could not duplicate slab: validation failed."
      };
    }
    return { success: true, objectId: duplicate.id, message: "Slab duplicated." };
  }

  private executeAddDoor(command: AddDoorCommand): CommandResult {
    const door = createDoorData(command.door ?? {});
    const result = this.doorHistory.add(door);

    if (!result.valid) {
      return { success: false, errors: result.errors, message: "Could not add door: validation failed." };
    }
    return { success: true, objectId: door.id, message: "Door added." };
  }

  private executeUpdateDoor(command: UpdateDoorCommand): CommandResult {
    if (!command.id) {
      return { success: false, message: "door.update command is missing an id." };
    }

    const result = this.doorHistory.update(command.id, command.changes ?? {});
    if (!result.valid) {
      return {
        success: false,
        objectId: command.id,
        errors: result.errors,
        message: "Could not update door: validation failed."
      };
    }
    return { success: true, objectId: command.id, message: "Door updated." };
  }

  private executeDeleteDoor(command: DeleteDoorCommand): CommandResult {
    if (!command.id) {
      return { success: false, message: "door.delete command is missing an id." };
    }

    const existing = this.doorStore.get(command.id);
    if (!existing) {
      return { success: false, objectId: command.id, message: `No door found with id "${command.id}".` };
    }

    this.doorHistory.remove(command.id);
    return { success: true, objectId: command.id, message: "Door deleted." };
  }

  private executeDuplicateDoor(command: DuplicateDoorCommand): CommandResult {
    if (!command.id) {
      return { success: false, message: "door.duplicate command is missing an id." };
    }

    const source = this.doorStore.get(command.id);
    if (!source) {
      return { success: false, objectId: command.id, message: `No door found with id "${command.id}".` };
    }

    const duplicate = duplicateDoorData(source);
    const result = this.doorHistory.add(duplicate);
    if (!result.valid) {
      // duplicateDoorData() always produces valid data from an already-valid
      // source door, so this shouldn't happen in practice - stay defensive.
      return {
        success: false,
        objectId: command.id,
        errors: result.errors,
        message: "Could not duplicate door: validation failed."
      };
    }
    return { success: true, objectId: duplicate.id, message: "Door duplicated." };
  }

  private executeAddWindow(command: AddWindowCommand): CommandResult {
    const windowData = createWindowData(command.window ?? {});
    const result = this.windowHistory.add(windowData);

    if (!result.valid) {
      return { success: false, errors: result.errors, message: "Could not add window: validation failed." };
    }
    return { success: true, objectId: windowData.id, message: "Window added." };
  }

  private executeUpdateWindow(command: UpdateWindowCommand): CommandResult {
    if (!command.id) {
      return { success: false, message: "window.update command is missing an id." };
    }

    const result = this.windowHistory.update(command.id, command.changes ?? {});
    if (!result.valid) {
      return {
        success: false,
        objectId: command.id,
        errors: result.errors,
        message: "Could not update window: validation failed."
      };
    }
    return { success: true, objectId: command.id, message: "Window updated." };
  }

  private executeDeleteWindow(command: DeleteWindowCommand): CommandResult {
    if (!command.id) {
      return { success: false, message: "window.delete command is missing an id." };
    }

    const existing = this.windowStore.get(command.id);
    if (!existing) {
      return { success: false, objectId: command.id, message: `No window found with id "${command.id}".` };
    }

    this.windowHistory.remove(command.id);
    return { success: true, objectId: command.id, message: "Window deleted." };
  }

  private executeDuplicateWindow(command: DuplicateWindowCommand): CommandResult {
    if (!command.id) {
      return { success: false, message: "window.duplicate command is missing an id." };
    }

    const source = this.windowStore.get(command.id);
    if (!source) {
      return { success: false, objectId: command.id, message: `No window found with id "${command.id}".` };
    }

    const duplicate = duplicateWindowData(source);
    const result = this.windowHistory.add(duplicate);
    if (!result.valid) {
      // duplicateWindowData() always produces valid data from an already-valid
      // source window, so this shouldn't happen in practice - stay defensive.
      return {
        success: false,
        objectId: command.id,
        errors: result.errors,
        message: "Could not duplicate window: validation failed."
      };
    }
    return { success: true, objectId: duplicate.id, message: "Window duplicated." };
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
