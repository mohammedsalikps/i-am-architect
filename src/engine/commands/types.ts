import type { CreateWallOptions } from "../wall/createWall";
import type { WallData, WallId } from "../wall/types";
import type { WallValidationResult } from "../wall/validateWall";
import type { CreatePillarOptions } from "../pillar/createPillar";
import type { PillarData, PillarId } from "../pillar/types";
import type { PillarValidationResult } from "../pillar/validatePillar";
import type { CreateBeamOptions } from "../beam/createBeam";
import type { BeamData, BeamId } from "../beam/types";
import type { BeamValidationResult } from "../beam/validateBeam";
import type { CreateSlabOptions } from "../slab/createSlab";
import type { SlabData, SlabId } from "../slab/types";
import type { SlabValidationResult } from "../slab/validateSlab";
import type { CreateDoorOptions } from "../door/createDoor";
import type { DoorData, DoorId } from "../door/types";
import type { DoorValidationResult } from "../door/validateDoor";
import type { CreateWindowOptions } from "../window/createWindow";
import type { WindowData, WindowId } from "../window/types";
import type { WindowValidationResult } from "../window/validateWindow";
import type { CreateElementOptions } from "../elements/createElement";
import type { ElementData, ElementId, Endpoint } from "../elements/types";
import type { ElementValidationResult } from "../elements/validateElement";
import type { CreateAssetOptions } from "../assets/createAsset";
import type { AssetData, AssetId } from "../assets/types";
import type { AssetValidationResult } from "../assets/validateAsset";
import type { AssemblyData, AssemblyId } from "../assemblies/types";
import type { ObjectId } from "../objects/types";

/**
 * A Command is structured data describing one construction-object or
 * assembly operation - never arbitrary executable code. This is what
 * lets a future caller (an AI feature translating a prompt into
 * commands, a macro/scripting feature, or - today - a thin UI action)
 * request a mutation without calling WallStore/WallHistoryController/
 * PillarStore/PillarHistoryController/BeamStore/BeamHistoryController/
 * SlabStore/SlabHistoryController/DoorStore/DoorHistoryController/
 * WindowStore/WindowHistoryController/ElementStore/ElementHistoryController/
 * AssemblyStore directly. See commands/README.md.
 *
 * The six original object types each have their own namespaced commands
 * ("wall.*" ... "window.*"). Every newer kind - foundation, roof, stair,
 * flooring, plumbing, electrical, interior, exterior, rooms - shares the
 * "element.*" commands, with the catalog kind (elements/catalog.ts) in
 * the payload, so a new kind needs no new command.
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

export interface AddSlabCommand {
  type: "slab.add";
  /** Same shape as createSlabData()'s options - flat, all optional, sensible defaults fill the rest. */
  slab: CreateSlabOptions;
}

export interface UpdateSlabCommand {
  type: "slab.update";
  id: SlabId;
  /** Same shape SlabStore.update() takes - see its docs for the "complete replacement object" convention on nested fields. */
  changes: Partial<Omit<SlabData, "id" | "type">>;
}

export interface DeleteSlabCommand {
  type: "slab.delete";
  id: SlabId;
}

export interface DuplicateSlabCommand {
  type: "slab.duplicate";
  id: SlabId;
}

export interface AddDoorCommand {
  type: "door.add";
  /** Same shape as createDoorData()'s options - flat, all optional, sensible defaults fill the rest. */
  door: CreateDoorOptions;
}

export interface UpdateDoorCommand {
  type: "door.update";
  id: DoorId;
  /** Same shape DoorStore.update() takes - see its docs for the "complete replacement object" convention on nested fields. */
  changes: Partial<Omit<DoorData, "id" | "type">>;
}

export interface DeleteDoorCommand {
  type: "door.delete";
  id: DoorId;
}

export interface DuplicateDoorCommand {
  type: "door.duplicate";
  id: DoorId;
}

export interface AddWindowCommand {
  type: "window.add";
  /** Same shape as createWindowData()'s options - flat, all optional, sensible defaults fill the rest. */
  window: CreateWindowOptions;
}

export interface UpdateWindowCommand {
  type: "window.update";
  id: WindowId;
  /** Same shape WindowStore.update() takes - see its docs for the "complete replacement object" convention on nested fields. */
  changes: Partial<Omit<WindowData, "id" | "type">>;
}

export interface DeleteWindowCommand {
  type: "window.delete";
  id: WindowId;
}

export interface DuplicateWindowCommand {
  type: "window.duplicate";
  id: WindowId;
}

export interface AddElementCommand {
  type: "element.add";
  /** createElementData()'s options: a catalog `kind`, plus any of its label, position, rotation, dimensions, params, material, color. */
  element: CreateElementOptions;
}

export interface UpdateElementCommand {
  type: "element.update";
  id: ElementId;
  /**
   * Same shape ElementStore.update() takes - nested fields are complete
   * replacements, and the kind can't change. Connections change only
   * through element.connect / element.disconnect. Moving a connected
   * endpoint moves every endpoint joined to it.
   */
  changes: Partial<Omit<ElementData, "id" | "type" | "kind" | "connections">>;
}

/** One endpoint of a linear element. `endpoint` may be left out where the command can pick the nearest. */
export interface EndpointReference {
  id: ElementId;
  endpoint?: Endpoint;
}

/**
 * Connects an endpoint of `from` to an endpoint of `to` - two linear
 * elements of compatible kinds (water pipe to water pipe, drain to drain,
 * conduit to conduit, cable to cable). Omitted endpoints: the nearest
 * pair. The endpoints must be within CONNECTION_TOLERANCE of each other;
 * `from`'s endpoint is snapped onto `to`'s, and the connection is recorded
 * on both. One undo step.
 */
export interface ConnectElementsCommand {
  type: "element.connect";
  from: EndpointReference;
  to: EndpointReference;
}

/** Removes the connection(s) between `from` and `to` - only those at the given endpoints, when given. */
export interface DisconnectElementsCommand {
  type: "element.disconnect";
  from: EndpointReference;
  to: EndpointReference;
}

/** Moves object `id` so its center lines up with `targetId`'s on X, Z, or both. A door or window in a wall slides along it. */
export interface AlignObjectsCommand {
  type: "object.align";
  id: ObjectId;
  targetId: ObjectId;
  axis: "x" | "z" | "both";
}

/**
 * Snaps object `id` to `targetId`. "endpoint": moves it so its nearest key
 * point (endpoint, corner, or center) lands on the target's nearest one -
 * and, for two connectable elements, connects those endpoints. "wall":
 * puts a door or window into the target wall.
 */
export interface SnapObjectCommand {
  type: "object.snap";
  id: ObjectId;
  targetId: ObjectId;
  mode: "endpoint" | "wall";
}

export interface DeleteElementCommand {
  type: "element.delete";
  id: ElementId;
}

export interface DuplicateElementCommand {
  type: "element.duplicate";
  id: ElementId;
}

export interface AddAssetCommand {
  type: "asset.add";
  /** createAssetData()'s options: an assetId (assets/catalog.ts), plus any of its label, position, rotation, dimensions, material, color. */
  asset: CreateAssetOptions;
}

export interface UpdateAssetCommand {
  type: "asset.update";
  id: AssetId;
  /** Same shape AssetStore.update() takes - nested fields are complete replacements, and the assetId can't change. */
  changes: Partial<Omit<AssetData, "id" | "type" | "assetId">>;
}

export interface DeleteAssetCommand {
  type: "asset.delete";
  id: AssetId;
}

export interface DuplicateAssetCommand {
  type: "asset.duplicate";
  id: AssetId;
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
  | AddSlabCommand
  | UpdateSlabCommand
  | DeleteSlabCommand
  | DuplicateSlabCommand
  | AddDoorCommand
  | UpdateDoorCommand
  | DeleteDoorCommand
  | DuplicateDoorCommand
  | AddWindowCommand
  | UpdateWindowCommand
  | DeleteWindowCommand
  | DuplicateWindowCommand
  | AddElementCommand
  | UpdateElementCommand
  | DeleteElementCommand
  | DuplicateElementCommand
  | AddAssetCommand
  | UpdateAssetCommand
  | DeleteAssetCommand
  | DuplicateAssetCommand
  | ConnectElementsCommand
  | DisconnectElementsCommand
  | AlignObjectsCommand
  | SnapObjectCommand
  | CreateAssemblyCommand
  | UpdateAssemblyCommand
  | DeleteAssemblyCommand
  | AddObjectToAssemblyCommand
  | RemoveObjectFromAssemblyCommand
  | UpdateObjectCommand;

/**
 * The editable properties of an existing construction object - only
 * fields ConstructionObjectBase already has, nothing new. Unlike the
 * per-type `<type>.update` commands, whose `changes.dimensions` and
 * `changes.position` must be complete replacement objects, every nested
 * field here is partial: CommandExecutor merges it over the object's
 * current values before handing a complete change to the existing
 * per-type update path.
 *
 * `id`, `type`, and `assemblyId` are deliberately absent. An object's
 * identity never changes, and assembly membership belongs to the
 * assembly.* commands (the object's own `assemblyId` field is a reserved
 * placeholder that nothing sets).
 */
export interface ObjectChanges {
  /** Only keys the object already has (a wall: length/height/thickness; a pillar: width/depth/height; ...), in meters. */
  dimensions?: Record<string, number>;
  /** Any subset of x/y/z, in meters; omitted axes keep their current value. */
  position?: { x?: number; y?: number; z?: number };
  /** Radians around the vertical axis - the only rotation the model has. `{ y: radians }` is accepted as the same value. */
  rotation?: number | { y: number };
  material?: string;
  color?: string;
  /** Elements and assets only: the name people see. */
  label?: string;
  /** Elements only: any of the kind's parameters. */
  params?: Record<string, number | string>;
  /** Doors and windows only: the wall to put it in, or null to take it out of its wall. */
  hostId?: string | null;
}

/**
 * Edits an existing construction object of any type, by id. The type is
 * resolved from the id through the shared resolver, and the change is
 * carried out by that type's existing `<type>.update` path - the same
 * store validation and history entry a UI edit gets. It never creates an
 * object: an id that matches nothing is an error.
 */
export interface UpdateObjectCommand {
  type: "update_object";
  objectId: ObjectId;
  changes: ObjectChanges;
}

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

/** The slab equivalent of WallHistoryLike/PillarHistoryLike/BeamHistoryLike - same reasoning, same shape. */
export interface SlabHistoryLike {
  add(slab: SlabData): SlabValidationResult;
  update(id: SlabId, changes: Partial<Omit<SlabData, "id" | "type">>): SlabValidationResult;
  remove(id: SlabId): void;
}

/** The door equivalent of WallHistoryLike and every sibling *HistoryLike - same reasoning, same shape. */
export interface DoorHistoryLike {
  add(door: DoorData): DoorValidationResult;
  update(id: DoorId, changes: Partial<Omit<DoorData, "id" | "type">>): DoorValidationResult;
  remove(id: DoorId): void;
}

/** The window equivalent of WallHistoryLike and every sibling *HistoryLike - same reasoning, same shape. */
export interface WindowHistoryLike {
  add(windowData: WindowData): WindowValidationResult;
  update(id: WindowId, changes: Partial<Omit<WindowData, "id" | "type">>): WindowValidationResult;
  remove(id: WindowId): void;
}

/**
 * The subset of HistoryManager CommandExecutor uses to make a change that
 * spans several objects - a wall and the openings in it, a pipe and the
 * ones joined to it - ONE undo step: it opens a group when none is open,
 * and otherwise lets the open one (a drag, an AI batch) collect the lot.
 */
export interface HistoryGroupsLike {
  beginGroup(): void;
  endGroup(): void;
  cancelGroup(): void;
  isGrouping(): boolean;
}

/** The element equivalent of WallHistoryLike - one controller for every element kind. */
export interface ElementHistoryLike {
  add(element: ElementData): ElementValidationResult;
  update(id: ElementId, changes: Partial<Omit<ElementData, "id" | "type" | "kind">>): ElementValidationResult;
  remove(id: ElementId): void;
}

/** The asset equivalent of WallHistoryLike/ElementHistoryLike - one controller for every design asset. */
export interface AssetHistoryLike {
  add(asset: AssetData): AssetValidationResult;
  update(id: AssetId, changes: Partial<Omit<AssetData, "id" | "type" | "assetId">>): AssetValidationResult;
  remove(id: AssetId): void;
}
