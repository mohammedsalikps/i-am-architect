// Explicit .ts extensions on value imports let Node run this file directly. Harmless for Vite.
import { endpointsOf, horizontalDistance, runBetween } from "../connections/connections.ts";
import { getElementKind } from "../elements/catalog.ts";
import { pipeOutsideDiameter, pipeSizesFor } from "../plumbing/upvcSheet.ts";
import type { Endpoint } from "../elements/types";
import type { PipeSize, PlumbingSystem } from "../plumbing/upvcSheet";

/**
 * "Run a 25 mm water pipe from 0, 0 to 3, 0 to 3, 2" - a pipe run by
 * conversation: one straight pipe per leg, each the sheet's real outside
 * diameter, all joined end to end, as ONE undoable batch. A run that
 * starts or ends exactly on an existing pipe end of the same system joins
 * it, which is how tees and reducers are made by voice. The fittings are
 * not built - they are worked out from the joints (plumbing/fittings.ts).
 *
 * Nothing is guessed: a size the uPVC sheet doesn't have is asked about,
 * and a run needs at least two points. Pipes are level (the model has no
 * risers yet), at the system's default height unless one is said.
 */

export interface PipeRunRequest {
  kind: "water-pipe" | "drain-pipe";
  system: PlumbingSystem;
  /** The sheet size to use - null when a size was said that the sheet doesn't have. */
  size: PipeSize | null;
  /** The nominal size said, in mm, if any. */
  requested: number | null;
  points: { x: number; z: number }[];
  /** A centreline height said, metres. */
  height: number | null;
  /** "hot" or "cold" said of this run's own pipe ("a 25 mm hot water pipe"), or null: it then continues the pipe it joins, else cold. */
  temperature: "hot" | "cold" | null;
}

const DRAIN_WORD = /\b(?:drain(?:age)?|waste|sanitation|sanitary|sewer|soil|foul)\b/i;
const NUMBER = String.raw`(-?\d+(?:\.\d+)?)`;
/** A point after from/to/then/via: "from 0, 0", "to (3, 2)", "then 3 2". */
const POINT = new RegExp(String.raw`\b(?:from|to|then|via|through)\s+\(?\s*${NUMBER}\s*(?:,\s*|\s+)${NUMBER}\s*\)?`, "gi");
const SIZE = /(\d+(?:\.\d+)?)\s*(?:mm|millimet(?:er|re)s?)\b/i;
const HEIGHT = new RegExp(String.raw`\b(?:at\s+(?:a\s+)?height\s+of\s+${NUMBER}\s*m\b|${NUMBER}\s*m(?:et(?:er|re)s?)?\s+(?:high|above\s+(?:the\s+)?(?:floor|ground)))`, "i");

const PIPE_NOUN = String.raw`(?:pipes?|pipework|pipe\s*run|pipeline)\b`;
/**
 * A word describing the NEW pipe between its verb and its noun ("a 25 mm hot water", "2", "another 25-mm").
 * Not "the"/"it" (a pipe that's there), a preposition, or a wall, room or house - a pipe only mentioned
 * beside something else ("add a wall next to the water pipe", "a bathroom with a drain pipe").
 */
const MODIFIER = String.raw`(?!(?:the|this|that|these|those|it|its|my|our|your|their|with|to|from|at|into|onto|next|beside|for|of|by|and|or|near|along|behind|under|over|walls?|rooms?|kitchen|bathroom|bedroom|house)\b)[\w.'-]+`;
/**
 * A build verb whose object is a new pipe: "run a 25 mm water pipe", "put in a drain pipe", "add 2 water pipes",
 * "I need a 20 mm pipe", "now run the hot water pipe" (run/lay/install/route may say "the").
 */
const BUILD_PIPE = new RegExp(
  String.raw`\b(?:(?:run|lay|install|route)\s+(?:the\s+)?|(?:add|put|fit|place|create|build|draw|need|want|like)\s+(?:(?:in|on|down)\s+)?)` +
    String.raw`(?:${MODIFIER}[\s,]+){0,6}?` +
    PIPE_NOUN,
  "i"
);
/** A sentence that starts with the pipe itself: "Pipe from 0, 0 to 3, 0", "Water pipe, 25 mm, from…", "A 110 mm drain pipe from…". */
const PIPE_FIRST = new RegExp(
  String.raw`^\s*(?:(?:a|an|another|new|one|\d+(?:\.\d+)?\s*(?:mm|millimet(?:er|re)s?)|\d+(?:\.\d+)?|water|drain(?:age)?|waste|soil|sanitation|sewer|clean|cold|hot|upvc|pvc|main|branch|supply)[\s,]+){0,5}?` + PIPE_NOUN,
  "i"
);
/** "The pipes from … are leaking": a pipe-first sentence that states something isn't a request. */
const STATEMENT = /\b(?:is|are|was|were|isn'?t|aren'?t|has|have|had)\b/i;
/** A question, not a request: "how long is…", "do I need to lay…", "should I run…", "would it be better to…" ("could you lay…" is a request). */
const QUESTION = /^\s*(?:(?:how|what|why|where|when|which|who|whose|is|are|was|were|does|do|did|has|have|had|should)\b|shall\s+i\b|(?:would|could|can|will|may|might)\s+(?:it|that|this|there)\b)/i;
/** A build verb that's negated: "don't run…", "I didn't ask you to add…", "you shouldn't have run…" - not "…but don't connect it". */
const NEGATED = /\b(?:don'?t|do\s+not|didn'?t|did\s+not|doesn'?t|does\s+not|shouldn'?t|should\s+not|wouldn'?t|would\s+not|won'?t|will\s+not|can'?t|cannot|can\s+not|never|no\s+need\s+to)\b(?:\s+[\w']+){0,4}?\s+(?:run|lay|install|route|add|put|fit|place|create|build|draw|need|want|like)\b/i;

/** The words that name the run's own pipe - "Run a 25 mm hot water pipe" in "... beside the cold one" - or "". */
function pipePhrase(text: string): string {
  return (BUILD_PIPE.exec(text) ?? PIPE_FIRST.exec(text))?.[0] ?? "";
}

/** Whether `text` asks for a NEW pipe run: a build verb on a pipe (or the pipe first), at least two points, and not a question or a negation. */
export function isPipeRun(text: string): boolean {
  if ([...text.matchAll(POINT)].length < 2 || QUESTION.test(text) || NEGATED.test(text)) return false;
  return BUILD_PIPE.test(text) || (PIPE_FIRST.test(text) && !STATEMENT.test(text));
}

export function readPipeRun(text: string): PipeRunRequest {
  // The run's own words decide its system, size and hot/cold; the rest of the sentence may describe other pipes.
  const phrase = pipePhrase(text);
  const system: PlumbingSystem = DRAIN_WORD.test(phrase) ? "sanitation" : /\bwater\b/i.test(phrase) ? "clean-water" : DRAIN_WORD.test(text) ? "sanitation" : "clean-water";
  const kind = system === "clean-water" ? "water-pipe" : "drain-pipe";
  const sizes = pipeSizesFor(system);
  const said = SIZE.exec(phrase) ?? SIZE.exec(text);
  const requested = said ? Number(said[1]) : null;
  const size = requested === null ? sizes[0] : (sizes.find((entry) => entry.nominal === requested) ?? null);
  const points = [...text.matchAll(POINT)].map((match) => ({ x: Number(match[1]), z: Number(match[2]) }));
  const height = HEIGHT.exec(text);
  const temperature = kind !== "water-pipe" ? null : /\bhot\b/i.test(phrase) ? "hot" : /\bcold\b/i.test(phrase) ? "cold" : null;
  return { kind, system, size, requested, points, height: height ? Number(height[1] ?? height[2]) : null, temperature };
}

/** The sheet sizes for a system, for the question when a size isn't on the sheet: "25 mm (main), 20 mm (branch) and 15 mm (fixture)". */
export function sheetSizesText(system: PlumbingSystem): string {
  const sizes = pipeSizesFor(system).map((size) => `${size.nominal} mm (${size.role})`);
  return sizes.length > 1 ? `${sizes.slice(0, -1).join(", ")} and ${sizes[sizes.length - 1]}` : sizes[0];
}

/** An existing pipe the run's ends may join. */
export interface ExistingPipe {
  id: string;
  kind: string;
  position: { x: number; y: number; z: number };
  rotation: number;
  dimensions: Record<string, number>;
  /** A water pipe's System param ("cold" or "hot"); absent is cold. */
  system?: string;
}

/** How close (on plan) a run's first or last point must be to an existing pipe end to join it, metres. */
export const JOIN_REACH = 0.05;

export type PipeRunPlan =
  | {
      ok: true;
      commands: unknown[];
      /** The run's points as built - a joined end is moved onto the pipe end it joins. */
      points: { x: number; z: number }[];
      legs: number[];
      y: number;
      joins: { at: "start" | "end"; id: string; endpoint: Endpoint }[];
      /** The run ends where it started, and is joined there. */
      closed: boolean;
      /** The pipe the run's end joins, raised (+) or lowered (-) by `by` metres - with the pipes joined to it - to line up. */
      realigned: { id: string; by: number } | null;
      /** A water run's system as built: said, or continued from the pipe it joins; null is the default (cold). */
      temperature: "hot" | "cold" | null;
    }
  | { ok: false; reason: string };

/** The batch that builds `request` among `existing` pipes - adds, then the connections ($step:N refers to the n-th add). */
export function planPipeRun(request: PipeRunRequest, existing: readonly ExistingPipe[]): PipeRunPlan {
  if (!request.size) return { ok: false, reason: "no size" };
  const said = request.points;
  if (said.length < 2) return { ok: false, reason: "A pipe run needs at least two points, e.g. “from 0, 0 to 3, 0”." };
  if (said.length > 13) return { ok: false, reason: "That's more than 12 legs in one run - please build it in parts." };
  // A run of three or more legs that comes back to where it started is a closed loop, joined there.
  const closed = said.length >= 4 && horizontalDistance(said[0], said[said.length - 1]) <= JOIN_REACH;

  // Joining an existing pipe end of the same system at the first or last point.
  const ends = existing
    .filter((pipe) => pipe.kind === request.kind)
    .flatMap((pipe) => (["start", "end"] as const).map((endpoint) => ({ id: pipe.id, endpoint, point: endpointsOf(pipe)[endpoint], diameter: pipe.dimensions.diameter ?? 0, system: pipe.system ?? "cold" })));
  const nearest = (point: { x: number; z: number }) =>
    ends
      .map((end) => ({ ...end, distance: horizontalDistance(end.point, point) }))
      .filter((end) => end.distance <= JOIN_REACH)
      .sort((a, b) => a.distance - b.distance || a.id.localeCompare(b.id, undefined, { numeric: true }))[0];
  const startJoin = nearest(said[0]);
  const endJoin = closed ? undefined : nearest(said[said.length - 1]);

  // The points as built: a joined end sits exactly on the pipe end it joins, and a closed loop ends on its own start.
  const first = startJoin ? { x: startJoin.point.x, z: startJoin.point.z } : said[0];
  const points = said.map((point, index) =>
    index === 0 ? first : index < said.length - 1 ? point : closed ? first : endJoin ? { x: endJoin.point.x, z: endJoin.point.z } : point
  );
  const legs: number[] = [];
  for (let index = 1; index < points.length; index += 1) {
    const length = horizontalDistance(points[index - 1], points[index]);
    if (length < 0.05) return { ok: false, reason: `Leg ${index} (${fmtPoint(points[index - 1])} to ${fmtPoint(points[index])}) is shorter than 5 cm.` };
    legs.push(Math.round(length * 1000) / 1000);
  }

  // Hot and cold supplies are never joined: a water run continues the system of the pipe it joins, or is refused.
  let temperature = request.temperature;
  if (request.kind === "water-pipe") {
    if (startJoin && endJoin && startJoin.system !== endJoin.system) {
      return { ok: false, reason: `The run would join ${startJoin.id} (${startJoin.system} water) to ${endJoin.id} (${endJoin.system} water); hot and cold supplies are never joined.` };
    }
    const continued = (startJoin ?? endJoin)?.system as "hot" | "cold" | undefined;
    if (continued && temperature && temperature !== continued) {
      const other = (startJoin ?? endJoin)!.id;
      return { ok: false, reason: `${other} is a ${continued}-water pipe, but you asked for a ${temperature}-water run, and hot and cold supplies are never joined. Start the run away from ${other}, or say ${continued} water.` };
    }
    temperature = temperature ?? continued ?? null;
  }

  const diameter = pipeOutsideDiameter(request.size);
  const joined = startJoin ?? endJoin;
  if (joined && request.height !== null && Math.abs(joined.point.y - request.height) > 0.001) {
    return {
      ok: false,
      reason: `You asked for ${fmt(request.height)} m, but the run joins ${joined.id}, which is at ${fmt(joined.point.y)} m, and pipes in this model are level. Say the run without a height to join it at ${fmt(joined.point.y)} m, or start it away from ${joined.id}.`
    };
  }
  // Each sheet size sits at its own default height (its centreline is half its outside diameter up),
  // so a run between two sizes lines the far one up - by no more than that seating offset.
  let realigned: { id: string; by: number } | null = null;
  if (startJoin && endJoin && Math.abs(startJoin.point.y - endJoin.point.y) > 0.001) {
    const seating = Math.abs(startJoin.diameter - endJoin.diameter) / 2 + 0.001;
    const by = startJoin.point.y - endJoin.point.y;
    if (Math.abs(by) > seating) {
      return { ok: false, reason: `The run would join ${startJoin.id} and ${endJoin.id}, which are at different heights (${fmt(startJoin.point.y)} and ${fmt(endJoin.point.y)} m); pipes in this model are level.` };
    }
    realigned = { id: endJoin.id, by: Math.round(by * 10000) / 10000 };
  }
  const baseY = getElementKind(request.kind)?.baseY ?? 0;
  const y = joined?.point.y ?? request.height ?? Math.round((baseY + diameter / 2) * 10000) / 10000;

  const commands: unknown[] = [];
  for (let index = 1; index < points.length; index += 1) {
    const run = runBetween(points[index - 1], points[index], y);
    commands.push({
      type: "element.add",
      element: { kind: request.kind, position: run.position, rotation: run.rotation, dimensions: { length: run.length, diameter }, ...(temperature === "hot" ? { params: { system: "hot" } } : {}) }
    });
  }
  const legCount = points.length - 1;
  const joins: { at: "start" | "end"; id: string; endpoint: Endpoint }[] = [];
  if (startJoin) {
    commands.push({ type: "element.connect", from: { id: "$step:0", endpoint: "start" }, to: { id: startJoin.id, endpoint: startJoin.endpoint } });
    joins.push({ at: "start", id: startJoin.id, endpoint: startJoin.endpoint });
  }
  for (let index = 1; index < legCount; index += 1) {
    commands.push({ type: "element.connect", from: { id: `$step:${index}`, endpoint: "start" }, to: { id: `$step:${index - 1}`, endpoint: "end" } });
  }
  if (endJoin && !(startJoin && legCount === 1 && endJoin.id === startJoin.id)) {
    // Lining up: the existing pipe is the one connected FROM, so it (and its network) moves to the run's height.
    const last = { id: `$step:${legCount - 1}`, endpoint: "end" };
    const existingEnd = { id: endJoin.id, endpoint: endJoin.endpoint };
    commands.push(realigned ? { type: "element.connect", from: existingEnd, to: last } : { type: "element.connect", from: last, to: existingEnd });
    joins.push({ at: "end", id: endJoin.id, endpoint: endJoin.endpoint });
  }
  if (closed) {
    commands.push({ type: "element.connect", from: { id: `$step:${legCount - 1}`, endpoint: "end" }, to: { id: "$step:0", endpoint: "start" } });
  }
  return { ok: true, commands, points, legs, y, joins, closed, realigned, temperature };
}

function fmt(value: number): string {
  return String(Number(value.toFixed(3)));
}

export function fmtPoint(point: { x: number; z: number }): string {
  return `(${fmt(point.x)}, ${fmt(point.z)})`;
}
