// Explicit .ts extensions on value imports let Node run this file directly. Harmless for Vite.
import { PIPE_SIZES, fullSizeMetres } from "./upvcSheet.ts";
import type { Point3 } from "../connections/connections";
import type { FittingSpec, PipeSize, PlumbingSystem } from "./upvcSheet";
import type { ResolvedJoint } from "./fittings";

/**
 * The shape of a resolved fitting, full size, as plain parts the scene
 * turns into meshes (scene/elements/FittingLayer.ts): for each port a
 * socket hub (the bore plus the fitting's wall, the socket's depth long)
 * and a body back to the joint, plus a ball at the centre of bends and
 * branches. Everything is computed from the sheet's kit values times the
 * kit scale - never a kit value used as a real size.
 *
 * Port lengths (joint centre to socket mouth) come from the sheet's
 * overall dimensions where the drawing defines them; where it doesn't,
 * the rule used is stated next to the number (see centreToEnd()).
 */

export type FittingPart =
  /** `member`: the index (in joint.members) of the port this part belongs to. */
  | { shape: "cylinder"; from: Point3; to: Point3; radius: number; role: "hub" | "body" | "band"; member: number }
  | { shape: "sphere"; center: Point3; radius: number; role: "body" };

export interface FittingGeometry {
  parts: FittingPart[];
  /** Joint centre to each port's socket mouth, metres, in member order. */
  centreToEnd: number[];
}

function sizeOf(system: PlumbingSystem, nominal: number): PipeSize {
  return PIPE_SIZES.find((size) => size.system === system && size.nominal === nominal)!;
}

/** The fitting's wall at a port, full size (m). Clean water: the sheet's fitting WALL; sanitation: the pipe's true wall (the sheet gives only the kit wall). */
function wallAt(fitting: FittingSpec, nominal: number): number {
  if (fitting.system === "clean-water") {
    const isSmall = fitting.sizes.length > 1 && nominal === fitting.sizes[1];
    const kitWall = fitting.kit.wall ?? (isSmall ? fitting.kit.wallSmall : fitting.kit.wallLarge);
    return fullSizeMetres(kitWall, "clean-water");
  }
  return fullSizeMetres(sizeOf("sanitation", 110).kit.trueWall, "sanitation");
}

function hubRadius(fitting: FittingSpec, nominal: number): number {
  return fullSizeMetres(sizeOf(fitting.system, nominal).kit.socketBore, fitting.system) / 2 + wallAt(fitting, nominal);
}

/**
 * The 110 mm sanitation socket's outer radius AS DRAWN on the sheet (its
 * printed socket OD, with the 1.00 mm kit wall) - what a printed outer extent
 * (W, H) is measured to. Not hubRadius(), whose wall is the scaled true wall.
 */
function drawnSanitationHubRadius(): number {
  return fullSizeMetres(sizeOf("sanitation", 110).kit.socketOd!, "sanitation") / 2;
}

function socketDepth(fitting: FittingSpec, nominal: number): number {
  return fullSizeMetres(sizeOf(fitting.system, nominal).kit.socketDepth, fitting.system);
}

/** A bend of the same centreline radius as the 90° (or 87.5°) one, at `angle`: its centre-to-socket-bottom is R·tan(angle/2). */
function bendFrom(reference: { centreToEnd: number; depth: number; angle: number }, angle: number): number {
  const radius = (reference.centreToEnd - reference.depth) / Math.tan(((reference.angle / 2) * Math.PI) / 180);
  return reference.depth + radius * Math.tan(((angle / 2) * Math.PI) / 180);
}

/**
 * Joint centre to socket mouth for each port, metres - `nominals` in
 * member order, `branch` the branch member for tees and Ys.
 */
export function centreToEnd(fitting: FittingSpec, nominals: readonly number[], branch: number | null): number[] {
  const s = fitting.system;
  const full = (kit: number) => fullSizeMetres(kit, s);
  const k = fitting.kit;
  switch (fitting.id) {
    case "cw-coupler-25": // H = overall length
      return nominals.map(() => full(k.H) / 2);
    case "cw-elbow-90-25": // H = centre-to-end + hub radius (one leg's outer extent)
      return nominals.map((n) => full(k.H) - hubRadius(fitting, n));
    case "cw-elbow-45-25": {
      // The sheet's H for the 45° elbow depends on the drawing's reference points; drawn with the 90° elbow's bend radius instead.
      const ninety = full(13.5) - hubRadius(fitting, 25);
      return nominals.map((n) => bendFrom({ centreToEnd: ninety, depth: socketDepth(fitting, n), angle: 90 }, 45));
    }
    case "cw-tee-25": // H = run length, H1 = branch centre-to-end + hub radius
    case "cw-reducing-tee-25x20":
      return nominals.map((n, index) => (index === branch ? full(k.H1) - hubRadius(fitting, n) : full(k.H) / 2));
    case "cw-reducer-25x20": {
      // H = overall length: both sockets plus a transition, split evenly between the two sides.
      const transition = full(k.H) - socketDepth(fitting, 25) - socketDepth(fitting, 20);
      return nominals.map((n) => socketDepth(fitting, n) + transition / 2);
    }
    case "san-coupler-110": // L = overall length
      return nominals.map(() => full(k.L) / 2);
    case "san-elbow-87.5-110": {
      // W and H are the two legs' outer extents, to the drawn socket's outside; drawn with their mean.
      const leg = (full(k.W) + full(k.H)) / 2 - drawnSanitationHubRadius();
      return nominals.map(() => leg);
    }
    case "san-elbow-45-110": {
      // W/H of the 45° elbow depend on the drawing's reference points; drawn with the 87.5° elbow's bend radius instead.
      const eightySeven = (full(19.6) + full(19.8)) / 2 - drawnSanitationHubRadius();
      return nominals.map(() => bendFrom({ centreToEnd: eightySeven, depth: socketDepth(fitting, 110), angle: 87.5 }, 45));
    }
    case "san-tee-110": // L = run length; the branch's a/b aren't defined on the sheet - drawn as long as the run's half
      return nominals.map(() => full(k.L) / 2);
    case "san-y-110": // L = run length; a = the branch's length from the run axis
      return nominals.map((_, index) => (index === branch ? full(k.a) : full(k.L) / 2));
    case "san-reducer-110x75": {
      // No overall length on the sheet: drawn with the 110 mm coupler's centre gap beyond each socket.
      const gap = full(14.5) / 2 - socketDepth(fitting, 110);
      return nominals.map((n) => socketDepth(fitting, n) + gap);
    }
    case "san-reducing-tee-110x75": {
      // L = run length; the branch (a/b unclear on the sheet) gets the run's centre gap beyond its own socket.
      const gap = full(k.L) / 2 - socketDepth(fitting, 110);
      return nominals.map((n, index) => (index === branch ? socketDepth(fitting, n) + gap : full(k.L) / 2));
    }
    default:
      return nominals.map((n) => socketDepth(fitting, n) * 1.2);
  }
}

const at = (point: Point3, direction: { x: number; z: number }, distance: number): Point3 => ({
  x: point.x + direction.x * distance,
  y: point.y,
  z: point.z + direction.z * distance
});

/** The parts of a resolved joint's fitting, or null when the joint has no fitting. */
export function fittingGeometry(joint: ResolvedJoint): FittingGeometry | null {
  const fitting = joint.fitting;
  if (!fitting) return null;
  const nominals = joint.members.map((member) => member.size!.nominal);
  const lengths = centreToEnd(fitting, nominals, joint.branch);
  const parts: FittingPart[] = [];
  joint.members.forEach((member, index) => {
    const nominal = nominals[index];
    const depth = socketDepth(fitting, nominal);
    const mouth = lengths[index];
    const hubR = hubRadius(fitting, nominal);
    const bodyR = fullSizeMetres(sizeOf(fitting.system, nominal).kit.od, fitting.system) / 2 + wallAt(fitting, nominal);
    const socketBottom = Math.max(0, mouth - depth);
    if (socketBottom > 0) parts.push({ shape: "cylinder", from: joint.point, to: at(joint.point, member.direction, socketBottom), radius: bodyR, role: "body", member: index });
    parts.push({ shape: "cylinder", from: at(joint.point, member.direction, socketBottom), to: at(joint.point, member.direction, mouth), radius: hubR, role: "hub", member: index });
    if (fitting.system === "clean-water") {
      // The sheet's blue identification band, part-way along each socket.
      const bandAt = socketBottom + depth * 0.55;
      parts.push({ shape: "cylinder", from: at(joint.point, member.direction, bandAt), to: at(joint.point, member.direction, bandAt + depth * 0.12), radius: hubR * 1.012, role: "band", member: index });
    }
  });
  if (fitting.type !== "coupler" && fitting.type !== "reducer") {
    const radius = Math.max(...joint.members.map((member) => fullSizeMetres(sizeOf(fitting.system, member.size!.nominal).kit.od, fitting.system) / 2 + wallAt(fitting, member.size!.nominal)));
    parts.push({ shape: "sphere", center: joint.point, radius, role: "body" });
  }
  return { parts, centreToEnd: lengths };
}

/** Distance from `point` to the surface of a capped cylinder part (0 on it). */
function distanceToCylinder(part: Extract<FittingPart, { shape: "cylinder" }>, point: Point3): number {
  const axis = { x: part.to.x - part.from.x, y: part.to.y - part.from.y, z: part.to.z - part.from.z };
  const length = Math.hypot(axis.x, axis.y, axis.z);
  if (length < 1e-9) return Infinity;
  const unit = { x: axis.x / length, y: axis.y / length, z: axis.z / length };
  const w = { x: point.x - part.from.x, y: point.y - part.from.y, z: point.z - part.from.z };
  const along = w.x * unit.x + w.y * unit.y + w.z * unit.z;
  const radial = Math.hypot(w.x - unit.x * along, w.y - unit.y * along, w.z - unit.z * along) - part.radius;
  const beyond = along < 0 ? -along : along > length ? along - length : 0;
  if (beyond === 0) return Math.abs(radial);
  return radial <= 0 ? beyond : Math.hypot(radial, beyond);
}

/**
 * The pipe a click on a fitting at `point` means, among its VISIBLE pipes
 * (never a hidden one): the one owning the drawn part - body, hub or band -
 * whose surface the point is on. That follows each port's own radius and
 * length, so reducing tees and Ys (legs of different sizes) pick right.
 * With no geometry (an unresolved marker), the pipe leaving in the click's
 * direction.
 */
export function memberAtPoint(joint: ResolvedJoint, geometry: FittingGeometry | null, hidden: ReadonlySet<string>, point: Point3): string {
  let best: string | null = null;
  let bestScore = Infinity;
  const consider = (id: string, score: number): void => {
    if (!hidden.has(id) && score < bestScore - 1e-9) {
      best = id;
      bestScore = score;
    }
  };
  if (geometry) {
    for (const part of geometry.parts) {
      if (part.shape === "cylinder") consider(joint.members[part.member].id, distanceToCylinder(part, point));
    }
  } else {
    const dx = point.x - joint.point.x;
    const dz = point.z - joint.point.z;
    for (const member of joint.members) consider(member.id, -(dx * member.direction.x + dz * member.direction.z));
  }
  return best ?? joint.members[0].id;
}
