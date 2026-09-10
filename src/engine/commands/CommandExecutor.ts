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
import { createElementData, duplicateElementData } from "../elements/createElement.ts";
import { ElementStore } from "../elements/ElementStore.ts";
import { getElementKind } from "../elements/catalog.ts";
import { AssemblyStore, createAssemblyData } from "../assemblies/AssemblyStore.ts";
import { validateWall } from "../wall/validateWall.ts";
import { validateElement } from "../elements/validateElement.ts";
import { keepBaseY } from "../objects/grounding.ts";
import {
  WINDOW_SILL_HEIGHT,
  clampPlacement,
  findFreeOffset,
  hostedTransform,
  hostingProblems,
  placementFromWorld,
  placementNear
} from "../openings/hostOpening.ts";
import {
  CONNECTION_TOLERANCE,
  ENDPOINTS,
  endpointsOf,
  horizontalDistance,
  isConnectable,
  jointMembers,
  kindsConnect,
  moveEndpoint,
  networkOf
} from "../connections/connections.ts";
import { keyPointsOf } from "../snapping/snapping.ts";
import type { HostPlacement, HostedOpening, OpeningSize } from "../openings/hostOpening";
import type { SnapObject, SnapPoint } from "../snapping/snapping";
import type { WallData } from "../wall/types";
import type { DoorData } from "../door/types";
import type { WindowData } from "../window/types";
import type { CreateDoorOptions } from "../door/createDoor";
import type { ElementData, Endpoint } from "../elements/types";
import type { ElementChanges } from "../elements/ElementStore";
import type {
  ConnectElementsCommand,
  DisconnectElementsCommand,
  AlignObjectsCommand,
  SnapObjectCommand,
  HistoryGroupsLike
} from "./types";
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
  DeleteDoorCommand,
  DuplicateDoorCommand,
  DeleteWindowCommand,
  DuplicateWindowCommand,
  AddElementCommand,
  UpdateElementCommand,
  DeleteElementCommand,
  DuplicateElementCommand,
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
  WindowHistoryLike,
  ElementHistoryLike
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
  "element.add",
  "element.update",
  "element.delete",
  "element.duplicate",
  "element.connect",
  "element.disconnect",
  "object.align",
  "object.snap",
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function round(value: number): number {
  const rounded = Math.round(value * 1e9) / 1e9;
  return rounded === 0 ? 0 : rounded;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Whether two rotations around Y are the same direction. */
function sameAngle(a: number, b: number): boolean {
  const turn = 2 * Math.PI;
  const difference = (((a - b) % turn) + turn) % turn;
  return difference < 1e-6 || turn - difference < 1e-6;
}

function samePoint(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): boolean {
  return Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9 && Math.abs(a.z - b.z) < 1e-9;
}

/** The wall WallStore.update() would store for `changes` - its grounding rule included - without storing it. */
function previewWall(existing: WallData, changes: Partial<Omit<WallData, "id" | "type">>): WallData {
  let effective = changes;
  const height = changes.dimensions?.height;
  if (height !== undefined && height !== existing.dimensions.height && changes.position === undefined) {
    effective = { ...changes, position: { ...existing.position, y: keepBaseY(existing.position.y, existing.dimensions.height, height) } };
  }
  return { ...existing, ...effective };
}

/** The element ElementStore.update() would store for `changes`, without storing it. */
function previewElement(existing: ElementData, changes: ElementChanges): ElementData {
  let effective = changes;
  const definition = getElementKind(existing.kind);
  if (definition && !definition.linear && changes.position === undefined) {
    const key = definition.axes.y;
    const next = changes.dimensions?.[key];
    const current = existing.dimensions[key];
    if (next !== undefined && next !== current) {
      effective = { ...changes, position: { ...existing.position, y: keepBaseY(existing.position.y, current, next) } };
    }
  }
  return { ...existing, ...effective };
}

type OpeningType = "door" | "window";
type OpeningRecord = DoorData | WindowData;

function fail(message: string, objectId?: string, errors?: { field: string; message: string }[]): CommandResult {
  return { success: false, ...(objectId !== undefined ? { objectId } : {}), ...(errors ? { errors } : {}), message };
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
 * windowStore/windowHistory, and elementStore/elementHistory all follow
 * the exact same defaulting idea as pillarStore/pillarHistory - see the
 * paragraph above. The element pair serves every catalog kind (see
 * elements/catalog.ts) through the "element.*" commands.
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
  private readonly elementStore: ElementStore;
  private readonly elementHistory: ElementHistoryLike;
  private readonly assemblyStore: AssemblyStore;
  private readonly historyGroups: HistoryGroupsLike | undefined;

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
    },
    elementStore: ElementStore = new ElementStore(),
    elementHistory: ElementHistoryLike = {
      add: (element) => elementStore.add(element),
      update: (id, changes) => elementStore.update(id, changes),
      remove: (id) => elementStore.remove(id)
    },
    /**
     * The shared HistoryManager (see ProjectContext), so a change spanning
     * several objects is one undo step. Optional: without it each object's
     * change is still recorded, just as separate entries.
     */
    historyGroups?: HistoryGroupsLike
  ) {
    this.historyGroups = historyGroups;
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
    this.elementStore = elementStore;
    this.elementHistory = elementHistory;
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
        return this.executeAddOpening("door", input.door);
      case "door.update":
        return this.executeUpdateOpening("door", input.id, input.changes);
      case "door.delete":
        return this.executeDeleteDoor(input);
      case "door.duplicate":
        return this.executeDuplicateDoor(input);
      case "window.add":
        return this.executeAddOpening("window", input.window);
      case "window.update":
        return this.executeUpdateOpening("window", input.id, input.changes);
      case "window.delete":
        return this.executeDeleteWindow(input);
      case "window.duplicate":
        return this.executeDuplicateWindow(input);
      case "element.add":
        return this.executeAddElement(input);
      case "element.update":
        return this.executeUpdateElement(input);
      case "element.delete":
        return this.executeDeleteElement(input);
      case "element.duplicate":
        return this.executeDuplicateElement(input);
      case "element.connect":
        return this.executeConnect(input);
      case "element.disconnect":
        return this.executeDisconnect(input);
      case "object.align":
        return this.executeAlign(input);
      case "object.snap":
        return this.executeSnap(input);
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

    const resolved = resolveConstructionObject(objectId, this.stores());
    const current = resolved ? this.readConstructionObject(resolved.type, objectId) : undefined;
    if (!resolved || !current) {
      return { success: false, objectId, message: `No construction object found with id "${objectId}".` };
    }

    const built = this.buildObjectChanges(current, command.changes, resolved.type);
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
  ): { dimensions: object; position: { x: number; y: number; z: number }; params?: object } | undefined {
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
      case "element":
        return this.elementStore.get(id);
      default:
        return undefined;
    }
  }

  /**
   * Checks an untrusted `changes` object against the object's current
   * state and merges it into a complete change for the type's update
   * command. Only properties the object already has are accepted:
   * dimensions it already has, x/y/z position, rotation around the
   * vertical axis, material, and color - plus, for an element, its label
   * and parameters.
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
    current: { dimensions: object; position: { x: number; y: number; z: number }; params?: object },
    raw: unknown,
    type: string
  ): { ok: true; changes: Record<string, unknown> } | { ok: false; errors: { field: string; message: string }[] } {
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
        case "label":
          if (type !== "element") {
            errors.push({ field: "changes.label", message: '"label" is not an editable property.' });
          } else if (typeof value !== "string" || value.trim().length === 0) {
            errors.push({ field: "changes.label", message: "label must be a non-empty string." });
          } else {
            changes.label = value.trim();
          }
          break;
        case "params":
          if (type !== "element") {
            errors.push({ field: "changes.params", message: '"params" is not an editable property.' });
          } else if (!isPlainObject(value)) {
            errors.push({ field: "changes.params", message: "params must be an object." });
          } else {
            changes.params = { ...(current.params as Record<string, unknown> | undefined), ...value };
          }
          break;
        case "hostId":
          if (type !== "door" && type !== "window") {
            errors.push({ field: "changes.hostId", message: '"hostId" is only editable on doors and windows.' });
          } else if (value !== null && (typeof value !== "string" || value.length === 0)) {
            errors.push({ field: "changes.hostId", message: "hostId must be a wall id, or null." });
          } else {
            changes.hostId = value;
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

  /**
   * Updates a wall. The doors and windows in it follow: each keeps its
   * placement (its offset pulled back onto a shortened wall) and its world
   * transform is re-derived from the updated wall - all one undo step. A
   * change that would leave an opening that no longer fits (the wall too
   * short or too low for it, or two openings overlapping) is rejected,
   * and nothing changes.
   */
  private executeUpdateWall(command: UpdateWallCommand): CommandResult {
    if (!command.id) {
      return { success: false, message: "wall.update command is missing an id." };
    }

    const id = command.id;
    const changes = command.changes ?? {};
    const existing = this.wallStore.get(id);
    const openings = existing ? this.openingsIn(id) : [];

    if (!existing || openings.length === 0) {
      const result = this.wallHistory.update(id, changes);
      if (!result.valid) {
        return fail("Could not update wall: validation failed.", id, result.errors);
      }
      return { success: true, objectId: id, message: "Wall updated." };
    }

    const preview = previewWall(existing, changes);
    const wallCheck = validateWall(preview);
    if (!wallCheck.valid) {
      return fail("Could not update wall: validation failed.", id, wallCheck.errors);
    }
    const planned = openings.map(({ type, record }) => ({
      type,
      record,
      placement: clampPlacement(preview, record.dimensions, record.hostPlacement ?? placementFromWorld(existing, record.dimensions, record.position))
    }));
    for (const item of planned) {
      const others: HostedOpening[] = planned
        .filter((other) => other !== item)
        .map((other) => ({ id: other.record.id, size: other.record.dimensions, placement: other.placement }));
      const problems = hostingProblems(preview, { id: item.record.id, size: item.record.dimensions }, item.placement, others);
      if (problems.length > 0) {
        return fail(`Can't change ${id}: ${problems[0]}`, id, problems.map((message) => ({ field: "openings", message })));
      }
    }

    return this.atomically(() => {
      const result = this.wallHistory.update(id, changes);
      if (!result.valid) {
        return fail("Could not update wall: validation failed.", id, result.errors);
      }
      const wall = this.wallStore.get(id) as WallData;
      for (const item of planned) {
        const transform = hostedTransform(wall, item.record.dimensions, item.placement);
        const unchanged =
          samePoint(transform.position, item.record.position) &&
          transform.rotation === item.record.rotation &&
          item.record.hostPlacement?.offset === item.placement.offset &&
          item.record.hostPlacement?.sill === item.placement.sill;
        if (unchanged) {
          continue;
        }
        const moved = this.updateOpeningRecord(item.type, item.record.id, {
          position: transform.position,
          rotation: transform.rotation,
          hostPlacement: item.placement
        });
        if (!moved.valid) {
          return fail(`Could not move ${item.record.id} with its wall.`, item.record.id, moved.errors);
        }
      }
      return { success: true, objectId: id, message: "Wall updated." };
    });
  }

  /**
   * Deletes a wall, and the doors and windows in it: a hosted opening
   * never outlives its wall (a door floating where a wall used to be is
   * not a valid building). One undo step brings them all back, still
   * hosted.
   */
  private executeDeleteWall(command: DeleteWallCommand): CommandResult {
    if (!command.id) {
      return { success: false, message: "wall.delete command is missing an id." };
    }

    const id = command.id;
    const existing = this.wallStore.get(id);
    if (!existing) {
      return { success: false, objectId: id, message: `No wall found with id "${id}".` };
    }

    const openings = this.openingsIn(id);
    return this.atomically(() => {
      for (const { type, record } of openings) {
        this.removeOpeningRecord(type, record.id);
      }
      this.wallHistory.remove(id);
      const count = openings.length;
      return {
        success: true,
        objectId: id,
        message: count === 0 ? "Wall deleted." : `Wall deleted, with the ${count} opening${count === 1 ? "" : "s"} in it.`
      };
    });
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

  // --- Doors and windows, free-standing or in a wall ---

  private getOpening(type: OpeningType, id: string): OpeningRecord | undefined {
    return type === "door" ? this.doorStore.get(id) : this.windowStore.get(id);
  }

  private addOpeningRecord(type: OpeningType, record: OpeningRecord): { valid: boolean; errors: { field: string; message: string }[] } {
    return type === "door" ? this.doorHistory.add(record as DoorData) : this.windowHistory.add(record as WindowData);
  }

  private updateOpeningRecord(
    type: OpeningType,
    id: string,
    changes: Record<string, unknown>
  ): { valid: boolean; errors: { field: string; message: string }[] } {
    return type === "door"
      ? this.doorHistory.update(id, changes as Partial<Omit<DoorData, "id" | "type">>)
      : this.windowHistory.update(id, changes as Partial<Omit<WindowData, "id" | "type">>);
  }

  private removeOpeningRecord(type: OpeningType, id: string): void {
    if (type === "door") {
      this.doorHistory.remove(id);
    } else {
      this.windowHistory.remove(id);
    }
  }

  /** Every door and window in wall `wallId`. */
  private openingsIn(wallId: string): { type: OpeningType; record: OpeningRecord }[] {
    return [
      ...this.doorStore.getAll().filter((door) => door.hostId === wallId).map((record) => ({ type: "door" as const, record })),
      ...this.windowStore.getAll().filter((windowData) => windowData.hostId === wallId).map((record) => ({ type: "window" as const, record }))
    ];
  }

  /** The other openings in `wall`, as the fit checks see them. */
  private siblingsIn(wall: WallData, excludeId: string): HostedOpening[] {
    return this.openingsIn(wall.id)
      .filter(({ record }) => record.id !== excludeId)
      .map(({ record }) => ({
        id: record.id,
        size: record.dimensions,
        placement: record.hostPlacement ?? placementFromWorld(wall, record.dimensions, record.position)
      }));
  }

  /** Why `id` can't host an opening. */
  private notAWall(id: string): string {
    const resolved = resolveConstructionObject(id, this.stores());
    return resolved ? `"${id}" is a ${resolved.type}, not a wall` : `no wall has the id "${id}"`;
  }

  /**
   * door.add / window.add. Without a hostId the opening is free-standing,
   * exactly as before. With one, it goes into that wall: `offset` and
   * `sill` place it (a position is projected onto the wall instead; with
   * neither, the first free spot from the wall's center, at the default
   * sill - 0 for a door, 0.9 m for a window), its position and rotation
   * are derived from the wall, and it's rejected if it doesn't fit or
   * would overlap another opening in the wall.
   */
  private executeAddOpening(type: OpeningType, raw: unknown): CommandResult {
    const options = (isPlainObject(raw) ? raw : {}) as CreateDoorOptions;
    const hostId = options.hostId ?? null;
    const free = { ...options, hostId: null, hostPlacement: null };
    const record: OpeningRecord = type === "door" ? createDoorData(free) : createWindowData(free);

    if (hostId === null) {
      const result = this.addOpeningRecord(type, record);
      if (!result.valid) {
        return fail(`Could not add ${type}: validation failed.`, undefined, result.errors);
      }
      return { success: true, objectId: record.id, message: `${capitalize(type)} added.` };
    }
    if (typeof hostId !== "string" || hostId.length === 0) {
      return fail("hostId must be a wall id.");
    }
    const wall = this.wallStore.get(hostId);
    if (!wall) {
      return fail(`Can't put the ${type} in a wall: ${this.notAWall(hostId)}.`);
    }

    const size = record.dimensions;
    const others = this.siblingsIn(wall, record.id);
    const position = isPlainObject(options.position) ? options.position : undefined;
    const defaultSill = type === "window" ? WINDOW_SILL_HEIGHT : 0;
    const sill =
      typeof options.sill === "number"
        ? options.sill
        : typeof position?.y === "number"
          ? placementNear(wall, size, { x: wall.position.x, y: position.y, z: wall.position.z }, defaultSill).sill
          : defaultSill;
    let offset: number | null;
    if (typeof options.offset === "number") {
      offset = options.offset;
    } else if (position && (typeof position.x === "number" || typeof position.z === "number")) {
      offset = placementNear(wall, size, { x: position.x ?? wall.position.x, z: position.z ?? wall.position.z }, sill).offset;
    } else {
      offset = findFreeOffset(wall, { id: record.id, size }, sill, others);
    }
    if (offset === null) {
      // Say why: it can't fit this wall at all, or the wall is full.
      const fit = hostingProblems(wall, { id: record.id, size }, { offset: 0, sill: round(sill) }, []);
      return fail(
        fit.length > 0 ? `Can't put the ${type} in ${wall.id}: ${fit[0]}` : `There's no room left in ${wall.id} for a ${size.width} m wide ${type}.`
      );
    }

    const placement: HostPlacement = { offset: round(offset), sill: round(sill) };
    const problems = hostingProblems(wall, { id: record.id, size }, placement, others);
    if (problems.length > 0) {
      return fail(`Can't put the ${type} in ${wall.id}: ${problems[0]}`, undefined, problems.map((message) => ({ field: "hostPlacement", message })));
    }
    const transform = hostedTransform(wall, size, placement);
    const hosted = { ...record, position: transform.position, rotation: transform.rotation, hostId: wall.id, hostPlacement: placement };
    const result = this.addOpeningRecord(type, hosted);
    if (!result.valid) {
      return fail(`Could not add ${type}: validation failed.`, undefined, result.errors);
    }
    return { success: true, objectId: record.id, message: `${capitalize(type)} added to ${wall.id}.` };
  }

  /**
   * door.update / window.update. A free-standing opening updates as
   * before. An opening in a wall stays constrained to it: a new position
   * is projected onto the wall (it slides along it, and its height sets
   * the sill), a new size keeps its placement, `hostPlacement` sets offset
   * and sill directly, and its rotation always follows the wall - asking
   * for another is rejected. `hostId` moves it into another wall, or with
   * null takes it out (it stays where it is).
   */
  private executeUpdateOpening(type: OpeningType, rawId: unknown, rawChanges: unknown): CommandResult {
    if (typeof rawId !== "string" || rawId.length === 0) {
      return { success: false, message: `${type}.update command is missing an id.` };
    }
    const id = rawId;
    const existing = this.getOpening(type, id);
    if (!existing) {
      const result = this.updateOpeningRecord(type, id, {});
      return fail(`Could not update ${type}: validation failed.`, id, result.errors);
    }

    const changes: Record<string, unknown> = isPlainObject(rawChanges) ? { ...rawChanges } : {};
    const hostChange = Object.prototype.hasOwnProperty.call(changes, "hostId");
    const targetHost = hostChange ? changes.hostId : existing.hostId;

    if (targetHost === null || targetHost === undefined) {
      if (existing.hostId !== null || hostChange) {
        changes.hostId = null;
        changes.hostPlacement = null;
      } else if (changes.hostPlacement !== undefined && changes.hostPlacement !== null) {
        return fail(`${id} isn't in a wall - give it a hostId first.`, id);
      }
      return this.finishOpeningUpdate(type, id, changes);
    }
    if (typeof targetHost !== "string" || targetHost.length === 0) {
      return fail("hostId must be a wall id, or null.", id);
    }
    const wall = this.wallStore.get(targetHost);
    if (!wall) {
      return fail(`Can't put ${id} in a wall: ${this.notAWall(targetHost)}.`, id);
    }
    if (typeof changes.rotation === "number" && !sameAngle(changes.rotation, wall.rotation)) {
      return fail(`${id} is in ${wall.id} and turns with it - rotate the wall instead.`, id);
    }

    const size = (isPlainObject(changes.dimensions) ? changes.dimensions : existing.dimensions) as unknown as OpeningSize;
    const defaultSill = type === "window" ? WINDOW_SILL_HEIGHT : 0;
    const sameWall = existing.hostId === wall.id;
    const currentSill = existing.hostPlacement?.sill ?? defaultSill;
    let placement: HostPlacement;
    if (isPlainObject(changes.hostPlacement)) {
      const base = sameWall && existing.hostPlacement ? existing.hostPlacement : { offset: 0, sill: defaultSill };
      const wanted = changes.hostPlacement;
      placement = {
        offset: typeof wanted.offset === "number" ? wanted.offset : base.offset,
        sill: typeof wanted.sill === "number" ? wanted.sill : base.sill
      };
    } else if (isPlainObject(changes.position)) {
      const point = changes.position;
      placement = placementNear(
        wall,
        size,
        {
          x: typeof point.x === "number" ? point.x : existing.position.x,
          ...(typeof point.y === "number" ? { y: point.y } : {}),
          z: typeof point.z === "number" ? point.z : existing.position.z
        },
        currentSill
      );
    } else if (!sameWall) {
      placement = placementNear(wall, size, { x: existing.position.x, z: existing.position.z }, currentSill);
    } else {
      placement = clampPlacement(wall, size, existing.hostPlacement ?? placementFromWorld(wall, size, existing.position));
    }
    placement = { offset: round(placement.offset), sill: round(placement.sill) };

    const problems = hostingProblems(wall, { id, size }, placement, this.siblingsIn(wall, id));
    if (problems.length > 0) {
      return fail(`Can't place ${id}: ${problems[0]}`, id, problems.map((message) => ({ field: "hostPlacement", message })));
    }
    const transform = hostedTransform(wall, size, placement);
    return this.finishOpeningUpdate(type, id, {
      ...changes,
      hostId: wall.id,
      hostPlacement: placement,
      position: transform.position,
      rotation: transform.rotation
    });
  }

  private finishOpeningUpdate(type: OpeningType, id: string, changes: Record<string, unknown>): CommandResult {
    const result = this.updateOpeningRecord(type, id, changes);
    if (!result.valid) {
      return fail(`Could not update ${type}: validation failed.`, id, result.errors);
    }
    return { success: true, objectId: id, message: `${capitalize(type)} updated.` };
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

  /**
   * Adds an element of any catalog kind. The kind is checked first (an
   * unknown kind has no defaults to build from), then createElementData()
   * fills in the catalog's defaults and ElementStore validates the result
   * like any write.
   */
  private executeAddElement(command: AddElementCommand): CommandResult {
    const options: unknown = command.element;
    if (!isPlainObject(options)) {
      return { success: false, message: "element.add command is missing its element." };
    }
    const definition = getElementKind(options.kind as string);
    if (!definition) {
      return { success: false, message: `Unknown element kind "${String(options.kind)}".` };
    }

    const element = createElementData(command.element);
    const result = this.elementHistory.add(element);
    if (!result.valid) {
      return {
        success: false,
        errors: result.errors,
        message: `Could not add ${definition.label.toLowerCase()}: validation failed.`
      };
    }
    return { success: true, objectId: element.id, message: `${definition.label} added.` };
  }

  /**
   * Updates an element. For a connected one, the joints follow: moving an
   * endpoint (a move, turn, or new length) moves every endpoint joined to
   * it, and a new height moves its whole connected network to that height
   * - all checked before anything changes, and one undo step.
   */
  private executeUpdateElement(command: UpdateElementCommand): CommandResult {
    if (!command.id) {
      return { success: false, message: "element.update command is missing an id." };
    }
    const changes = (isPlainObject(command.changes) ? command.changes : {}) as ElementChanges;
    if (Object.prototype.hasOwnProperty.call(changes, "connections")) {
      return fail('Connections change only through "element.connect" and "element.disconnect".', command.id);
    }

    const existing = this.elementStore.get(command.id);
    if (existing && existing.connections.length > 0) {
      return this.updateJoinedElement(existing, changes);
    }

    const result = this.elementHistory.update(command.id, changes);
    if (!result.valid) {
      return fail("Could not update element: validation failed.", command.id, result.errors);
    }
    return { success: true, objectId: command.id, message: "Element updated." };
  }

  private updateJoinedElement(existing: ElementData, changes: ElementChanges): CommandResult {
    const preview = previewElement(existing, changes);
    const check = validateElement(preview);
    if (!check.valid) {
      return fail("Could not update element: validation failed.", existing.id, check.errors);
    }

    const all = new Map(this.elementStore.getAll().map((element) => [element.id, element]));
    const planned = new Map<string, ElementData>();
    const dy = preview.position.y - existing.position.y;
    if (Math.abs(dy) > 1e-9) {
      for (const id of networkOf(all, existing.id)) {
        const record = all.get(id);
        if (id !== existing.id && record) {
          planned.set(id, { ...record, position: { ...record.position, y: round(record.position.y + dy) } });
        }
      }
    }
    const before = endpointsOf(existing);
    const after = endpointsOf(preview);
    for (const endpoint of ENDPOINTS) {
      if (horizontalDistance(before[endpoint], after[endpoint]) <= 1e-9) {
        continue;
      }
      for (const member of jointMembers(all, { id: existing.id, endpoint })) {
        const record = member.id === existing.id ? undefined : planned.get(member.id) ?? all.get(member.id);
        if (record) {
          planned.set(member.id, { ...record, ...moveEndpoint(record, member.endpoint, after[endpoint]) });
        }
      }
    }
    for (const [id, record] of planned) {
      const neighborCheck = validateElement(record);
      if (!neighborCheck.valid) {
        const reason = neighborCheck.errors[0]?.message ?? "would be invalid.";
        return fail(`Can't change ${existing.id}: ${id} is joined to it, and then - ${reason}`, existing.id, neighborCheck.errors);
      }
    }

    return this.atomically(() => {
      const result = this.elementHistory.update(existing.id, changes);
      if (!result.valid) {
        return fail("Could not update element: validation failed.", existing.id, result.errors);
      }
      for (const [id, record] of planned) {
        const moved = this.elementHistory.update(id, { position: record.position, rotation: record.rotation, dimensions: record.dimensions });
        if (!moved.valid) {
          return fail(`Could not move ${id} with ${existing.id}.`, id, moved.errors);
        }
      }
      return { success: true, objectId: existing.id, message: "Element updated." };
    });
  }

  /** Deletes an element - and its connections, from the elements it was joined to. One undo step restores both. */
  private executeDeleteElement(command: DeleteElementCommand): CommandResult {
    if (!command.id) {
      return { success: false, message: "element.delete command is missing an id." };
    }

    const id = command.id;
    const existing = this.elementStore.get(id);
    if (!existing) {
      return { success: false, objectId: id, message: `No element found with id "${id}".` };
    }

    const neighbors = [...new Set(existing.connections.map((connection) => connection.objectId))];
    return this.atomically(() => {
      for (const neighborId of neighbors) {
        const neighbor = this.elementStore.get(neighborId);
        if (neighbor) {
          this.elementHistory.update(neighborId, { connections: neighbor.connections.filter((connection) => connection.objectId !== id) });
        }
      }
      this.elementHistory.remove(id);
      return { success: true, objectId: id, message: "Element deleted." };
    });
  }

  // --- Connections ---

  /** An untrusted endpoint reference, checked. */
  private readEndpointReference(raw: unknown, name: string): { id: string; endpoint?: Endpoint } | string {
    if (!isPlainObject(raw) || typeof raw.id !== "string" || raw.id.length === 0) {
      return `"${name}" must name an element: { "id": ..., "endpoint": "start" | "end" }.`;
    }
    if (raw.endpoint !== undefined && raw.endpoint !== "start" && raw.endpoint !== "end") {
      return `"${String(raw.endpoint)}" is not an endpoint - use "start" or "end".`;
    }
    return { id: raw.id, ...(raw.endpoint !== undefined ? { endpoint: raw.endpoint as Endpoint } : {}) };
  }

  /** Both elements of a connect/disconnect, checked: they exist, differ, and are connectable kinds. */
  private readConnectionPair(
    command: { from?: unknown; to?: unknown }
  ): { from: { id: string; endpoint?: Endpoint }; to: { id: string; endpoint?: Endpoint }; a: ElementData; b: ElementData } | CommandResult {
    const from = this.readEndpointReference(command.from, "from");
    if (typeof from === "string") {
      return fail(from);
    }
    const to = this.readEndpointReference(command.to, "to");
    if (typeof to === "string") {
      return fail(to);
    }
    if (from.id === to.id) {
      return fail(`${from.id} can't connect to itself.`, from.id);
    }
    const a = this.elementStore.get(from.id);
    const b = this.elementStore.get(to.id);
    for (const [ref, element] of [[from, a], [to, b]] as const) {
      if (!element) {
        return fail(`No element found with id "${ref.id}".`, ref.id);
      }
      if (!isConnectable(element.kind)) {
        return fail(`${element.id} (${element.label}) has no endpoints to connect.`, element.id);
      }
    }
    return { from, to, a: a as ElementData, b: b as ElementData };
  }

  /**
   * element.connect: joins two compatible endpoints within
   * CONNECTION_TOLERANCE. `from`'s endpoint is snapped onto `to`'s (height
   * included - its connected network moves with it), then the connection
   * is recorded on both elements. One undo step.
   */
  private executeConnect(command: ConnectElementsCommand): CommandResult {
    const pair = this.readConnectionPair(command as unknown as { from?: unknown; to?: unknown });
    if ("success" in pair) {
      return pair;
    }
    const { from, to, a, b } = pair;
    if (!kindsConnect(a.kind, b.kind)) {
      const nameOf = (element: ElementData) => getElementKind(element.kind)?.label.toLowerCase() ?? element.kind;
      return fail(`A ${nameOf(a)} can't connect to a ${nameOf(b)}.`, a.id);
    }

    const aEnds = endpointsOf(a);
    const bEnds = endpointsOf(b);
    let best: { aEnd: Endpoint; bEnd: Endpoint; gap: number; rise: number } | null = null;
    for (const aEnd of from.endpoint ? [from.endpoint] : ENDPOINTS) {
      for (const bEnd of to.endpoint ? [to.endpoint] : ENDPOINTS) {
        const gap = horizontalDistance(aEnds[aEnd], bEnds[bEnd]);
        const rise = Math.abs(aEnds[aEnd].y - bEnds[bEnd].y);
        if (!best || Math.hypot(gap, rise) < Math.hypot(best.gap, best.rise) - 1e-12) {
          best = { aEnd, bEnd, gap, rise };
        }
      }
    }
    const { aEnd, bEnd, gap, rise } = best as { aEnd: Endpoint; bEnd: Endpoint; gap: number; rise: number };
    if (a.connections.some((connection) => connection.endpoint === aEnd && connection.objectId === b.id)) {
      return fail(`${a.id} ${aEnd} is already connected to ${b.id}.`, a.id);
    }
    if (gap > CONNECTION_TOLERANCE + 1e-9 || rise > CONNECTION_TOLERANCE + 1e-9) {
      const apart = Math.hypot(gap, rise).toFixed(2);
      return fail(
        `${a.id} ${aEnd} and ${b.id} ${bEnd} are ${apart} m apart - bring them within ${CONNECTION_TOLERANCE} m to connect them.`,
        a.id
      );
    }

    return this.atomically(() => {
      if (gap > 1e-9 || rise > 1e-9) {
        const snap = moveEndpoint(a, aEnd, bEnds[bEnd]);
        const snapped = this.executeUpdateElement({
          type: "element.update",
          id: a.id,
          changes: { ...snap, position: { ...snap.position, y: b.position.y } }
        });
        if (!snapped.success) {
          return snapped;
        }
      }
      const aNow = this.elementStore.get(a.id) as ElementData;
      const bNow = this.elementStore.get(b.id) as ElementData;
      const first = this.elementHistory.update(a.id, {
        connections: [...aNow.connections, { endpoint: aEnd, objectId: b.id, objectEndpoint: bEnd }]
      });
      if (!first.valid) {
        return fail(`Could not connect ${a.id}.`, a.id, first.errors);
      }
      const second = this.elementHistory.update(b.id, {
        connections: [...bNow.connections, { endpoint: bEnd, objectId: a.id, objectEndpoint: aEnd }]
      });
      if (!second.valid) {
        return fail(`Could not connect ${b.id}.`, b.id, second.errors);
      }
      return { success: true, objectId: a.id, message: `Connected ${a.id} ${aEnd} to ${b.id} ${bEnd}.` };
    });
  }

  /** element.disconnect: removes the connection(s) between two elements - only at the given endpoints, when given. Nothing moves. */
  private executeDisconnect(command: DisconnectElementsCommand): CommandResult {
    const pair = this.readConnectionPair(command as unknown as { from?: unknown; to?: unknown });
    if ("success" in pair) {
      return pair;
    }
    const { from, to, a, b } = pair;
    const matches = (endpoint: Endpoint, objectId: string, objectEndpoint: Endpoint, mine?: Endpoint, theirs?: Endpoint) =>
      objectId !== undefined && (mine === undefined || endpoint === mine) && (theirs === undefined || objectEndpoint === theirs);
    const removed = a.connections.filter(
      (connection) => connection.objectId === b.id && matches(connection.endpoint, connection.objectId, connection.objectEndpoint, from.endpoint, to.endpoint)
    );
    if (removed.length === 0) {
      return fail(`${a.id} isn't connected to ${b.id}${from.endpoint ? ` at its ${from.endpoint}` : ""}.`, a.id);
    }
    return this.atomically(() => {
      const keepA = a.connections.filter((connection) => !removed.includes(connection));
      const keepB = b.connections.filter(
        (connection) =>
          !(connection.objectId === a.id && removed.some((gone) => gone.endpoint === connection.objectEndpoint && gone.objectEndpoint === connection.endpoint))
      );
      const first = this.elementHistory.update(a.id, { connections: keepA });
      const second = this.elementHistory.update(b.id, { connections: keepB });
      if (!first.valid || !second.valid) {
        return fail(`Could not disconnect ${a.id} from ${b.id}.`, a.id, [...first.errors, ...second.errors]);
      }
      return { success: true, objectId: a.id, message: `Disconnected ${a.id} from ${b.id}.` };
    });
  }

  // --- Alignment and snapping helpers ---

  /** An object as the snapping helpers see it, or undefined when `id` is nothing. */
  private snapObjectOf(id: string): (SnapObject & { hostId?: string | null }) | undefined {
    const resolved = resolveConstructionObject(id, this.stores());
    if (!resolved) {
      return undefined;
    }
    const record = this.readConstructionObject(resolved.type, id) as
      | ({ position: { x: number; y: number; z: number }; rotation: number; dimensions: object; kind?: string; hostId?: string | null } & object)
      | undefined;
    if (!record) {
      return undefined;
    }
    return {
      id,
      type: resolved.type,
      ...(typeof record.kind === "string" ? { kind: record.kind } : {}),
      position: { ...record.position },
      rotation: record.rotation,
      dimensions: { ...(record.dimensions as Record<string, number>) },
      ...(record.hostId !== undefined ? { hostId: record.hostId } : {})
    };
  }

  /** object.align: lines `id`'s center up with `targetId`'s on X, Z, or both - through update_object, so a hosted opening slides along its wall. */
  private executeAlign(command: AlignObjectsCommand): CommandResult {
    const raw = command as unknown as Record<string, unknown>;
    if (typeof raw.id !== "string" || typeof raw.targetId !== "string") {
      return fail('object.align needs an "id" and a "targetId".');
    }
    if (raw.axis !== "x" && raw.axis !== "z" && raw.axis !== "both") {
      return fail('object.align "axis" must be "x", "z", or "both".');
    }
    if (raw.id === raw.targetId) {
      return fail("An object can't be aligned with itself.", raw.id);
    }
    const target = this.snapObjectOf(raw.targetId);
    if (!target) {
      return fail(`No construction object found with id "${raw.targetId}".`, raw.id);
    }
    const position: { x?: number; z?: number } = {};
    if (raw.axis !== "z") {
      position.x = target.position.x;
    }
    if (raw.axis !== "x") {
      position.z = target.position.z;
    }
    return this.execute({ type: "update_object", objectId: raw.id, changes: { position } });
  }

  /**
   * object.snap. "wall" puts a door or window into the target wall.
   * "endpoint" moves the object so its nearest key point lands on the
   * target's nearest one; for two compatible connectable elements those
   * are endpoints, and they're connected too. One undo step.
   */
  private executeSnap(command: SnapObjectCommand): CommandResult {
    const raw = command as unknown as Record<string, unknown>;
    if (typeof raw.id !== "string" || typeof raw.targetId !== "string") {
      return fail('object.snap needs an "id" and a "targetId".');
    }
    if (raw.id === raw.targetId) {
      return fail("An object can't snap to itself.", raw.id);
    }
    const moving = this.snapObjectOf(raw.id);
    const target = this.snapObjectOf(raw.targetId);
    if (!moving || !target) {
      return fail(`No construction object found with id "${!moving ? raw.id : raw.targetId}".`, raw.id);
    }

    if (raw.mode === "wall") {
      if (moving.type !== "door" && moving.type !== "window") {
        return fail("Only doors and windows go into a wall.", raw.id);
      }
      if (target.type !== "wall") {
        return fail(`${raw.targetId} is a ${target.type}, not a wall.`, raw.id);
      }
      return this.executeUpdateOpening(moving.type, raw.id, { hostId: raw.targetId });
    }
    if (raw.mode !== "endpoint") {
      return fail('object.snap "mode" must be "endpoint" or "wall".', raw.id);
    }

    const connect =
      moving.type === "element" &&
      target.type === "element" &&
      !!moving.kind &&
      !!target.kind &&
      isConnectable(moving.kind) &&
      kindsConnect(moving.kind, target.kind);
    const pick = (points: SnapPoint[]) => (connect ? points.filter((point) => point.kind === "endpoint") : points);
    let best: { own: SnapPoint; other: SnapPoint; distance: number } | null = null;
    for (const own of pick(keyPointsOf(moving))) {
      for (const other of pick(keyPointsOf(target))) {
        const distance = Math.hypot(other.x - own.x, other.z - own.z);
        if (!best || distance < best.distance - 1e-12) {
          best = { own, other, distance };
        }
      }
    }
    if (!best) {
      return fail(`${raw.id} has nothing to snap to on ${raw.targetId}.`, raw.id);
    }
    const found = best;

    return this.atomically(() => {
      const position = {
        x: round(moving.position.x + found.other.x - found.own.x),
        y: connect ? target.position.y : moving.position.y,
        z: round(moving.position.z + found.other.z - found.own.z)
      };
      if (!samePoint(position, moving.position)) {
        const moved = this.execute({ type: "update_object", objectId: raw.id, changes: { position } });
        if (!moved.success) {
          return moved;
        }
      }
      if (connect && found.own.endpoint && found.other.endpoint) {
        const joined = this.elementStore
          .get(raw.id as string)
          ?.connections.some((connection) => connection.endpoint === found.own.endpoint && connection.objectId === raw.targetId);
        if (!joined) {
          return this.execute({
            type: "element.connect",
            from: { id: raw.id, endpoint: found.own.endpoint },
            to: { id: raw.targetId, endpoint: found.other.endpoint }
          });
        }
      }
      return { success: true, objectId: raw.id as string, message: `Snapped ${raw.id} to ${raw.targetId}.` };
    });
  }

  // --- Shared helpers ---

  private stores() {
    return {
      wallStore: this.wallStore,
      pillarStore: this.pillarStore,
      beamStore: this.beamStore,
      slabStore: this.slabStore,
      doorStore: this.doorStore,
      windowStore: this.windowStore,
      elementStore: this.elementStore
    };
  }

  /**
   * Runs `work` as ONE undo step: inside the history group already open (a
   * drag, an AI batch) when there is one, otherwise in a group of its own
   * that's kept only if the work succeeds - a failure part-way leaves the
   * model exactly as it was. Without a history, the work just runs.
   */
  private atomically(work: () => CommandResult): CommandResult {
    const history = this.historyGroups;
    if (!history || history.isGrouping()) {
      return work();
    }
    history.beginGroup();
    let result: CommandResult;
    try {
      result = work();
    } catch (error) {
      history.cancelGroup();
      throw error;
    }
    if (result.success) {
      history.endGroup();
    } else {
      history.cancelGroup();
    }
    return result;
  }

  private executeDuplicateElement(command: DuplicateElementCommand): CommandResult {
    if (!command.id) {
      return { success: false, message: "element.duplicate command is missing an id." };
    }

    const source = this.elementStore.get(command.id);
    if (!source) {
      return { success: false, objectId: command.id, message: `No element found with id "${command.id}".` };
    }

    const duplicate = duplicateElementData(source);
    const result = this.elementHistory.add(duplicate);
    if (!result.valid) {
      // duplicateElementData() always produces valid data from a valid source - stay defensive.
      return {
        success: false,
        objectId: command.id,
        errors: result.errors,
        message: "Could not duplicate element: validation failed."
      };
    }
    return { success: true, objectId: duplicate.id, message: "Element duplicated." };
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
