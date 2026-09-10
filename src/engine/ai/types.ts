import type { ObjectType } from "../objects/types";
import type { CommandResult } from "../commands/types";

/**
 * Provider-independent AI command pipeline - shared type definitions.
 * See ai/README.md for the full architecture. Nothing under
 * src/engine/ai/ imports Three.js, DOM, or any concrete *Store class -
 * see AICommandPipeline.ts for how mutations are routed exclusively
 * through CommandExecutor, and AIProjectSnapshot below for what a
 * provider is allowed to see of the current project.
 */

/** The construction object types the AI layer currently knows how to produce commands for. */
export const AI_SUPPORTED_OBJECT_TYPES: readonly ObjectType[] = [
  "wall",
  "pillar",
  "beam",
  "slab",
  "door",
  "window"
];

/**
 * A read-only summary of the current project - never the live stores
 * themselves. An AIProvider only ever sees this plain data snapshot,
 * never a WallStore/PillarStore/.../SelectionStore instance, so a
 * provider has no way to read or write scene data except through the
 * commands it returns in an AIProviderResponse.
 */
export interface AIProjectSnapshot {
  wallCount: number;
  pillarCount: number;
  beamCount: number;
  slabCount: number;
  doorCount: number;
  windowCount: number;
  assemblyCount: number;
  /** The single selected construction-object id, or null if nothing is selected - same shape SelectionStore.get() returns. */
  selectedObjectId: string | null;
  /**
   * Every construction object currently in the project, as plain data -
   * see AIContextObject. Sorted by id (see buildAIProjectSnapshot), so the
   * same project state always produces the same snapshot no matter what
   * order the objects entered the stores in.
   */
  objects: AIContextObject[];
  /** Every assembly currently in the project, as plain data - see AIContextAssembly. Sorted by id. */
  assemblies: AIContextAssembly[];
}

/**
 * One construction object as a provider sees it: plain JSON data copied
 * field by field out of a store record - never the record itself, and
 * never anything a scene layer might have attached to it.
 *
 * `assemblyIds` is derived from the assemblies' own `objectIds` lists,
 * which are the authoritative membership record. ConstructionObjectBase
 * also has an `assemblyId` field, but nothing ever sets it: every factory
 * writes `null` and the assembly commands only update the assembly. Copying
 * it would report every grouped object as ungrouped. An object can belong
 * to several assemblies, hence a list.
 */
export interface AIContextObject {
  id: string;
  type: ObjectType;
  /** Center of the object's bounding volume, in meters. */
  position: { x: number; y: number; z: number };
  /** Rotation around the vertical (Y) axis, in radians. */
  rotation: number;
  /** The object type's own size fields, in meters, keys in sorted order. */
  dimensions: Record<string, number>;
  material: string;
  color: string;
  /** Ids of every assembly that lists this object, sorted. Empty when ungrouped. */
  assemblyIds: string[];
}

/**
 * One assembly as a provider sees it. Deliberately leaves out
 * AssemblyData's createdAt/updatedAt: they are Date.now() timestamps, so
 * two otherwise identical projects would produce different snapshots, and
 * they tell a provider nothing about the model.
 */
export interface AIContextAssembly {
  id: string;
  name: string;
  /** Null rather than absent when unset, so every assembly has the same keys. */
  description: string | null;
  /** Member object ids in the assembly's own order, which the user controls. */
  objectIds: string[];
}

/**
 * The fields buildAIProjectSnapshot() reads from each construction-object
 * store record. Structural, so any store's records (WallData, PillarData,
 * ...) satisfy it without this module importing them. `dimensions` is
 * typed `object` rather than `Record<string, number>` because each object
 * type declares its dimensions as an interface, which TypeScript won't
 * assign to an index signature; the builder copies its finite numeric
 * fields instead.
 */
export interface AIObjectSourceRecord {
  id: string;
  type: ObjectType;
  position: { x: number; y: number; z: number };
  rotation: number;
  dimensions: object;
  material: string;
  color: string;
}

/** The fields buildAIProjectSnapshot() reads from each assembly record. */
export interface AIAssemblySourceRecord {
  id: string;
  name: string;
  description?: string;
  objectIds: readonly string[];
}

/**
 * The subset of ProjectContext's stores buildAIProjectSnapshot() needs,
 * expressed structurally (like commands/types.ts's *HistoryLike
 * interfaces) rather than by importing the concrete WallStore/
 * PillarStore/.../ProjectContext types. A real ProjectContext object
 * satisfies this automatically; nothing here needs to import it, which
 * keeps this module free of any dependency on the *HistoryController
 * classes ProjectContext.ts constructs (those use TypeScript
 * parameter-property constructors, which Node's default strip-only
 * TypeScript mode can't run - see ai/verify.ts for why that matters).
 * Only read methods appear here, so a snapshot source can't be used to
 * write to anything.
 */
export interface AIProjectSnapshotSource {
  wallStore: { getAll(): readonly AIObjectSourceRecord[] };
  pillarStore: { getAll(): readonly AIObjectSourceRecord[] };
  beamStore: { getAll(): readonly AIObjectSourceRecord[] };
  slabStore: { getAll(): readonly AIObjectSourceRecord[] };
  doorStore: { getAll(): readonly AIObjectSourceRecord[] };
  windowStore: { getAll(): readonly AIObjectSourceRecord[] };
  assemblyStore: { getAll(): readonly AIAssemblySourceRecord[] };
  selectionStore: { get(): string | null };
}

/**
 * Orders ids so "wall-2" comes before "wall-10": when two ids share the
 * same text before a trailing number, that number decides; otherwise
 * plain code-unit order does. Written out by hand rather than using
 * localeCompare so the result can't vary with the runtime's locale data.
 * Exported so geometry/analyzeConstructionGeometry.ts orders objects
 * exactly the way the snapshot does.
 */
export function compareIds(a: string, b: string): number {
  const matchA = /^(.*?)(\d+)$/.exec(a);
  const matchB = /^(.*?)(\d+)$/.exec(b);
  if (matchA && matchB && matchA[1] === matchB[1]) {
    const difference = Number(matchA[2]) - Number(matchB[2]);
    if (difference !== 0) {
      return difference;
    }
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Copies only the finite numeric fields of a dimensions object, in sorted key order. */
function copyDimensions(dimensions: object): Record<string, number> {
  const copy: Record<string, number> = {};
  for (const key of Object.keys(dimensions).sort()) {
    const value = (dimensions as Record<string, unknown>)[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      copy[key] = value;
    }
  }
  return copy;
}

/**
 * Builds a read-only AIProjectSnapshot from a live ProjectContext (or
 * anything with the same shape). This is the only place store data
 * crosses into the AI layer, and it only ever crosses as freshly built
 * plain data: every object, position, and assembly is a new literal, so
 * nothing a provider receives shares a reference with a store record, a
 * scene mesh, or the DOM. The result is JSON-safe and deterministic -
 * objects and assemblies are sorted by id, dimension keys are sorted, and
 * timestamps are left out - so the same project state always yields the
 * same snapshot.
 */
export function buildAIProjectSnapshot(source: AIProjectSnapshotSource): AIProjectSnapshot {
  const walls = source.wallStore.getAll();
  const pillars = source.pillarStore.getAll();
  const beams = source.beamStore.getAll();
  const slabs = source.slabStore.getAll();
  const doors = source.doorStore.getAll();
  const windows = source.windowStore.getAll();
  const assemblyRecords = source.assemblyStore.getAll();

  const assemblies: AIContextAssembly[] = assemblyRecords
    .map((assembly) => ({
      id: assembly.id,
      name: assembly.name,
      description: assembly.description ?? null,
      objectIds: [...assembly.objectIds]
    }))
    .sort((a, b) => compareIds(a.id, b.id));

  // Object id -> ids of every assembly listing it. Assemblies are already
  // sorted, so each list comes out sorted too.
  const membership = new Map<string, string[]>();
  for (const assembly of assemblies) {
    for (const objectId of assembly.objectIds) {
      const assemblyIds = membership.get(objectId) ?? [];
      if (!assemblyIds.includes(assembly.id)) {
        assemblyIds.push(assembly.id);
      }
      membership.set(objectId, assemblyIds);
    }
  }

  const objects: AIContextObject[] = [...walls, ...pillars, ...beams, ...slabs, ...doors, ...windows]
    .map((record) => ({
      id: record.id,
      type: record.type,
      position: { x: record.position.x, y: record.position.y, z: record.position.z },
      rotation: record.rotation,
      dimensions: copyDimensions(record.dimensions),
      material: record.material,
      color: record.color,
      assemblyIds: [...(membership.get(record.id) ?? [])]
    }))
    .sort((a, b) => compareIds(a.id, b.id) || compareIds(a.type, b.type));

  return {
    wallCount: walls.length,
    pillarCount: pillars.length,
    beamCount: beams.length,
    slabCount: slabs.length,
    doorCount: doors.length,
    windowCount: windows.length,
    assemblyCount: assemblyRecords.length,
    selectedObjectId: source.selectionStore.get(),
    objects,
    assemblies
  };
}

/** What AICommandPipeline hands to an AIProvider for one instruction. */
export interface AIProviderRequest {
  /** The user's raw natural-language instruction, already confirmed non-empty by the pipeline. */
  instruction: string;
  /** Read-only snapshot of the current project - see AIProjectSnapshot. */
  projectContext: AIProjectSnapshot;
  /** Which construction object types are currently available to create/edit. */
  availableObjectTypes: readonly ObjectType[];
}

/**
 * What an AIProvider returns. `commands` is deliberately `unknown[]`,
 * not `Command[]` - a provider (especially a future real LLM-backed
 * one) is untrusted input at this boundary, exactly like
 * CommandExecutor.execute()'s own `unknown` parameter. AICommandPipeline
 * is what validates each entry before anything is executed.
 */
export interface AIProviderResponse {
  commands: unknown[];
  /** Optional free-text notes from the provider (e.g. which parts of the instruction it couldn't map to a command) - for logs/debugging, not yet surfaced in the UI. */
  notes?: string;
}

/** One command's outcome after passing through validation and (if valid) CommandExecutor. */
export interface AICommandOutcome {
  /** The raw, not-yet-trusted command as returned by the provider. */
  command: unknown;
  result: CommandResult;
}

/** Where in the pipeline a failure happened - lets a caller distinguish "the provider produced garbage" from "CommandExecutor rejected a well-formed command". */
export type AIPipelineStage = "input" | "provider" | "validation" | "execution";

export interface AIPipelineError {
  stage: AIPipelineStage;
  message: string;
  /** Index into the provider's commands array, when the error is about one specific command. */
  commandIndex?: number;
}

/** The full result of running one instruction through AICommandPipeline.run(). */
export interface AIPipelineResult {
  success: boolean;
  instruction: string;
  outcomes: AICommandOutcome[];
  errors: AIPipelineError[];
  /**
   * The provider's free-text notes (see AIProviderResponse.notes), when
   * it supplied any - present regardless of whether the overall result
   * was a success (a provider can partially map an instruction and
   * still explain what it couldn't). Undefined, not an empty string,
   * when the provider gave none.
   */
  notes?: string;
}
