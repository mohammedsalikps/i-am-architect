import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { resolveJoints, memberOutsideDiameter } from "../../engine/plumbing/fittings";
import { fittingGeometry, memberAtPoint } from "../../engine/plumbing/fittingGeometry";
import { getMaterial } from "../../engine/materials/materialLibrary";
import type { ElementStore } from "../../engine/elements/ElementStore";
import type { FittingPart } from "../../engine/plumbing/fittingGeometry";
import type { ResolvedJoint } from "../../engine/plumbing/fittings";
import type { VisibilityStore } from "../visibility/VisibilityStore";

/** The sheet's blue identification band on clean-water fittings. */
const BAND_COLOR = 0x1f6fd0;
/** A joint with no sheet part is marked, never silently drawn as something it isn't. */
const UNRESOLVED_COLOR = 0xe8590c;
/** Small parts (the clean-water sizes) are below the sun's shadow-map resolution; they don't cast shadows. */
const SHADOW_MIN_DIAMETER = 0.05;

function cylinder(part: Extract<FittingPart, { shape: "cylinder" }>): THREE.BufferGeometry | null {
  const from = new THREE.Vector3(part.from.x, part.from.y, part.from.z);
  const to = new THREE.Vector3(part.to.x, part.to.y, part.to.z);
  const length = from.distanceTo(to);
  if (length < 1e-6) return null;
  const geometry = new THREE.CylinderGeometry(part.radius, part.radius, length, 24, 1, false);
  geometry.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), to.clone().sub(from).normalize()));
  geometry.translate((from.x + to.x) / 2, (from.y + to.y) / 2, (from.z + to.z) / 2);
  return geometry;
}

function partGeometry(part: FittingPart): THREE.BufferGeometry | null {
  if (part.shape === "cylinder") return cylinder(part);
  const geometry = new THREE.SphereGeometry(part.radius, 24, 16);
  geometry.translate(part.center.x, part.center.y, part.center.z);
  return geometry;
}

function merged(parts: readonly FittingPart[]): THREE.BufferGeometry | null {
  const pieces = parts.map(partGeometry).filter((geometry): geometry is THREE.BufferGeometry => geometry !== null);
  if (pieces.length === 0) return null;
  const geometry = mergeGeometries(pieces, false);
  for (const piece of pieces) piece.dispose();
  return geometry;
}

const round = (value: number): number => Math.round(value * 1e5) / 1e5;

/** Everything a joint's drawing depends on - the same signature means the same meshes, so they're kept. */
function signature(joint: ResolvedJoint): string {
  return JSON.stringify([
    joint.id,
    joint.system,
    joint.fitting?.id ?? null,
    joint.branch,
    round(joint.point.x),
    round(joint.point.y),
    round(joint.point.z),
    joint.members.map((member) => [member.diameter, member.size?.id ?? null, round(member.direction.x), round(member.direction.z)])
  ]);
}

interface FittingEntry {
  mesh: THREE.Mesh;
  members: string[];
}

/**
 * The pipe fittings in the 3D view - worked out from the pipes and their
 * connections (engine/plumbing/fittings.ts) every time the element store
 * changes, so they follow edits, drags, undo/redo and reopened projects,
 * and are never stored. One mesh per fitting (merged parts, its own
 * material) plus the clean-water band; a joint with no sheet part gets an
 * orange marker instead.
 *
 * Rebuilds are coalesced to one per microtask: a single command (a
 * connect, a joined move, an undo, opening a project) writes the store
 * several times, and the half-done states in between are never drawn.
 * getMeshes() runs a pending rebuild first, so a fit or highlight straight
 * after a command (opening a project) never sees the previous fittings.
 * Only joints whose drawing changed are rebuilt - dragging a chair, or one
 * pipe of many, leaves every other fitting's meshes (and any highlight
 * tint on them) as they were; a rebuilt fitting starts untinted, as a new
 * element does.
 *
 * A click on a fitting selects the visible member pipe whose leg it's on
 * (userData.pickObjectId; SelectionRaycaster). Each mesh also carries its
 * first pipe's id (userData.objectId), so the Construction Method
 * highlight and Fit/Focus treat it with its pipes. A fitting shows while
 * any of its pipes is visible.
 */
export class FittingLayer {
  private readonly root = new THREE.Group();
  /** Meshes by joint signature. */
  private entries = new Map<string, FittingEntry[]>();
  private hidden: ReadonlySet<string> = new Set();
  private queued = false;

  constructor(
    scene: THREE.Scene,
    private readonly elementStore: ElementStore,
    visibilityStore: VisibilityStore
  ) {
    this.root.name = "pipe-fittings";
    scene.add(this.root);
    elementStore.subscribe(() => this.schedule());
    visibilityStore.subscribe((hidden) => {
      this.hidden = hidden;
      this.applyVisibility();
    });
  }

  /** Visible fitting meshes - for picking, highlight and framing. Up to date with the element store. */
  getMeshes(): THREE.Object3D[] {
    this.flush();
    return [...this.entries.values()].flat().filter((entry) => entry.mesh.visible).map((entry) => entry.mesh);
  }

  private schedule(): void {
    if (this.queued) return;
    this.queued = true;
    queueMicrotask(() => this.flush());
  }

  private flush(): void {
    if (!this.queued) return;
    this.queued = false;
    this.sync();
  }

  private dispose(entries: readonly FittingEntry[]): void {
    for (const entry of entries) {
      this.root.remove(entry.mesh);
      entry.mesh.geometry.dispose();
      (entry.mesh.material as THREE.Material).dispose();
    }
  }

  private sync(): void {
    const next = new Map<string, FittingEntry[]>();
    for (const joint of resolveJoints(this.elementStore.getAll())) {
      const key = signature(joint);
      const kept = this.entries.get(key);
      if (kept) {
        this.entries.delete(key);
        next.set(key, kept);
      } else {
        next.set(key, this.build(joint));
      }
    }
    for (const gone of this.entries.values()) this.dispose(gone);
    this.entries = next;
    this.applyVisibility();
  }

  private build(joint: ResolvedJoint): FittingEntry[] {
    const members = joint.members.map((member) => member.id);
    const geometry = fittingGeometry(joint);
    const built: FittingEntry[] = [];
    const add = (mesh: THREE.Mesh): void => {
      mesh.userData.objectId = members[0];
      mesh.userData.fittingId = joint.id;
      mesh.userData.memberIds = members;
      mesh.userData.pickObjectId = (point: THREE.Vector3) => memberAtPoint(joint, geometry, this.hidden, point);
      this.root.add(mesh);
      built.push({ mesh, members });
    };
    const largest = Math.max(...joint.members.map(memberOutsideDiameter));
    const shadows = largest >= SHADOW_MIN_DIAMETER;
    if (geometry) {
      const library = getMaterial(joint.system === "clean-water" ? "upvc" : "upvc-grey");
      const bodyGeometry = merged(geometry.parts.filter((part) => part.role !== "band"));
      if (bodyGeometry) {
        const body = new THREE.Mesh(bodyGeometry, new THREE.MeshStandardMaterial({ color: library?.color ?? "#f2f2ee", roughness: library?.roughness ?? 0.5, metalness: 0 }));
        body.castShadow = shadows;
        body.receiveShadow = true;
        add(body);
      }
      const bandGeometry = merged(geometry.parts.filter((part) => part.role === "band"));
      if (bandGeometry) {
        const band = new THREE.Mesh(bandGeometry, new THREE.MeshStandardMaterial({ color: BAND_COLOR, roughness: 0.4, metalness: 0 }));
        band.receiveShadow = true;
        add(band);
      }
    } else {
      const marker = new THREE.Mesh(
        new THREE.SphereGeometry(Math.max(0.04, largest * 0.9), 20, 14),
        new THREE.MeshStandardMaterial({ color: UNRESOLVED_COLOR, transparent: true, opacity: 0.55, depthWrite: false, roughness: 0.6 })
      );
      marker.position.set(joint.point.x, joint.point.y, joint.point.z);
      // A warning mark, not geometry: kept out of the ambient-occlusion pass (see SceneManager).
      marker.userData.excludeFromAO = true;
      add(marker);
    }
    return built;
  }

  private applyVisibility(): void {
    for (const entry of [...this.entries.values()].flat()) {
      entry.mesh.visible = entry.members.some((id) => !this.hidden.has(id));
    }
  }
}
