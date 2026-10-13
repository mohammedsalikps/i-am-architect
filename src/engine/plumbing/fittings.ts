// Explicit .ts extensions on value imports let Node run this file directly
// (plumbing/verify.ts does). Harmless for Vite.
import { JOINT_TOLERANCE, endpointsOf, horizontalDistance } from "../connections/connections.ts";
import { findFitting, pipeOutsideDiameter, pipeSizeFor, systemOfKind } from "./upvcSheet.ts";
import { getMaterial } from "../materials/materialLibrary.ts";
import type { Endpoint } from "../elements/types";
import type { Point3 } from "../connections/connections";
import type { FittingSpec, FittingType, PipeSize, PlumbingSystem } from "./upvcSheet";

/**
 * The fittings a pipe network needs, worked out from the model itself:
 * every joint where connected pipe ends meet (connections.ts) is resolved
 * to the sheet part that fits it (upvcSheet.ts) - or to a plain-words
 * reason it can't be. Nothing here is stored: fittings are derived from
 * the pipes and their connections every time, so they follow every edit,
 * undo/redo and save/reopen exactly, and can never be duplicated or left
 * behind.
 *
 * Deterministic: each joint is found once (keyed by its sorted endpoint
 * list), members are ordered by id and endpoint, and every angle is
 * measured, never assumed. Two ends: a coupler or reducer when they run
 * straight on, an elbow when they turn by a sheet angle. Three ends: a tee
 * or Y only when two of them run straight through and the third branches
 * off at the part's angle - otherwise the joint is reported, not guessed.
 */

/** The fields resolution reads - a snapshot object or an ElementData both fit. */
export interface PipeLike {
  id: string;
  type: string;
  kind?: string;
  position: Point3;
  rotation: number;
  dimensions: Record<string, number>;
  /** Material id - only uPVC pipes take the sheet's fittings (see SHEET_MATERIALS). Absent: taken as uPVC. */
  material?: string;
  connections?: readonly { endpoint: Endpoint; objectId: string; objectEndpoint: Endpoint }[];
}

/**
 * Pipe materials the uPVC sheet's fittings are for. "pvc" is this library's
 * rigid PVC - PVC-U, the sheet's own material - so older projects' PVC drains
 * keep their fittings. CPVC, copper, HDPE, steel and the other plumbing and
 * metal materials are not on the sheet.
 */
export const SHEET_MATERIALS: ReadonlySet<string> = new Set(["upvc", "upvc-grey", "pvc"]);

/**
 * Whether a pipe of this material takes the sheet's fittings: uPVC or PVC -
 * or a finish (paint) or anything else that says nothing about what the pipe
 * is made of, which is taken as the uPVC it was laid in. Only another real
 * pipe material (a plumbing or metal one) takes it off the sheet.
 */
export function onSheetMaterial(material: string | undefined): boolean {
  if (material === undefined || SHEET_MATERIALS.has(material)) return true;
  const category = getMaterial(material)?.category;
  return category !== "plumbing" && category !== "metal";
}

export interface JointMember {
  id: string;
  endpoint: Endpoint;
  diameter: number;
  /** The pipe's material id, when known. */
  material?: string;
  /** The sheet size this pipe is, or null for a custom size (or a material the sheet doesn't cover). */
  size: PipeSize | null;
  /** Unit vector from the joint along this pipe, on the plan (pipes are level). */
  direction: { x: number; z: number };
}

export interface ResolvedJoint {
  /** "joint:<id>:<endpoint>+..." over the sorted members - stable across edits that don't change the joint. */
  id: string;
  system: PlumbingSystem;
  point: Point3;
  members: JointMember[];
  /** Two ends: the turn between them (0 = straight on). Three ends: the branch's angle off the run. Degrees, 0.1 precision. */
  angle: number | null;
  fitting: FittingSpec | null;
  /** For a resolved joint: which member is the branch (tees and Ys). */
  branch: number | null;
  /** Why no sheet part fits - null when one does. */
  problem: string | null;
  /** Something true about the fitting the user should know (an 87.5° bend on a 90° plan corner). */
  note: string | null;
}

/** Angles within this many degrees of a part's angle are that part. */
export const ANGLE_TOLERANCE = 2;

const PLUMBING_KINDS = new Set(["water-pipe", "drain-pipe"]);

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function degreesBetween(a: { x: number; z: number }, b: { x: number; z: number }): number {
  const dot = Math.max(-1, Math.min(1, a.x * b.x + a.z * b.z));
  return (Math.acos(dot) * 180) / Math.PI;
}

/** Every endpoint joined to `seed`, following connections transitively (as connections.jointMembers, for any PipeLike). */
function jointOf(byId: ReadonlyMap<string, PipeLike>, seed: { id: string; endpoint: Endpoint }): { id: string; endpoint: Endpoint }[] {
  const found = [seed];
  const seen = new Set([`${seed.id}:${seed.endpoint}`]);
  for (let index = 0; index < found.length; index += 1) {
    const current = found[index];
    for (const connection of byId.get(current.id)?.connections ?? []) {
      if (connection.endpoint !== current.endpoint) continue;
      const key = `${connection.objectId}:${connection.objectEndpoint}`;
      if (!seen.has(key) && byId.has(connection.objectId)) {
        seen.add(key);
        found.push({ id: connection.objectId, endpoint: connection.objectEndpoint });
      }
    }
  }
  return found;
}

const SIZE_NAME = (member: JointMember, system: PlumbingSystem) =>
  member.size ? `${member.size.nominal} mm` : `a custom ${Math.round(member.diameter * 1000 * 10) / 10} mm-OD ${system === "clean-water" ? "water" : "drain"} pipe`;

/** Resolve one joint's members (already validated as meeting at `point`). */
function classify(system: PlumbingSystem, members: JointMember[]): Pick<ResolvedJoint, "angle" | "fitting" | "branch" | "problem" | "note"> {
  const none = { fitting: null, branch: null, note: null };
  const custom = members.find((member) => !member.size);
  if (members.length === 2) {
    const turn = round1(180 - degreesBetween(members[0].direction, members[1].direction));
    if (custom) return { ...none, angle: turn, problem: `It joins ${SIZE_NAME(custom, system)}; the sheet has no parts for that size.` };
    const [a, b] = members.map((member) => member.size!.nominal);
    const sizes = a === b ? [a] : [Math.max(a, b), Math.min(a, b)];
    if (turn <= ANGLE_TOLERANCE) {
      const type: FittingType = a === b ? "coupler" : "reducer";
      const fitting = findFitting(system, type, sizes);
      return fitting
        ? { ...none, angle: turn, fitting, problem: null }
        : { ...none, angle: turn, problem: `The sheet has no ${a === b ? `${a} mm coupler` : `${sizes[0]} × ${sizes[1]} mm reducer`}.` };
    }
    if (a !== b) return { ...none, angle: turn, problem: `${sizes[0]} and ${sizes[1]} mm pipes turn ${turn}° here; the sheet has no reducing elbow.` };
    const elbows: { type: FittingType; angle: number; accept: (angle: number) => boolean }[] =
      system === "clean-water"
        ? [
            { type: "elbow-90", angle: 90, accept: (angle) => Math.abs(angle - 90) <= ANGLE_TOLERANCE },
            { type: "elbow-45", angle: 45, accept: (angle) => Math.abs(angle - 45) <= ANGLE_TOLERANCE }
          ]
        : [
            // A drain's 87.5° bend serves a 90° plan corner: the 2.5° is taken up by the drain's fall.
            { type: "elbow-87.5", angle: 87.5, accept: (angle) => angle >= 87.5 - ANGLE_TOLERANCE && angle <= 90 + ANGLE_TOLERANCE },
            { type: "elbow-45", angle: 45, accept: (angle) => Math.abs(angle - 45) <= ANGLE_TOLERANCE }
          ];
    const elbow = elbows.find((entry) => entry.accept(turn));
    if (!elbow) {
      const offered = system === "clean-water" ? "90° and 45° elbows" : "87.5° and 45° elbows";
      return { ...none, angle: turn, problem: `The pipes turn ${turn}° here; the sheet has ${offered} only.` };
    }
    const fitting = findFitting(system, elbow.type, sizes);
    if (!fitting) return { ...none, angle: turn, problem: `The sheet has no ${a} mm ${elbow.angle}° elbow.` };
    const note =
      elbow.type === "elbow-87.5" && Math.abs(turn - 87.5) > 0.5
        ? `The pipes meet at ${turn}° on plan; an 87.5° bend is used - its 2.5° is normally taken up by the drain's fall, which this model doesn't draw (pipes are level).`
        : null;
    return { fitting, angle: turn, branch: null, problem: null, note };
  }

  if (members.length === 3) {
    // The run: the one pair that goes straight through.
    const runs: [number, number][] = [];
    for (let i = 0; i < 3; i += 1) {
      for (let j = i + 1; j < 3; j += 1) {
        if (180 - degreesBetween(members[i].direction, members[j].direction) <= ANGLE_TOLERANCE) runs.push([i, j]);
      }
    }
    if (runs.length !== 1) {
      return { ...none, angle: null, problem: runs.length === 0 ? "Three pipes meet here but no two of them run straight through - not a tee or a Y." : "Three pipes meet here in an ambiguous arrangement (more than one straight run)." };
    }
    const [i, j] = runs[0];
    const k = [0, 1, 2].find((index) => index !== i && index !== j)!;
    const off = degreesBetween(members[k].direction, members[i].direction);
    const angle = round1(Math.min(off, 180 - off));
    if (custom) return { ...none, angle, problem: `It joins ${SIZE_NAME(custom, system)}; the sheet has no parts for that size.` };
    const run = members[i].size!.nominal;
    if (members[j].size!.nominal !== run) return { ...none, angle, problem: `The run changes size here (${run} and ${members[j].size!.nominal} mm); the sheet has no such tee.` };
    const branchSize = members[k].size!.nominal;
    if (branchSize > run) return { ...none, angle, problem: `The branch (${branchSize} mm) is larger than the run (${run} mm); the sheet has no such tee.` };
    const sizes = branchSize === run ? [run] : [run, branchSize];
    let type: FittingType | null = null;
    if (Math.abs(angle - 90) <= ANGLE_TOLERANCE) type = branchSize === run ? "tee" : "reducing-tee";
    else if (Math.abs(angle - 45) <= ANGLE_TOLERANCE) type = system === "sanitation" && branchSize === run ? "single-y" : null;
    if (!type) {
      const offered = system === "clean-water" ? "90° tees" : "90° tees and a 45° single Y";
      return { ...none, angle, problem: `The branch leaves the run at ${angle}°${Math.abs(angle - 45) <= ANGLE_TOLERANCE ? ` with these sizes` : ""}; the sheet has ${offered} only.` };
    }
    const fitting = findFitting(system, type, sizes);
    if (!fitting) return { ...none, angle, problem: `The sheet has no ${sizes.join(" × ")} mm ${type === "single-y" ? "single Y" : type === "tee" ? "tee" : "reducing tee"}.` };
    return { fitting, angle, branch: k, problem: null, note: null };
  }

  return { ...none, angle: null, problem: `${members.length} pipes meet at one point; the sheet has no fitting for that.` };
}

/**
 * Every joint in the model's water and drain pipes, each once, with the
 * sheet part that fits it or why none does. Joints of one pipe end alone
 * (open ends) aren't joints. Sorted by id.
 */
export function resolveJoints(objects: readonly PipeLike[]): ResolvedJoint[] {
  const pipes = objects.filter((object) => object.type === "element" && object.kind !== undefined && PLUMBING_KINDS.has(object.kind));
  const byId = new Map(pipes.map((pipe) => [pipe.id, pipe]));
  const seen = new Set<string>();
  const joints: ResolvedJoint[] = [];
  for (const pipe of pipes) {
    for (const endpoint of ["start", "end"] as const) {
      if (!(pipe.connections ?? []).some((connection) => connection.endpoint === endpoint)) continue;
      const refs = jointOf(byId, { id: pipe.id, endpoint })
        .slice()
        .sort((a, b) => (a.id === b.id ? a.endpoint.localeCompare(b.endpoint) : a.id.localeCompare(b.id, undefined, { numeric: true })));
      const id = `joint:${refs.map((ref) => `${ref.id}:${ref.endpoint}`).join("+")}`;
      if (seen.has(id)) continue;
      seen.add(id);
      for (const ref of refs) seen.add(`${ref.id}:${ref.endpoint}`);

      // A joint of pipes the sheet doesn't cover (CPVC, copper...) gets no sheet fitting and no flag:
      // it's outside this sheet, as it was before fittings were worked out.
      const offSheet = refs.map((ref) => byId.get(ref.id)!).filter((member) => !onSheetMaterial(member.material));
      if (offSheet.length === refs.length) continue;

      const point = endpointsOf(byId.get(refs[0].id)!)[refs[0].endpoint];
      const system = systemOfKind(byId.get(refs[0].id)!.kind!)!;
      const members: JointMember[] = [];
      let problem: string | null =
        offSheet.length > 0 ? `It joins uPVC to ${[...new Set(offSheet.map((member) => member.material!))].sort().join(" and ")} pipe; the uPVC sheet has no adaptor for that.` : null;
      for (const ref of refs) {
        const member = byId.get(ref.id)!;
        if (member.kind !== byId.get(refs[0].id)!.kind) problem ??= `A ${member.kind} is joined to a ${byId.get(refs[0].id)!.kind} here.`;
        const ends = endpointsOf(member);
        const here = ends[ref.endpoint];
        const there = ends[ref.endpoint === "start" ? "end" : "start"];
        if (horizontalDistance(here, point) > JOINT_TOLERANCE || Math.abs(here.y - point.y) > JOINT_TOLERANCE) problem ??= `${member.id}'s ${ref.endpoint} doesn't meet the joint.`;
        const length = horizontalDistance(here, there);
        if (length < 1e-6) problem ??= `${member.id} has no length.`;
        const diameter = member.dimensions.diameter ?? 0;
        members.push({
          id: member.id,
          endpoint: ref.endpoint,
          diameter,
          ...(member.material === undefined ? {} : { material: member.material }),
          size: onSheetMaterial(member.material) ? pipeSizeFor(member.kind!, diameter) : null,
          direction: length < 1e-6 ? { x: 0, z: 0 } : { x: (there.x - here.x) / length, z: (there.z - here.z) / length }
        });
      }
      const resolved = problem ? { angle: null, fitting: null, branch: null, problem, note: null } : classify(system, members);
      joints.push({ id, system, point, members, ...resolved });
    }
  }
  return joints.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
}

/** The pipe size a member is drawn with, falling back to its own diameter for a custom size. */
export function memberOutsideDiameter(member: JointMember): number {
  return member.size ? pipeOutsideDiameter(member.size) : member.diameter;
}
