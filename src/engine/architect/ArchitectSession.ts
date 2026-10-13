// Explicit .ts extensions on value imports let Node run this file directly
// (engine/architect/verify.ts does). Harmless for Vite.
import { executeCommandBatch } from "../commands/executeCommandBatch.ts";
import type { HistoryGroupLike } from "../commands/executeCommandBatch";
import type { CommandResult } from "../commands/types";
import { analyzeConstructionGeometry } from "../ai/geometry/analyzeConstructionGeometry.ts";
import {
  foundationStageCommands,
  openingsStageCommands,
  planHouseDesign,
  readStructureRefs,
  resolveFootprint,
  roofStageCommands,
  roomsStageCommands,
  structureStageCommands
} from "../ai/houseDesign.ts";
import type { HouseLayout, HouseStructureRefs } from "../ai/houseDesign.ts";
import type { HouseDesignRequest } from "../ai/houseIntent.ts";
import type { HouseFootprint } from "../ai/housePlan.ts";
import { friendlyAiErrorMessage, isNetworkUnreachable, summarizeCreatedObjects, summarizeUpdatedObjects } from "../ai/AiPromptController.ts";
import type { AIPipelineResult, AIProjectSnapshot, AIRunOptions } from "../ai/types";
import { planFurnishingsInScene } from "./interiors.ts";
import { parseUtterance } from "./parseUtterance.ts";
import { addOpeningToRoom, furnishRooms, moveOpening, setWallLength, showRoom } from "./roomEdits.ts";
import type { PendingOption, RoomEditContext, RoomEditResult } from "./roomEdits.ts";
import { listRooms } from "./roomModel.ts";
import {
  describeWall,
  fmtMeters,
  missingWallSlot,
  readSlotAnswer,
  readWallDraft,
  readWallMaterial,
  wallCommand,
  wallMaterial,
  WALL_MATERIALS,
  wallFootprint,
  wallQuestion,
  wallSizeProblem,
  wallVolume
} from "./wallBuilder.ts";
import type { WallDraft, WallSlot } from "./wallBuilder.ts";
import type { ArchitectStage, LocationRef, PlanPoint, Utterance } from "./parseUtterance.ts";

/**
 * EAVARA's conversational architect: one DOM-free state machine that
 * carries a design from "here's my site" to a furnished house, one turn
 * at a time.
 *
 *   site → location → house details → plan → staged build → edits
 *
 * - It asks instead of guessing when a request is ambiguous: a house with
 *   no size, no location yet, a footprint past the site boundary, a spot
 *   that overlaps existing construction, "furnish the bedroom" with two
 *   bedrooms, a stage asked for before the stages under it.
 * - It builds progressively: the house's six stages (foundation, walls &
 *   columns, doors & windows, rooms, roof, interiors) each run as ONE
 *   all-or-nothing batch through the shared CommandExecutor and
 *   HistoryManager - one undo step per stage, and nothing half-built.
 * - It never touches a store. Every change is a command through
 *   `commandExecutor`; everything it knows about the model it reads from
 *   `snapshot()`, fresh, every turn - so a stage undone (or an object
 *   deleted) by hand is noticed, not assumed still there.
 * - It works offline. Only a turn it doesn't recognize goes to `fallback`
 *   (in the running app, the existing AIService pipeline - which itself
 *   handles selection edits like "make the selected wall 5 metres long"
 *   locally, and anything else through the AI provider).
 */

export interface ArchitectChoice {
  /** What the button says. */
  label: string;
  /** What clicking it sends, as if the user had typed it. */
  say: string;
}

export type ArchitectTone = "info" | "question" | "success" | "error";

export interface ArchitectReply {
  text: string;
  tone: ArchitectTone;
  choices: ArchitectChoice[];
  /** Objects this turn created or changed - the viewport frames them. */
  focusIds?: string[];
  /** Set when the user should click the ground to choose a location; the footprint (when one is known) sizes the preview. */
  pickLocation?: { footprint: HouseFootprint | null };
  /** Objects to hide in the viewport for this reply (a roof, while showing a room) - a view setting, never a model change. */
  hideIds?: string[];
  /** Objects to show again. */
  showIds?: string[];
}

export interface ArchitectStageView {
  id: ArchitectStage;
  label: string;
  status: "done" | "next" | "todo";
}

/** What the viewport overlay and the panel's progress strip show. */
export interface ArchitectViewState {
  site: { length: number; width: number; center: PlanPoint } | null;
  location: PlanPoint | null;
  /** The house being designed: its footprint, where it's planned, and whether construction has started. */
  plan: { footprint: HouseFootprint; center: PlanPoint | null; started: boolean } | null;
  stages: ArchitectStageView[] | null;
}

export type ArchitectListener = (state: ArchitectViewState) => void;

export interface ArchitectSessionOptions {
  /** The shared CommandExecutor - the only way this session changes the model. */
  commandExecutor: { execute(input: unknown): CommandResult };
  /** The shared HistoryManager's group methods: each stage is one undo step, rolled back whole on failure. */
  history?: HistoryGroupLike;
  /** A fresh read-only snapshot of the model (buildAIProjectSnapshot). */
  snapshot: () => AIProjectSnapshot;
  /** The app's Undo. */
  undo?: () => void;
  /**
   * Where unrecognized turns go - AIService.submit in the running app. The
   * session always asks for `housePlan: "return"`: a whole house the AI
   * interprets comes back as a plan, which this session builds in its own
   * stages (one undo step each), never as one AI-built batch.
   */
  fallback?: (instruction: string, options: AIRunOptions) => Promise<AIPipelineResult>;
}

export const ARCHITECT_STAGES: readonly { id: ArchitectStage; label: string; say: string }[] = [
  { id: "foundation", label: "Foundation", say: "Lay the foundation" },
  { id: "structure", label: "Walls & columns", say: "Raise the walls" },
  { id: "openings", label: "Doors & windows", say: "Add the doors and windows" },
  { id: "rooms", label: "Rooms", say: "Mark out the rooms" },
  { id: "roof", label: "Roof", say: "Put the roof on" },
  { id: "interiors", label: "Interiors", say: "Furnish the house" }
];
const STAGE_IDS = ARCHITECT_STAGES.map((stage) => stage.id);

const SITE_LIMITS = { min: 6, max: 200 };
/** Where a site's surface sits - just above the ground plane (see defineSite). */
const SITE_SURFACE_Y = 0.01;
/** Space kept clear around a planned house when checking it against existing objects. */
const CLEARANCE = 0.1;
/** Element kinds that are ground surfaces a house may stand on, not obstacles. */
const GROUND_KINDS = new Set(["landscape", "path"]);

const SIZE_PRESETS: readonly { bedrooms: number; footprint: HouseFootprint }[] = [
  { bedrooms: 1, footprint: { length: 7, width: 6 } },
  { bedrooms: 2, footprint: { length: 10, width: 8 } },
  { bedrooms: 3, footprint: { length: 12, width: 9 } },
  { bedrooms: 4, footprint: { length: 13, width: 10 } }
];

type Pending =
  | { kind: "site-size" }
  | { kind: "house-details" }
  | { kind: "location" }
  | { kind: "fit"; suggested: PlanPoint }
  | { kind: "conflict"; conflictIds: string[]; nearest: PlanPoint | null }
  | { kind: "confirm-plan" }
  | { kind: "stage-order"; target: ArchitectStage }
  | { kind: "which-room"; options: string[] }
  | { kind: "opening-scope" }
  /** A room-edit question (roomEdits.ts): a typed answer naming exactly one option's key runs that option. */
  | { kind: "options"; options: PendingOption[] }
  /** One new wall being specified (wallBuilder.ts): the slot asked about, or "confirm" once nothing is missing. */
  | { kind: "wall"; draft: WallDraft; slot: WallSlot | "confirm" }
  /** The house's wall material, asked just before its walls go up - then these stages are built. */
  | { kind: "house-material"; stages: ArchitectStage[] };

interface SiteRecord {
  id: string;
  length: number;
  width: number;
  center: PlanPoint;
}

function fmt(value: number): string {
  return String(Math.round(value * 100) / 100);
}

function fmtPoint(point: PlanPoint): string {
  return `(${fmt(point.x)}, ${fmt(point.z)})`;
}

function fmtSize(size: HouseFootprint): string {
  return `${fmt(size.length)} × ${fmt(size.width)} m`;
}

function list(items: readonly string[]): string {
  return items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function hasDetails(request: HouseDesignRequest): boolean {
  return request.footprint !== undefined || request.size !== undefined || request.bedrooms !== undefined || (request.rooms?.length ?? 0) > 0;
}

function reply(text: string, tone: ArchitectTone, choices: ArchitectChoice[] = [], extra: Partial<ArchitectReply> = {}): ArchitectReply {
  return { text, tone, choices, ...extra };
}

export class ArchitectSession {
  private readonly options: ArchitectSessionOptions;
  private readonly listeners = new Set<ArchitectListener>();

  private site: SiteRecord | null = null;
  private location: PlanPoint | null = null;
  /** The house being specified. Set from the first house request; refined by answers until it can be planned. */
  private request: HouseDesignRequest | null = null;
  /** The planned house, once details and location check out. */
  private layout: HouseLayout | null = null;
  /** Ids each stage created. A stage counts as built while any of them still exists, so undo/redo and manual deletes are reflected. */
  private readonly built = new Map<ArchitectStage, string[]>();
  /** Interiors are furnished room by room: room name → the asset ids placed there. */
  private readonly furnished = new Map<string, string[]>();
  private refs: HouseStructureRefs | null = null;
  private pending: Pending | null = null;
  /** The material library id every wall of the house is built in - asked for, never assumed. */
  private houseWallMaterial: string | null = null;
  /** A wall waiting for a click in the 3D view (see pickedLocation). */
  private wallPick: WallDraft | null = null;
  /** Roofs hidden to show a room ("show me the living room") - a view setting this session can undo with "show the roof". */
  private hiddenRoofs: string[] = [];
  /** What room edits (roomEdits.ts) work through: a fresh snapshot, and one undoable batch per edit. */
  private readonly rooms: RoomEditContext;

  constructor(options: ArchitectSessionOptions) {
    this.options = options;
    this.rooms = { snapshot: () => this.options.snapshot(), run: (commands) => this.runBatch(commands) };
  }

  greeting(): ArchitectReply {
    return reply(
      "Hi, I'm your EAVARA architect. Let's start with the site — tell me its size, or go straight to the house and I'll ask what I need.",
      "info",
      [
        { label: "Set up a 30 × 20 m site", say: "Set up a 30 x 20 m site" },
        { label: "Build a 3-bedroom house", say: "Build a 3 bedroom house" },
        { label: "What can you do?", say: "What can you do?" }
      ]
    );
  }

  subscribe(listener: ArchitectListener): () => void {
    this.listeners.add(listener);
    listener(this.getState());
    return () => this.listeners.delete(listener);
  }

  getState(): ArchitectViewState {
    const exists = this.existence();
    const site = this.activeSite(exists);
    const footprint = this.layout?.footprint ?? (this.request && hasDetails(this.request) ? resolveFootprint(this.request) : null);
    const started = this.layout !== null && this.anyStageBuilt(exists);
    return {
      site: site ? { length: site.length, width: site.width, center: site.center } : null,
      location: this.location,
      plan: footprint ? { footprint, center: this.layout?.center ?? this.location, started } : null,
      stages: this.layout ? this.stageViews(exists) : null
    };
  }

  /** Handles one typed or spoken turn. */
  async handle(text: string): Promise<ArchitectReply> {
    const utterance = parseUtterance(text);
    const pending = this.pending;
    this.pending = null;
    if (pending?.kind === "options" && utterance.kind === "unknown") {
      // A typed answer to a room-edit question ("bedroom 2", "the back one").
      const said = ` ${text.toLowerCase().replace(/[^a-z0-9-]+/g, " ")} `;
      const chosen = pending.options.filter((option) => option.keys.some((key) => said.includes(` ${key.toLowerCase()} `)));
      if (chosen.length === 1) return this.handle(chosen[0].say);
    }
    const answered = pending ? this.answer(pending, utterance, text) : null;
    const result = answered ?? (await this.route(utterance, text));
    this.emit();
    return result;
  }

  /** The user clicked the ground to choose a location (see pickLocation). */
  pickedLocation(point: PlanPoint): ArchitectReply {
    this.pending = null;
    const picked = { x: Math.round(point.x * 10) / 10, z: Math.round(point.z * 10) / 10 };
    if (this.wallPick) {
      const draft = this.wallPick;
      this.wallPick = null;
      const result = this.continueWall({ ...draft, location: { kind: "point", point: picked } });
      this.emit();
      return result;
    }
    const result = this.setLocation(picked);
    this.emit();
    return result;
  }

  // --- routing ---

  private answer(pending: Pending, u: Utterance, text: string): ArchitectReply | null {
    switch (pending.kind) {
      case "site-size":
        if (u.kind === "details" && u.request.footprint) return this.defineSite(u.request.footprint, undefined);
        return null;
      case "house-details":
        if (u.kind === "details" || u.kind === "house") return this.updateRequest(u.request, u.location);
        if (u.kind === "defaults" || u.kind === "yes") return this.updateRequest({ bedrooms: 2 }, undefined);
        return null;
      case "location":
        if (u.kind === "yes" && this.activeSite(this.existence())) return this.setLocationRef({ kind: "site-centre" });
        return null;
      case "fit":
        if (u.kind === "yes") return this.setLocation(pending.suggested);
        if (u.kind === "no") return this.askLocation("No problem — where should it go instead?");
        return null;
      case "conflict":
        if (u.kind === "clear-conflicts") return this.clearConflicts(pending.conflictIds);
        if ((u.kind === "nearest-free" || u.kind === "yes") && pending.nearest) return this.setLocation(pending.nearest);
        if (u.kind === "no") return this.askLocation("OK — where should it go instead?");
        return null;
      case "confirm-plan":
        if (u.kind === "yes") return this.buildNext();
        if (u.kind === "no") {
          return reply("No problem. Tell me what to change — the bedrooms, the size, or the location.", "question", [
            { label: "Make it 3 bedrooms", say: "3 bedrooms" },
            { label: "Make it 12 × 10 m", say: "make it 12 x 10 m" },
            { label: "Pick another spot", say: "Pick a location" }
          ]);
        }
        return null;
      case "stage-order":
        if (u.kind === "yes") return this.buildAll(pending.target);
        if (u.kind === "no") return this.status("OK, I'll leave it there.");
        return null;
      case "which-room": {
        if (u.kind === "all" || u.kind === "yes" || /(?:all|both|every)/i.test(text)) return this.furnish(pending.options);
        const chosen = pending.options.filter((name) => text.toLowerCase().includes(name.toLowerCase()));
        if (chosen.length > 0) return this.furnish(chosen);
        return null;
      }
      case "opening-scope":
        if (u.kind === "yes" || (u.kind === "stage" && u.stage === "openings")) return this.buildStage("openings", "");
        if (u.kind === "no") return reply("OK — select a wall in the viewport, then ask again (e.g. “add a window”). I'll put it at the first free spot in that wall.", "info");
        return null;
      case "options":
        return null;
      case "wall":
        return this.answerWall(pending, u, text);
      case "house-material": {
        const material = readWallMaterial(text);
        if (material) {
          this.houseWallMaterial = material;
          return this.buildStages(pending.stages);
        }
        if (u.kind === "no") return this.status("OK — the walls wait until you choose a material.");
        if (u.kind !== "unknown" && u.kind !== "details") return null;
        return this.askHouseMaterial(pending.stages, "I didn't catch the material.");
      }
    }
  }

  /** A room edit's reply - remembering its question's options for a typed answer, and the rooms it furnished. */
  private roomEdit(edit: RoomEditResult): ArchitectReply {
    if (edit.options && edit.options.length > 0) {
      this.pending = { kind: "options", options: edit.options };
    }
    for (const { room, ids } of edit.furnished ?? []) {
      this.furnished.set(room, ids);
    }
    if (edit.reply.hideIds) {
      this.hiddenRoofs = [...new Set([...this.hiddenRoofs, ...edit.reply.hideIds])];
    }
    return edit.reply;
  }

  private showRoof(): ArchitectReply {
    const exists = this.existence();
    const hidden = this.hiddenRoofs.filter(exists);
    this.hiddenRoofs = [];
    if (hidden.length === 0) return reply("The roof isn't hidden.", "info");
    return reply("The roof is back.", "info", [], { showIds: hidden, focusIds: hidden });
  }

  private async route(u: Utterance, text: string): Promise<ArchitectReply> {
    switch (u.kind) {
      case "yes":
      case "no":
        return this.status("Nothing is waiting on a yes or no right now.");
      case "undo":
        if (!this.options.undo) return reply("Undo isn't available here.", "error");
        this.options.undo();
        return this.status("Undone — the last change was reversed.");
      case "help":
        return this.help();
      case "status":
        return this.status();
      case "reset":
        return this.reset();
      case "defaults":
        return this.request ? this.updateRequest({ bedrooms: 2 }, undefined) : this.startHouse({ bedrooms: 2 }, undefined, undefined);
      case "pick-location":
        return this.askPick();
      case "location":
        return this.setLocationRef(u.location);
      case "site":
        return this.siteRequest(u.dimensions, u.area, u.location);
      case "house":
        this.houseWallMaterial = readWallMaterial(text) ?? null;
        return this.startHouse(u.request, u.location, u.unsupported);
      case "details":
        return this.request ? this.updateRequest(u.request, u.location) : this.startHouse(u.request, u.location, undefined);
      case "stage":
        return this.buildStage(u.stage, u.text);
      case "next":
        return this.buildNext();
      case "all":
        return this.buildAll(u.upTo);
      case "single-opening": {
        const inRoom = addOpeningToRoom(this.rooms, u.opening, u.text);
        return inRoom ? this.roomEdit(inRoom) : this.singleOpening(u.opening, u.text);
      }
      case "show":
        return this.roomEdit(showRoom(this.rooms, u.text));
      case "show-roof":
        return this.showRoof();
      case "refurnish":
        return this.roomEdit(furnishRooms(this.rooms, u.text, true));
      case "move-opening":
        return this.roomEdit(moveOpening(this.rooms, u));
      case "wall-length":
        if (u.length === undefined) {
          return reply("How long should the wall be? Say it with a unit, e.g. “make the back wall of the kitchen 4 metres long”.", "question");
        }
        return this.roomEdit(setWallLength(this.rooms, { text: u.text, length: u.length }));
      case "clear-conflicts":
      case "nearest-free":
        return this.status("Nothing is in the way right now.");
      case "build-wall":
        return this.continueWall(readWallDraft(u.text));
      case "unknown":
        return this.fallback(text);
    }
  }

  // --- site ---

  private siteRequest(dimensions: HouseFootprint | undefined, area: number | undefined, location: LocationRef | undefined): ArchitectReply {
    if (dimensions) {
      return this.defineSite(dimensions, location?.kind === "point" ? location.point : undefined);
    }
    this.pending = { kind: "site-size" };
    const options: HouseFootprint[] = area
      ? [
          { length: Math.round(Math.sqrt(area) * 2) / 2, width: Math.round(Math.sqrt(area) * 2) / 2 },
          { length: Math.round(Math.sqrt(area * 1.5) * 2) / 2, width: Math.round((area / Math.sqrt(area * 1.5)) * 2) / 2 }
        ]
      : [
          { length: 20, width: 15 },
          { length: 30, width: 20 },
          { length: 40, width: 30 }
        ];
    return reply(
      area ? `A ${fmt(area)} m² site — what shape is it? Give me its length and width.` : "What are the site's dimensions? Give me its length and width, e.g. 30 × 20 m.",
      "question",
      options.map((size) => ({ label: fmtSize(size), say: `Site ${fmt(size.length)} x ${fmt(size.width)} m` }))
    );
  }

  private defineSite(size: HouseFootprint, at: PlanPoint | undefined): ArchitectReply {
    const { min, max } = SITE_LIMITS;
    if (size.length < min || size.length > max || size.width < min || size.width > max) {
      this.pending = { kind: "site-size" };
      return reply(`A site of ${fmtSize(size)} is outside what I can lay out — each side must be ${min}–${max} m. What size is it?`, "error");
    }
    const exists = this.existence();
    const previous = this.activeSite(exists);
    const center = at ?? previous?.center ?? { x: 0, z: 0 };
    // The landscape kind's top sits exactly at y = 0, coplanar with the
    // viewport's ground plane - over a whole site that z-fights into a
    // sawtooth. Lifted 1 cm, it reads cleanly; a house slab still sits on it.
    const thickness = 0.05;
    const add = {
      type: "element.add",
      element: {
        kind: "landscape",
        label: "Site",
        position: { x: center.x, y: SITE_SURFACE_Y - thickness / 2, z: center.z },
        dimensions: { length: size.length, width: size.width, thickness }
      }
    };
    // Resizing a site replaces it - one undo step either way.
    const commands = previous ? [{ type: "element.delete", id: previous.id }, add] : [add];
    const batch = executeCommandBatch(this.options.commandExecutor, commands, this.options.history);
    const siteId = batch.success ? batch.results[batch.results.length - 1].objectId : undefined;
    if (!siteId) {
      return reply(`I couldn't lay out the site: ${batch.message ?? batch.results[batch.failedIndex ?? 0]?.message ?? "unknown error"}`, "error");
    }
    this.site = { id: siteId, length: size.length, width: size.width, center };

    const next = this.request
      ? this.location
        ? "Let me re-check the house against it."
        : "Now, where on it should the house go?"
      : "Next, where should the house go? Click a spot on the site, or give coordinates like “at 4, -2”.";
    const text = `${previous ? "Site resized" : "Site set"}: ${fmtSize(size)}, centred at ${fmtPoint(center)} — the green area in the viewport. ${next}`;
    if (this.request && this.location && !this.started(this.existence())) {
      const continued = this.advance();
      return { ...continued, text: `${text}\n\n${continued.text}`, focusIds: continued.focusIds ?? [siteId] };
    }
    return reply(text, "success", this.locationChoices(), { focusIds: [siteId] });
  }

  // --- location ---

  private locationChoices(): ArchitectChoice[] {
    const choices: ArchitectChoice[] = [{ label: "📍 Pick a spot", say: "Pick a location" }];
    if (this.activeSite(this.existence())) {
      choices.push({ label: "Site centre", say: "Use the site centre" });
    } else {
      choices.push({ label: "At the origin (0, 0)", say: "at 0, 0" });
    }
    if (!this.request) {
      choices.push({ label: "Build a 3-bedroom house", say: "Build a 3 bedroom house" });
    }
    return choices;
  }

  private askLocation(lead: string): ArchitectReply {
    this.pending = { kind: "location" };
    return reply(`${lead} Click a spot on the ground, or give coordinates like “at 4, -2”.`, "question", this.locationChoices());
  }

  private askPick(): ArchitectReply {
    const footprint = this.layout?.footprint ?? (this.request && hasDetails(this.request) ? resolveFootprint(this.request) : null);
    return reply(
      footprint ? `Click where the centre of the ${fmtSize(footprint)} house should go. Press Esc to cancel.` : "Click a spot on the ground. Press Esc to cancel.",
      "question",
      [],
      { pickLocation: { footprint } }
    );
  }

  private setLocationRef(ref: LocationRef): ArchitectReply {
    if (ref.kind === "point") return this.setLocation(ref.point);
    if (ref.kind === "site-centre") {
      const site = this.activeSite(this.existence());
      if (!site) {
        return reply("There's no site yet. Describe it first (e.g. “My plot is 30 × 20 m”), or give coordinates.", "question", [
          { label: "Set up a 30 × 20 m site", say: "Set up a 30 x 20 m site" },
          { label: "At the origin (0, 0)", say: "at 0, 0" }
        ]);
      }
      return this.setLocation(site.center);
    }
    return this.location ? this.setLocation(this.location) : this.askPick();
  }

  private setLocation(point: PlanPoint): ArchitectReply {
    const exists = this.existence();
    if (this.layout && this.started(exists)) {
      return reply(
        `Construction has already started at ${fmtPoint(this.layout.center)}. Select the parts and drag them to move them, or say “new design” to start another house at ${fmtPoint(point)}.`,
        "info",
        [{ label: "New design", say: "new design" }]
      );
    }
    this.location = point;
    const site = this.activeSite(exists);
    const outside =
      site && (Math.abs(point.x - site.center.x) > site.length / 2 || Math.abs(point.z - site.center.z) > site.width / 2) ? " That's outside the site." : "";
    if (this.request) {
      return this.advance(`Location set to ${fmtPoint(point)}.${outside}`);
    }
    return reply(`Location set to ${fmtPoint(point)}.${outside} What should I build there?`, "success", [
      { label: "2-bedroom house", say: "Build a 2 bedroom house here" },
      { label: "3-bedroom house", say: "Build a 3 bedroom house here" },
      { label: "Pick another spot", say: "Pick a location" }
    ]);
  }

  // --- the house design ---

  private startHouse(request: HouseDesignRequest, location: LocationRef | undefined, unsupported: string | undefined): ArchitectReply {
    if (unsupported) {
      return reply(unsupported, "error", [{ label: "Single-storey, 3 bedrooms", say: "Build a 3 bedroom house" }]);
    }
    const exists = this.existence();
    if (this.layout && this.started(exists)) {
      return reply("A house is already under construction. Keep building it, or say “new design” to start another one (this one stays as it is).", "info", [
        ...this.nextChoices(exists),
        { label: "New design", say: "new design" }
      ]);
    }
    this.request = { ...request };
    this.layout = null;
    if (location) {
      const resolved = this.resolveRef(location);
      if (resolved) this.location = resolved;
    }
    return this.advance();
  }

  private updateRequest(changes: HouseDesignRequest, location: LocationRef | undefined): ArchitectReply {
    if (this.layout && this.started(this.existence())) {
      return reply(
        "Construction has already started, so I can't resize the plan in place. Undo the built stages first, or say “new design” to plan another house.",
        "info",
        [{ label: "New design", say: "new design" }]
      );
    }
    const merged: HouseDesignRequest = { ...(this.request ?? {}), ...changes };
    // A new bedroom count replaces an earlier explicit room list.
    if (changes.bedrooms !== undefined && !changes.rooms) delete merged.rooms;
    this.request = merged;
    if (location) {
      const resolved = this.resolveRef(location);
      if (resolved) this.location = resolved;
    }
    return this.advance();
  }

  private resolveRef(ref: LocationRef): PlanPoint | null {
    if (ref.kind === "point") return ref.point;
    if (ref.kind === "site-centre") return this.activeSite(this.existence())?.center ?? null;
    return this.location;
  }

  /**
   * Moves the house design forward to the next thing it needs: details →
   * location → a valid plan → inside the site → clear of existing
   * construction → the user's go-ahead. Each gap is a question, never a
   * guess.
   */
  private advance(lead = ""): ArchitectReply {
    const prefix = lead ? `${lead} ` : "";
    const request = this.request ?? {};
    this.layout = null;

    if (!hasDetails(request)) {
      this.pending = { kind: "house-details" };
      const site = this.activeSite(this.existence());
      const presets = SIZE_PRESETS.filter(({ footprint }) => !site || (footprint.length <= site.length && footprint.width <= site.width));
      return reply(
        `${prefix}Happy to design it. How big should it be? Pick a starting point, or describe it (e.g. “3 bedrooms, 12 × 9 m”).`,
        "question",
        [
          ...presets.map(({ bedrooms, footprint }) => ({
            label: `${plural(bedrooms, "bedroom")} · ${fmtSize(footprint)}`,
            say: `${plural(bedrooms, "bedroom")}, ${fmt(footprint.length)} x ${fmt(footprint.width)} m`
          })),
          { label: "You decide", say: "you decide" }
        ]
      );
    }

    if (!this.location) {
      return this.askLocation(`${prefix}Where should the house go?`);
    }

    const planned = planHouseDesign(request, [], this.location);
    if (!planned.ok) {
      this.pending = { kind: "house-details" };
      return reply(`${prefix}${planned.error}`, "error", [
        { label: "3 bedrooms · 12 × 9 m", say: "3 bedrooms, 12 x 9 m" },
        { label: "2 bedrooms · 10 × 8 m", say: "2 bedrooms, 10 x 8 m" }
      ]);
    }
    const layout = planned.layout;
    const { footprint } = layout;

    const site = this.activeSite(this.existence());
    if (site) {
      if (footprint.length > site.length || footprint.width > site.width) {
        this.pending = { kind: "house-details" };
        return reply(`${prefix}A ${fmtSize(footprint)} house won't fit on the ${fmtSize(site)} site. Shall I make it smaller?`, "question", [
          ...SIZE_PRESETS.filter((preset) => preset.footprint.length <= site.length && preset.footprint.width <= site.width).map(({ bedrooms, footprint: size }) => ({
            label: `${plural(bedrooms, "bedroom")} · ${fmtSize(size)}`,
            say: `${plural(bedrooms, "bedroom")}, ${fmt(size.length)} x ${fmt(size.width)} m`
          }))
        ]);
      }
      const clamp = (value: number, centre: number, siteHalf: number, houseHalf: number) =>
        Math.min(Math.max(value, centre - siteHalf + houseHalf), centre + siteHalf - houseHalf);
      const fitted = {
        x: Math.round(clamp(this.location.x, site.center.x, site.length / 2, footprint.length / 2) * 10) / 10,
        z: Math.round(clamp(this.location.z, site.center.z, site.width / 2, footprint.width / 2) * 10) / 10
      };
      if (Math.abs(fitted.x - this.location.x) > 1e-6 || Math.abs(fitted.z - this.location.z) > 1e-6) {
        this.pending = { kind: "fit", suggested: fitted };
        return reply(
          `${prefix}A ${fmtSize(footprint)} house centred at ${fmtPoint(this.location)} would cross the site boundary. Shift it to ${fmtPoint(fitted)} so it fits?`,
          "question",
          [
            { label: `Shift to ${fmtPoint(fitted)}`, say: "yes" },
            { label: "Pick another spot", say: "Pick a location" }
          ]
        );
      }
    }

    const conflicts = this.conflictsAt(footprint, this.location);
    if (conflicts.length > 0) {
      const nearest = this.nearestFreeSpot(footprint, this.location);
      this.pending = { kind: "conflict", conflictIds: conflicts.map((object) => object.id), nearest };
      const names = conflicts.slice(0, 4).map((object) => object.label ?? object.id);
      const more = conflicts.length > 4 ? ` and ${conflicts.length - 4} more` : "";
      return reply(
        `${prefix}A ${fmtSize(footprint)} house at ${fmtPoint(this.location)} would overlap existing construction: ${list(names)}${more}. What would you like to do?`,
        "question",
        [
          { label: `Clear ${conflicts.length === 1 ? "it" : "them"} and build here`, say: "Clear them and build here" },
          ...(nearest ? [{ label: `Nearest free spot ${fmtPoint(nearest)}`, say: "Use the nearest free spot" }] : []),
          { label: "Pick another spot", say: "Pick a location" }
        ],
        { focusIds: conflicts.map((object) => object.id) }
      );
    }

    this.layout = layout;
    this.pending = { kind: "confirm-plan" };
    const rooms = layout.rooms.map((room) => room.name);
    const bedrooms = rooms.filter((name) => /bed/i.test(name)).length;
    return reply(
      `${prefix}Here's the plan: a ${fmtSize(footprint)} single-storey house centred at ${fmtPoint(layout.center)}, with ${plural(rooms.length, "room")} — ${list(rooms)}. ` +
        `I'll build it in ${ARCHITECT_STAGES.length} stages (${ARCHITECT_STAGES.map((stage) => stage.label.toLowerCase()).join(", ")}); each stage is one undo step. Shall I lay the foundation?`,
      "question",
      [
        { label: "Lay the foundation", say: "Lay the foundation" },
        { label: "Build everything", say: "Build everything" },
        { label: bedrooms === 3 ? "Make it 2 bedrooms" : "Make it 3 bedrooms", say: bedrooms === 3 ? "2 bedrooms" : "3 bedrooms" },
        { label: "Move it", say: "Pick a location" }
      ]
    );
  }

  /** Existing objects a house of `footprint` centred at `center` would overlap - ground surfaces (the site itself, paths) excepted. */
  private conflictsAt(footprint: HouseFootprint, center: PlanPoint): { id: string; label?: string; hostId?: string; type: string }[] {
    const snapshot = this.options.snapshot();
    const geometry = analyzeConstructionGeometry(snapshot);
    const byId = new Map(snapshot.objects.map((object) => [object.id, object]));
    const x0 = center.x - footprint.length / 2 - CLEARANCE;
    const x1 = center.x + footprint.length / 2 + CLEARANCE;
    const z0 = center.z - footprint.width / 2 - CLEARANCE;
    const z1 = center.z + footprint.width / 2 + CLEARANCE;
    const conflicts: { id: string; label?: string; hostId?: string; type: string }[] = [];
    for (const entry of geometry.objects) {
      const object = byId.get(entry.id);
      if (!object || (object.kind && GROUND_KINDS.has(object.kind))) continue;
      const { min, max } = entry.aabb;
      if (min.x < x1 && max.x > x0 && min.z < z1 && max.z > z0) {
        conflicts.push({ id: object.id, type: object.type, ...(object.label ? { label: object.label } : {}), ...(object.hostId ? { hostId: object.hostId } : {}) });
      }
    }
    return conflicts;
  }

  /** The nearest centre (on a half-metre grid, within 30 m) where the house is clear of everything and inside the site, if there is a site. */
  private nearestFreeSpot(footprint: HouseFootprint, from: PlanPoint): PlanPoint | null {
    const site = this.activeSite(this.existence());
    const inside = (point: PlanPoint) =>
      !site ||
      (Math.abs(point.x - site.center.x) <= site.length / 2 - footprint.length / 2 + 1e-6 &&
        Math.abs(point.z - site.center.z) <= site.width / 2 - footprint.width / 2 + 1e-6);
    const step = 0.5;
    for (let ring = 1; ring <= 60; ring += 1) {
      let best: PlanPoint | null = null;
      let bestDistance = Infinity;
      for (let i = -ring; i <= ring; i += 1) {
        for (let j = -ring; j <= ring; j += 1) {
          if (Math.max(Math.abs(i), Math.abs(j)) !== ring) continue;
          const point = { x: Math.round((from.x + i * step) * 10) / 10, z: Math.round((from.z + j * step) * 10) / 10 };
          const distance = Math.hypot(i, j);
          if (distance >= bestDistance || !inside(point)) continue;
          if (this.conflictsAt(footprint, point).length === 0) {
            best = point;
            bestDistance = distance;
          }
        }
      }
      if (best) return best;
    }
    return null;
  }

  private clearConflicts(ids: readonly string[]): ArchitectReply {
    const snapshot = this.options.snapshot();
    const targets = snapshot.objects.filter((object) => ids.includes(object.id));
    // An opening hosted in a wall being removed goes with that wall.
    const commands = targets
      .filter((object) => !(object.hostId && ids.includes(object.hostId)))
      .map((object) => ({ type: `${object.type}.delete`, id: object.id }));
    const batch = executeCommandBatch(this.options.commandExecutor, commands, this.options.history);
    if (!batch.success) {
      return reply(`I couldn't clear the way: ${batch.message ?? batch.results[batch.failedIndex ?? 0]?.message ?? "unknown error"}`, "error");
    }
    return this.advance(`Cleared ${plural(commands.length, "object")} (one undo step).`);
  }

  // --- building ---

  private existence(): (id: string) => boolean {
    const ids = new Set(this.options.snapshot().objects.map((object) => object.id));
    return (id) => ids.has(id);
  }

  private activeSite(exists: (id: string) => boolean): SiteRecord | null {
    return this.site && exists(this.site.id) ? this.site : null;
  }

  private isBuilt(stage: ArchitectStage, exists: (id: string) => boolean): boolean {
    if (stage === "interiors") {
      return this.layout !== null && this.layout.rooms.every((room) => this.isFurnished(room.name, exists));
    }
    const ids = this.built.get(stage);
    return !!ids && ids.some(exists);
  }

  private isFurnished(room: string, exists: (id: string) => boolean): boolean {
    const ids = this.furnished.get(room);
    return !!ids && (ids.length === 0 || ids.some(exists));
  }

  private anyStageBuilt(exists: (id: string) => boolean): boolean {
    return STAGE_IDS.some((stage) => (stage === "interiors" ? this.layout?.rooms.some((room) => this.isFurnished(room.name, exists)) : this.isBuilt(stage, exists)));
  }

  private started(exists: (id: string) => boolean): boolean {
    return this.anyStageBuilt(exists);
  }

  private nextStage(exists: (id: string) => boolean): ArchitectStage | null {
    return STAGE_IDS.find((stage) => !this.isBuilt(stage, exists)) ?? null;
  }

  private stageViews(exists: (id: string) => boolean): ArchitectStageView[] {
    const next = this.nextStage(exists);
    return ARCHITECT_STAGES.map(({ id, label }) => ({ id, label, status: this.isBuilt(id, exists) ? "done" : id === next ? "next" : "todo" }));
  }

  private nextChoices(exists: (id: string) => boolean): ArchitectChoice[] {
    const next = this.nextStage(exists);
    if (!next) return [];
    const stage = ARCHITECT_STAGES.find((entry) => entry.id === next)!;
    const remaining = STAGE_IDS.length - STAGE_IDS.indexOf(next);
    return [{ label: `Next: ${stage.label}`, say: stage.say }, ...(remaining > 1 ? [{ label: "Build everything", say: "Build everything" }] : [])];
  }

  /** Before any stage: a plan must exist (or be finished first). */
  private requirePlan(): ArchitectReply | null {
    if (this.layout) return null;
    if (this.request) return this.advance("I need a few things settled before building.");
    return reply("There's no house planned yet. Tell me what to build — for example “Build a 3-bedroom house”.", "question", [
      { label: "Build a 3-bedroom house", say: "Build a 3 bedroom house" },
      { label: "Build a 2-bedroom house", say: "Build a 2 bedroom house" }
    ]);
  }

  private buildNext(): ArchitectReply {
    const missing = this.requirePlan();
    if (missing) return missing;
    const next = this.nextStage(this.existence());
    if (!next) return this.complete("The house is already complete.");
    return this.buildStages([next]);
  }

  private buildAll(upTo: ArchitectStage | undefined): ArchitectReply {
    const missing = this.requirePlan();
    if (missing) return missing;
    const exists = this.existence();
    const last = upTo ? STAGE_IDS.indexOf(upTo) : STAGE_IDS.length - 1;
    const stages = STAGE_IDS.slice(0, last + 1).filter((stage) => !this.isBuilt(stage, exists));
    if (stages.length === 0) return this.complete("Everything up to there is already built.");
    return this.buildStages(stages);
  }

  private buildStage(stage: ArchitectStage, text: string): ArchitectReply {
    // "Furnish the living room" on a house this conversation didn't plan
    // (built by hand or by the AI Prompt): furnish its real rooms directly.
    if (stage === "interiors" && !this.layout && listRooms(this.options.snapshot()).length > 0) {
      return this.roomEdit(furnishRooms(this.rooms, text, false));
    }
    const missing = this.requirePlan();
    if (missing) return missing;
    const exists = this.existence();
    const index = STAGE_IDS.indexOf(stage);
    const before = STAGE_IDS.slice(0, index).filter((id) => !this.isBuilt(id, exists));
    const label = ARCHITECT_STAGES[index].label.toLowerCase();
    if (before.length > 0) {
      this.pending = { kind: "stage-order", target: stage };
      const labels = before.map((id) => ARCHITECT_STAGES[STAGE_IDS.indexOf(id)].label.toLowerCase());
      return reply(`The ${label} come${/s$/.test(label) ? "" : "s"} after ${list(labels)}, which ${before.length === 1 ? "isn't" : "aren't"} built yet. Build ${before.length === 1 ? "that" : "those"} first, then the ${label}?`, "question", [
        { label: `Yes, build up to the ${label}`, say: "yes" },
        { label: "Just the next stage", say: "next" }
      ]);
    }
    if (stage === "interiors") return this.furnishFromText(text);
    if (this.isBuilt(stage, exists)) return this.complete(`The ${label} ${/s$/.test(label) ? "are" : "is"} already built.`);
    return this.buildStages([stage]);
  }

  private askHouseMaterial(stages: readonly ArchitectStage[], lead = "Before I raise the walls:"): ArchitectReply {
    this.pending = { kind: "house-material", stages: [...stages] };
    return reply(
      `${lead} what should the house walls be built of? ${WALL_MATERIALS.map((material) => material.label).join(", ")}.`,
      "question",
      WALL_MATERIALS.map((material) => ({ label: material.label, say: material.label.toLowerCase() }))
    );
  }

  /** Runs `stages` in order, each as its own undo step, stopping at the first failure. */
  private buildStages(stages: readonly ArchitectStage[]): ArchitectReply {
    if (stages.includes("structure") && !this.houseWallMaterial) {
      return this.askHouseMaterial(stages);
    }
    const lines: string[] = [];
    const focusIds: string[] = [];
    for (const stage of stages) {
      const outcome = stage === "interiors" ? this.runInteriors(this.layout!.rooms.map((room) => room.name).filter((name) => !this.isFurnished(name, this.existence()))) : this.runStage(stage);
      if (!outcome.ok) {
        lines.push(`✗ ${outcome.line}`);
        return reply(lines.join("\n"), "error", [{ label: "Try again", say: ARCHITECT_STAGES[STAGE_IDS.indexOf(stage)].say }], { focusIds });
      }
      lines.push(`✓ ${outcome.line}`);
      focusIds.push(...outcome.ids);
    }
    return this.afterBuild(lines, focusIds);
  }

  private afterBuild(lines: string[], focusIds: string[]): ArchitectReply {
    const exists = this.existence();
    const next = this.nextStage(exists);
    if (!next) {
      return this.complete(lines.join("\n"), focusIds);
    }
    const label = ARCHITECT_STAGES[STAGE_IDS.indexOf(next)].label.toLowerCase();
    return reply(`${lines.join("\n")}\n\nNext up: ${label}.`, "success", [...this.nextChoices(exists), { label: "Undo", say: "undo" }], { focusIds });
  }

  private complete(lead: string, focusIds?: string[]): ArchitectReply {
    return reply(
      `${lead}\n\nThe house is complete and fully editable: select any wall, door, room or piece of furniture to move or resize it, or tell me — e.g. “make the selected wall 5 metres long” or “add a window” with a wall selected.`,
      "success",
      [
        { label: "Undo last stage", say: "undo" },
        { label: "Start a new design", say: "new design" }
      ],
      focusIds ? { focusIds } : {}
    );
  }

  private runBatch(commands: readonly unknown[]): { ok: true; results: CommandResult[] } | { ok: false; message: string } {
    const batch = executeCommandBatch(this.options.commandExecutor, commands, this.options.history);
    if (batch.success) return { ok: true, results: batch.results };
    const failed = batch.failedIndex !== undefined ? batch.results[batch.failedIndex] : undefined;
    return { ok: false, message: batch.message ?? failed?.message ?? "a command failed" };
  }

  private runStage(stage: Exclude<ArchitectStage, "interiors">): { ok: boolean; line: string; ids: string[] } {
    const layout = this.layout!;
    const exists = this.existence();
    let commands: unknown[];
    let skippedNote = "";
    switch (stage) {
      case "foundation":
        commands = foundationStageCommands(layout);
        break;
      case "structure": {
        // Every wall in the chosen material, with its library colour; the planned thickness is kept.
        const material = wallMaterial(this.houseWallMaterial ?? undefined);
        commands = structureStageCommands(layout).map((command) =>
          command.type === "wall.add" && material ? { ...command, wall: { ...command.wall, material: material.id, color: material.color } } : command
        );
        break;
      }
      case "openings": {
        if (!this.refs) return { ok: false, line: "Doors & windows: I can't find the walls to put them in.", ids: [] };
        const planned = openingsStageCommands(layout, this.refs);
        // An opening whose wall was deleted by hand is left out, not forced.
        const hosted = planned.commands.filter((command) => exists(command.type === "door.add" ? command.door.hostId! : command.window.hostId!));
        commands = hosted;
        const skipped = planned.skippedWindows + planned.commands.length - hosted.length;
        if (skipped > 0) skippedNote = ` (${plural(skipped, "opening")} left out — no room for ${skipped === 1 ? "it" : "them"})`;
        break;
      }
      case "rooms":
        commands = roomsStageCommands(layout);
        break;
      case "roof":
        commands = roofStageCommands(layout);
        break;
    }
    const label = ARCHITECT_STAGES[STAGE_IDS.indexOf(stage)].label;
    const result = this.runBatch(commands);
    if (!result.ok) {
      return { ok: false, line: `${label}: ${result.message} Nothing from this stage was kept.`, ids: [] };
    }
    const ids = result.results.map((entry) => entry.objectId).filter((id): id is string => !!id);
    this.built.set(stage, ids);
    if (stage === "structure") this.refs = readStructureRefs(result.results);

    const { footprint, interiorWalls, rooms } = layout;
    const lines: Record<typeof stage, string> = {
      foundation: `Foundation laid — a ${fmtSize(footprint)} floor slab, 0.2 m thick.`,
      structure: `Walls & columns up — 4 exterior walls, ${plural(interiorWalls.length, "interior wall")} and 4 corner columns, 2.7 m high.`,
      openings: `Doors & windows in — ${plural(commands.filter((c) => (c as { type: string }).type === "door.add").length, "door")} and ${plural(
        commands.filter((c) => (c as { type: string }).type === "window.add").length,
        "window"
      )}, each cut into its wall${skippedNote}.`,
      rooms: `Rooms marked — ${list(rooms.map((room) => room.name))}.`,
      roof: "Roof on — a pitched gable roof with a 0.3 m eave all round."
    };
    return { ok: true, line: lines[stage], ids };
  }

  // --- interiors ---

  private furnishFromText(text: string): ArchitectReply {
    const layout = this.layout!;
    const exists = this.existence();
    const names = layout.rooms.map((room) => room.name);
    const lower = text.toLowerCase();
    let targets = names.filter((name) => new RegExp(`\\b${name.toLowerCase().replace(/\s+/g, "\\s+")}\\b`).test(lower));
    if (targets.length === 0) {
      const groups: readonly { pattern: RegExp; plural: RegExp; match: RegExp }[] = [
        { pattern: /\bbed\s*rooms?\b/, plural: /\bbed\s*rooms\b/, match: /bed/i },
        { pattern: /\bbath\s*rooms?\b/, plural: /\bbath\s*rooms\b/, match: /bath/i },
        { pattern: /\bkitchens?\b/, plural: /\bkitchens\b/, match: /kitchen/i },
        { pattern: /\bliving\b|\blounge\b/, plural: /$^/, match: /living/i },
        { pattern: /\bdining\b/, plural: /$^/, match: /dining/i },
        { pattern: /\bstudy\b|\boffice\b/, plural: /$^/, match: /study/i }
      ];
      const group = groups.find(({ pattern }) => pattern.test(lower));
      if (group) {
        const matching = names.filter((name) => group.match.test(name));
        if (matching.length === 0) {
          return reply(`This house has no such room. Its rooms are ${list(names)}.`, "question", names.slice(0, 4).map((name) => ({ label: name, say: `Furnish the ${name}` })));
        }
        if (matching.length > 1 && !group.plural.test(lower)) {
          this.pending = { kind: "which-room", options: matching };
          return reply(`Which one? There are ${matching.length}: ${list(matching)}.`, "question", [
            ...matching.map((name) => ({ label: name, say: `Furnish ${name}` })),
            { label: "All of them", say: "all of them" }
          ]);
        }
        targets = matching;
      } else {
        targets = names;
      }
    }
    const todo = targets.filter((name) => !this.isFurnished(name, exists));
    if (todo.length === 0) {
      return reply(`${list(targets)} ${targets.length === 1 ? "is" : "are"} already furnished.`, "info", this.nextChoices(exists));
    }
    return this.furnish(todo);
  }

  private furnish(rooms: readonly string[]): ArchitectReply {
    const outcome = this.runInteriors(rooms);
    if (!outcome.ok) return reply(`✗ ${outcome.line}`, "error", [{ label: "Try again", say: "Furnish the house" }]);
    return this.afterBuild([`✓ ${outcome.line}`], outcome.ids);
  }

  private runInteriors(rooms: readonly string[]): { ok: boolean; line: string; ids: string[] } {
    // Furnished from the model as it stands - its real room elements (the
    // ones the rooms stage built) and its real doors and windows, wherever
    // they are now - so an opening moved or added since is respected.
    const snapshot = this.options.snapshot();
    const roomIds = new Set(this.built.get("rooms") ?? []);
    const targets = snapshot.objects.filter((object) => roomIds.has(object.id) && rooms.includes(object.label ?? "")).map((object) => object.id);
    if (targets.length === 0) {
      return { ok: false, line: "Interiors: I can't find the room elements to furnish — the rooms stage may have been undone.", ids: [] };
    }
    const plan = planFurnishingsInScene(snapshot, targets);
    const result = this.runBatch(plan.commands);
    if (!result.ok) {
      return { ok: false, line: `Interiors: ${result.message} Nothing from this stage was kept.`, ids: [] };
    }
    for (const [room, indices] of plan.byRoom) {
      this.furnished.set(
        room,
        indices.map((index) => result.results[index]?.objectId).filter((id): id is string => !!id)
      );
    }
    const ids = result.results.map((entry) => entry.objectId).filter((id): id is string => !!id);
    const skipped = plan.skipped > 0 ? ` (${plural(plan.skipped, "piece")} left out where ${plan.skipped === 1 ? "it" : "they"} wouldn't fit clear of doors and windows)` : "";
    return { ok: true, line: `Interiors furnished — ${plural(ids.length, "piece")} of furniture across ${list([...plan.byRoom.keys()])}${skipped}.`, ids };
  }

  // --- single openings ---

  private singleOpening(opening: "door" | "window", text: string): ArchitectReply {
    const snapshot = this.options.snapshot();
    const named = /\b(wall-\d+)\b/i.exec(text)?.[1];
    const wallId = named ?? snapshot.selectedObjectId ?? undefined;
    const wall = wallId ? snapshot.objects.find((object) => object.id === wallId && object.type === "wall") : undefined;
    if (wall) {
      const command = opening === "door" ? { type: "door.add", door: { hostId: wall.id } } : { type: "window.add", window: { hostId: wall.id } };
      const result = this.runBatch([command]);
      if (!result.ok) return reply(`I couldn't add the ${opening}: ${result.message}`, "error");
      const id = result.results[0].objectId;
      return reply(`Added a ${opening} to ${wall.id} at the first free spot in it. Drag it along the wall to adjust.`, "success", [{ label: "Undo", say: "undo" }], {
        focusIds: id ? [id] : []
      });
    }
    const exists = this.existence();
    if (this.layout && this.isBuilt("structure", exists) && !this.isBuilt("openings", exists)) {
      this.pending = { kind: "opening-scope" };
      return reply(`Do you mean all the planned doors and windows, or one ${opening} in a particular wall?`, "question", [
        { label: "All planned doors & windows", say: "yes" },
        { label: `One ${opening} — I'll select a wall`, say: "no" }
      ]);
    }
    return reply(`Which wall? Select it in the viewport, then ask again — I'll put the ${opening} at the first free spot in it.`, "question");
  }

  // --- everything else ---

  // --- one wall, by conversation (wallBuilder.ts) ---

  /** Asks for the first thing the draft is missing - or, once nothing is, confirms it. Nothing is assumed. */
  private continueWall(draft: WallDraft, lead = ""): ArchitectReply {
    const prefix = lead ? `${lead} ` : "";
    this.wallPick = null;
    for (const slot of ["length", "height", "thickness"] as const) {
      const value = draft[slot];
      const problem = value === undefined ? null : wallSizeProblem(slot, value);
      if (problem) return this.continueWall({ ...draft, [slot]: undefined }, `${prefix}${problem}`);
    }
    const slot = missingWallSlot(draft);
    if (slot) {
      const question = wallQuestion(slot, draft);
      this.pending = { kind: "wall", draft, slot };
      return reply(`${prefix}${question.text}`, "question", [...question.choices, { label: "Cancel", say: "cancel" }]);
    }
    const center = this.resolveRef(draft.location!);
    if (!center) {
      return this.continueWall({ ...draft, location: undefined }, `${prefix}I can't place it there.`);
    }
    const complete = draft as Required<Omit<WallDraft, "location">>;
    const overlaps = this.wallOverlaps(wallFootprint(draft), center);
    const warning = overlaps.length > 0 ? ` Heads-up: it would overlap ${list(overlaps.map((object) => object.label ?? object.id))}.` : "";
    this.pending = { kind: "wall", draft, slot: "confirm" };
    return reply(
      `${prefix}Ready to build ${describeWall({ ...complete, center })} - ${fmtMeters(wallVolume(complete)).replace(" m", " m³")} of masonry.${warning} Build it?`,
      "question",
      [
        { label: overlaps.length > 0 ? "Build anyway" : "Build it", say: "yes" },
        { label: "📍 Pick another spot", say: "pick a location" },
        { label: "Cancel", say: "cancel" }
      ],
      overlaps.length > 0 ? { focusIds: overlaps.map((object) => object.id) } : {}
    );
  }

  private answerWall(pending: Extract<Pending, { kind: "wall" }>, u: Utterance, text: string): ArchitectReply | null {
    const { draft, slot } = pending;
    if (u.kind === "no") {
      return reply("OK — no wall was built.", "info", [{ label: "Start a wall again", say: "add a wall" }]);
    }
    if (u.kind === "pick-location" && (slot === "position" || slot === "confirm")) {
      return this.askWallPick({ ...draft, location: undefined });
    }
    if (slot === "confirm" && u.kind === "yes") {
      return this.buildWall(draft);
    }
    // Another request altogether: let it through (this wall is dropped).
    if (["undo", "help", "reset", "status", "house", "site", "stage", "all", "show", "show-roof", "refurnish", "move-opening", "single-opening", "build-wall", "next"].includes(u.kind)) {
      return null;
    }
    const stated = readWallDraft(text);
    const answer = slot === "confirm" ? undefined : readSlotAnswer(slot, text, draft);
    const merged: WallDraft = { ...draft };
    for (const [key, value] of Object.entries({ ...stated, ...answer })) {
      if (value !== undefined) (merged as Record<string, unknown>)[key] = value;
    }
    if (JSON.stringify(merged) === JSON.stringify(draft)) {
      if (slot === "confirm") {
        this.pending = pending;
        return reply("Say “yes” to build it, change a value (e.g. “make it 4 m long”), or “cancel”.", "question", [
          { label: "Build it", say: "yes" },
          { label: "Cancel", say: "cancel" }
        ]);
      }
      return this.continueWall(draft, `I didn't catch the ${slot === "position" ? "position" : slot}.`);
    }
    return this.continueWall(merged);
  }

  private askWallPick(draft: WallDraft): ArchitectReply {
    this.wallPick = draft;
    this.pending = { kind: "wall", draft, slot: "position" };
    return reply(
      "Click where the wall's centre should go in the 3D view - or say coordinates like “at 2, 3”.",
      "question",
      [{ label: "Cancel", say: "cancel" }],
      { pickLocation: { footprint: wallFootprint(draft) } }
    );
  }

  /** Builds a complete draft as ONE validated, undoable wall.add, and says exactly what was built. */
  private buildWall(draft: WallDraft): ArchitectReply {
    const center = draft.location ? this.resolveRef(draft.location) : null;
    if (!center) return this.continueWall({ ...draft, location: undefined }, "I need a position first.");
    const complete = draft as Required<Omit<WallDraft, "location">>;
    const result = this.runBatch([wallCommand(complete, center)]);
    if (!result.ok) {
      this.pending = { kind: "wall", draft, slot: "confirm" };
      return reply(`The wall wasn't built: ${result.message} Nothing was changed.`, "error", [{ label: "Try again", say: "yes" }, { label: "Cancel", say: "cancel" }]);
    }
    const id = result.results[0]?.objectId ?? "the wall";
    return reply(
      `Built ${id}: ${describeWall({ ...complete, center })} - ${fmtMeters(wallVolume(complete)).replace(" m", " m³")} of masonry. Select it to inspect or edit its dimensions; undo removes it in one step.`,
      "success",
      [
        { label: "Undo", say: "undo" },
        { label: "Add another wall", say: "add a wall" }
      ],
      result.results[0]?.objectId ? { focusIds: [result.results[0].objectId] } : {}
    );
  }

  /** Objects a new wall would overlap - butting against another wall (touching faces) is fine. */
  private wallOverlaps(footprint: HouseFootprint, center: PlanPoint): { id: string; label?: string }[] {
    const snapshot = this.options.snapshot();
    const geometry = analyzeConstructionGeometry(snapshot);
    const byId = new Map(snapshot.objects.map((object) => [object.id, object]));
    const tolerance = 0.01;
    const x0 = center.x - footprint.length / 2 + tolerance;
    const x1 = center.x + footprint.length / 2 - tolerance;
    const z0 = center.z - footprint.width / 2 + tolerance;
    const z1 = center.z + footprint.width / 2 - tolerance;
    const overlaps: { id: string; label?: string }[] = [];
    for (const entry of geometry.objects) {
      const object = byId.get(entry.id);
      if (!object || (object.kind && GROUND_KINDS.has(object.kind)) || object.kind === "room") continue;
      const { min, max } = entry.aabb;
      if (min.x < x1 && max.x > x0 && min.z < z1 && max.z > z0) {
        overlaps.push({ id: object.id, ...(object.label ? { label: object.label } : {}) });
      }
    }
    return overlaps;
  }

  private async fallback(text: string): Promise<ArchitectReply> {
    if (!this.options.fallback) {
      return this.help("I didn't catch that.");
    }
    let result: AIPipelineResult;
    try {
      result = await this.options.fallback(text, { housePlan: "return" });
    } catch (error) {
      return this.aiFailure(text, error instanceof Error ? error.message : String(error));
    }
    if (result.success && result.housePlan) {
      // The AI read the turn as a whole house: the same staged design flow
      // as a house this session recognizes itself - location and size
      // questions first, then one stage (one undo step) at a time.
      return this.startHouse(result.housePlan, undefined, undefined);
    }
    if (result.success) {
      const created = summarizeCreatedObjects(result.outcomes);
      const updated = created ? null : summarizeUpdatedObjects(result.outcomes);
      const what = created
        ? `Created ${created.byType.map((entry) => `${entry.count} ${entry.label}`).join(", ")}.`
        : updated
          ? `Updated ${plural(updated.total, "object")}.`
          : "Done.";
      return reply(result.notes ? `${what} ${result.notes}` : what, "success", [{ label: "Undo", say: "undo" }], {
        focusIds: created?.objectIds ?? updated?.objectIds ?? []
      });
    }
    return this.aiFailure(text, result.errors[0]?.message ?? "That didn't work.");
  }

  /**
   * A failed AI request, in the architect's own words. The AI Prompt tab's
   * "unreachable" line offers Retry and Demo Mode buttons that this panel
   * doesn't have, so it is replaced here; every failure offers "Try again"
   * (the same words, sent again) and, when the AI side is what failed,
   * says what still works without it.
   */
  private aiFailure(text: string, raw: string): ArchitectReply {
    const message = isNetworkUnreachable(raw) ? "I couldn't reach the AI server for that request, so nothing was changed." : friendlyAiErrorMessage(raw);
    const aiSide = /couldn't reach|unavailable|taking too long|sign[ -]in|not responding|requests right now/i.test(message);
    return reply(`${message}${aiSide ? ` ${this.offlineHint()}` : ""}`, "error", [{ label: "Try again", say: text }, ...this.helpChoices()]);
  }

  private offlineHint(): string {
    return "Sites, locations, house design, every build stage, and edits to a selected object (move, rotate, resize) all work without the AI server.";
  }

  private helpChoices(): ArchitectChoice[] {
    const exists = this.existence();
    if (this.layout) return [...this.nextChoices(exists), { label: "Status", say: "status" }];
    return [
      { label: "Set up a 30 × 20 m site", say: "Set up a 30 x 20 m site" },
      { label: "Build a 3-bedroom house", say: "Build a 3 bedroom house" },
      { label: "Build a wall", say: "Add a wall" }
    ];
  }

  private help(lead = ""): ArchitectReply {
    return reply(
      `${lead ? `${lead} ` : ""}Here's how we work:\n` +
        "1. Site — “My plot is 30 × 20 m”.\n" +
        "2. Location — click 📍 or say “at 4, -2”.\n" +
        "3. House — “Build a 3-bedroom house” (I'll ask about anything unclear, including the wall material).\n" +
        "   Or one wall at a time — “add a 5 m brick wall at 2, 3”: I'll ask for any material, size or position you don't say.\n" +
        "4. Build — stage by stage (“lay the foundation”, “next”) or “build everything”. Each stage is one undo step.\n" +
        "5. Edit — select anything to move or resize it, or say “make the selected wall 5 metres long”, “add a window” with a wall selected, “furnish the living room”.\n" +
        "Use the 🎤 button to speak instead of typing.",
      "info",
      this.helpChoices()
    );
  }

  private status(lead = ""): ArchitectReply {
    const exists = this.existence();
    const parts: string[] = [];
    const site = this.activeSite(exists);
    parts.push(site ? `Site: ${fmtSize(site)} at ${fmtPoint(site.center)}.` : "Site: not set.");
    parts.push(this.location ? `Location: ${fmtPoint(this.location)}.` : "Location: not chosen.");
    if (this.layout) {
      const done = ARCHITECT_STAGES.filter(({ id }) => this.isBuilt(id, exists)).map(({ label }) => label.toLowerCase());
      parts.push(`House: ${fmtSize(this.layout.footprint)}, ${plural(this.layout.rooms.length, "room")}. Built: ${done.length > 0 ? list(done) : "nothing yet"}.`);
    } else if (this.request) {
      parts.push("House: being specified.");
    } else {
      parts.push("House: not started.");
    }
    return reply(`${lead ? `${lead}\n` : ""}${parts.join(" ")}`, "info", this.layout ? this.nextChoices(exists) : this.helpChoices());
  }

  private reset(): ArchitectReply {
    this.houseWallMaterial = null;
    this.request = null;
    this.layout = null;
    this.location = null;
    this.refs = null;
    this.built.clear();
    this.furnished.clear();
    return reply("Starting a new design. Everything already built stays as it is (and stays editable). Where should the next house go?", "question", this.locationChoices());
  }

  private emit(): void {
    const state = this.getState();
    for (const listener of this.listeners) listener(state);
  }

  /** Re-reads the model and notifies listeners - call after an undo/redo or an edit made outside the conversation. */
  refresh(): void {
    this.emit();
  }
}
