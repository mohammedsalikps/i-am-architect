import * as THREE from "three";
import { getElementKind } from "../../engine/elements/catalog";
import type { ElementShape } from "../../engine/elements/catalog";
import { getMaterial } from "../../engine/materials/materialLibrary";
import type { ElementData } from "../../engine/elements/types";
import { OUTLINE_COLOR, OUTLINE_SCALE } from "../selectionOutline";

/**
 * Draws an element from its catalog recipe (`shape` in
 * engine/elements/catalog.ts): a THREE.Group of plain primitives sized to
 * the element's box - dimensions[axes.x] by dimensions[axes.y] by
 * dimensions[axes.z] - centered on its position and turned by its
 * rotation, exactly like the six original types' boxes. So the drawing,
 * the geometry analysis, and the resize handles all agree on its extent.
 *
 * Every mesh in the group carries `userData.objectId`, which is all
 * SelectionRaycaster and ManipulationController read. The recipes are
 * representations - a bed is a frame, a mattress, a headboard - not
 * detailed product models, and they never change the element's data.
 */

export interface ElementSize {
  x: number;
  y: number;
  z: number;
}

export interface ElementVisual {
  group: THREE.Group;
  /** The pickable meshes - every one tagged with the element's id. */
  meshes: THREE.Mesh[];
  /** The amber selection outline around the element's whole box. */
  outline: THREE.LineSegments;
}

// Secondary part colors - the element's own color and material always
// cover its main surface.
const WOOD = "#6b4f35";
const LINEN = "#f5f5f0";
const BARK = "#5a3f28";
const TERRACOTTA = "#b5653b";
const CARCASS = "#e5ded0";
const BOWL = "#b9c2c9";
const INSERT = "#2b2b2b";
const ROCKER = "#dcdcdc";

/** The element's box: the dimension on each local axis, per its catalog kind. */
export function elementSize(element: ElementData): ElementSize {
  const axes = getElementKind(element.kind)?.axes;
  const read = (key: string | undefined): number => {
    const value = key ? element.dimensions[key] : undefined;
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 1;
  };
  return { x: read(axes?.x), y: read(axes?.y), z: read(axes?.z) };
}

/** The main surface: the element's color, with the library material's finish (glass is see-through, steel is metallic). */
function surfaceMaterial(element: ElementData): THREE.MeshStandardMaterial {
  const library = getMaterial(element.material);
  const opacity = library?.opacity ?? 1;
  return new THREE.MeshStandardMaterial({
    color: element.color,
    roughness: library?.roughness ?? 0.85,
    metalness: library?.metalness ?? 0,
    transparent: opacity < 1,
    opacity,
    depthWrite: opacity >= 1
  });
}

function plainMaterial(color: THREE.ColorRepresentation, roughness = 0.8): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness });
}

function lighter(color: string, amount: number): THREE.Color {
  return new THREE.Color(color).lerp(new THREE.Color(0xffffff), amount);
}

function part(geometry: THREE.BufferGeometry, material: THREE.Material, x = 0, y = 0, z = 0): THREE.Mesh {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(x, y, z);
  return mesh;
}

function box(width: number, height: number, depth: number, material: THREE.Material, x = 0, y = 0, z = 0): THREE.Mesh {
  return part(new THREE.BoxGeometry(width, height, depth), material, x, y, z);
}

function integerParam(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

/** A gable prism: the ridge along local X, the two slopes falling across Z. */
function gableGeometry(s: ElementSize): THREE.BufferGeometry {
  const profile = new THREE.Shape();
  profile.moveTo(-s.z / 2, -s.y / 2);
  profile.lineTo(s.z / 2, -s.y / 2);
  profile.lineTo(0, s.y / 2);
  profile.closePath();
  const geometry = new THREE.ExtrudeGeometry(profile, { depth: s.x, bevelEnabled: false });
  geometry.translate(0, 0, -s.x / 2);
  geometry.rotateY(Math.PI / 2); // the extrusion (local Z) becomes the ridge (local X)
  return geometry;
}

function buildParts(shape: ElementShape, s: ElementSize, element: ElementData, main: THREE.MeshStandardMaterial): THREE.Mesh[] {
  const bottom = -s.y / 2;
  switch (shape) {
    case "box":
    case "plate":
      return [box(s.x, s.y, s.z, main)];

    case "roof-gable":
      return [part(gableGeometry(s), main)];

    case "stair": {
      const steps = integerParam(element.params.steps, 3, 40, 16);
      const going = s.x / steps;
      const rise = s.y / steps;
      return Array.from({ length: steps }, (_, index) => {
        const height = rise * (index + 1);
        return box(going, height, s.z, main, -s.x / 2 + going * (index + 0.5), bottom + height / 2, 0);
      });
    }

    case "pipe": {
      const radius = Math.min(s.y, s.z) / 2;
      const geometry = new THREE.CylinderGeometry(radius, radius, s.x, 16);
      geometry.rotateZ(Math.PI / 2); // along local X
      return [part(geometry, main)];
    }

    case "cylinder": {
      const radius = Math.min(s.x, s.z) / 2;
      return [part(new THREE.CylinderGeometry(radius, radius, s.y, 32), main)];
    }

    case "light": {
      const radius = Math.min(s.x, s.z) / 2;
      main.emissive = new THREE.Color(element.color);
      main.emissiveIntensity = 0.7;
      return [part(new THREE.CylinderGeometry(radius * 0.8, radius, s.y, 24), main)];
    }

    case "sink": {
      const topHeight = Math.min(0.18, s.y * 0.2);
      const standHeight = s.y - topHeight;
      return [
        box(s.x * 0.35, standHeight, s.z * 0.35, main, 0, bottom + standHeight / 2, -s.z * 0.2),
        box(s.x, topHeight, s.z, main, 0, s.y / 2 - topHeight / 2, 0),
        box(s.x * 0.7, 0.008, s.z * 0.6, plainMaterial(BOWL, 0.4), 0, s.y / 2 - 0.003, s.z * 0.05)
      ];
    }

    case "toilet": {
      const cisternDepth = s.z * 0.25;
      const bowlHeight = s.y * 0.5;
      const bowlDepth = s.z - cisternDepth;
      const bowlZ = -s.z / 2 + cisternDepth + bowlDepth / 2;
      return [
        box(s.x, s.y, cisternDepth, main, 0, 0, -s.z / 2 + cisternDepth / 2),
        box(s.x * 0.8, bowlHeight, bowlDepth, main, 0, bottom + bowlHeight / 2, bowlZ),
        box(s.x * 0.8, 0.02, bowlDepth * 0.95, plainMaterial(LINEN, 0.4), 0, bottom + bowlHeight + 0.01, bowlZ)
      ];
    }

    case "shower": {
      const trayHeight = Math.min(0.08, s.y * 0.1);
      const glassHeight = s.y - trayHeight;
      return [
        box(s.x, trayHeight, s.z, plainMaterial(LINEN, 0.4), 0, bottom + trayHeight / 2, 0),
        box(s.x, glassHeight, s.z, main, 0, bottom + trayHeight + glassHeight / 2, 0)
      ];
    }

    case "tap": {
      const radius = Math.max(0.005, Math.min(s.x, s.z) / 2);
      const spoutLength = Math.max(0.01, s.z - radius);
      const spout = new THREE.CylinderGeometry(radius * 0.8, radius * 0.8, spoutLength, 12);
      spout.rotateX(Math.PI / 2); // along local Z
      return [
        part(new THREE.CylinderGeometry(radius, radius, s.y, 12), main, 0, 0, -s.z / 2 + radius),
        part(spout, main, 0, s.y / 2 - radius, radius / 2)
      ];
    }

    case "wall-plate": {
      const count = integerParam(element.params.gangs ?? element.params.outlets, 1, 4, 1);
      const cell = (s.x * 0.8) / count;
      const insert = plainMaterial(element.kind === "socket" ? INSERT : ROCKER, 0.5);
      return [
        box(s.x, s.y, s.z * 0.7, main, 0, 0, -s.z * 0.15),
        ...Array.from({ length: count }, (_, index) =>
          box(cell * 0.7, s.y * 0.5, s.z * 0.3, insert, -s.x * 0.4 + cell * (index + 0.5), 0, s.z / 2 - s.z * 0.15)
        )
      ];
    }

    case "bed": {
      const frameHeight = s.y * 0.3;
      const mattressHeight = s.y * 0.22;
      const headboard = Math.min(0.08, s.x * 0.05);
      const wood = plainMaterial(WOOD, 0.7);
      return [
        box(s.x, frameHeight, s.z, wood, 0, bottom + frameHeight / 2, 0),
        box(s.x - headboard, mattressHeight, s.z * 0.96, main, headboard / 2, bottom + frameHeight + mattressHeight / 2, 0),
        box(headboard, s.y, s.z, wood, -s.x / 2 + headboard / 2, 0, 0),
        box(s.x * 0.12, s.y * 0.08, s.z * 0.8, plainMaterial(LINEN, 0.9), -s.x / 2 + headboard + s.x * 0.08, bottom + frameHeight + mattressHeight + s.y * 0.04, 0)
      ];
    }

    case "table": {
      const topHeight = Math.min(0.05, s.y * 0.1);
      const leg = Math.min(0.06, s.x * 0.1, s.z * 0.1);
      const legHeight = s.y - topHeight;
      const legs: THREE.Mesh[] = [];
      for (const sx of [-1, 1]) {
        for (const sz of [-1, 1]) {
          legs.push(box(leg, legHeight, leg, main, sx * (s.x / 2 - leg), bottom + legHeight / 2, sz * (s.z / 2 - leg)));
        }
      }
      return [box(s.x, topHeight, s.z, main, 0, s.y / 2 - topHeight / 2, 0), ...legs];
    }

    case "chair": {
      const seatTop = s.y * 0.5;
      const seatHeight = Math.min(0.05, s.y * 0.08);
      const leg = Math.min(0.04, s.x * 0.1, s.z * 0.1);
      const legHeight = seatTop - seatHeight;
      const backDepth = Math.min(0.05, s.z * 0.12);
      const legs: THREE.Mesh[] = [];
      for (const sx of [-1, 1]) {
        for (const sz of [-1, 1]) {
          legs.push(box(leg, legHeight, leg, main, sx * (s.x / 2 - leg), bottom + legHeight / 2, sz * (s.z / 2 - leg)));
        }
      }
      return [
        box(s.x, seatHeight, s.z, main, 0, bottom + seatTop - seatHeight / 2, 0),
        box(s.x, s.y - seatTop, backDepth, main, 0, bottom + seatTop + (s.y - seatTop) / 2, -s.z / 2 + backDepth / 2),
        ...legs
      ];
    }

    case "sofa": {
      const baseHeight = s.y * 0.45;
      const backDepth = s.z * 0.25;
      const armWidth = Math.min(0.2, s.x * 0.1);
      const armHeight = s.y * 0.65;
      return [
        box(s.x, baseHeight, s.z, main, 0, bottom + baseHeight / 2, 0),
        box(s.x, s.y - baseHeight, backDepth, main, 0, bottom + baseHeight + (s.y - baseHeight) / 2, -s.z / 2 + backDepth / 2),
        ...[-1, 1].map((side) =>
          box(armWidth, armHeight - baseHeight, s.z - backDepth, main, side * (s.x / 2 - armWidth / 2), bottom + baseHeight + (armHeight - baseHeight) / 2, backDepth / 2)
        )
      ];
    }

    case "cabinet": {
      const doors = s.x > 0.9 ? 2 : 1;
      const front = Math.min(0.02, s.z * 0.05);
      const panel = s.x / doors;
      const fronts = plainMaterial(lighter(element.color, 0.2), 0.6);
      return [
        box(s.x, s.y, s.z - front, main, 0, 0, -front / 2),
        ...Array.from({ length: doors }, (_, index) =>
          box(panel - 0.01, s.y - 0.02, front, fronts, -s.x / 2 + panel * (index + 0.5), 0, s.z / 2 - front / 2)
        )
      ];
    }

    case "counter": {
      const topHeight = Math.min(0.04, s.y * 0.08);
      const baseHeight = s.y - topHeight;
      return [
        box(s.x, baseHeight, s.z * 0.95, plainMaterial(CARCASS, 0.6), 0, bottom + baseHeight / 2, -s.z * 0.025),
        box(s.x, topHeight, s.z, main, 0, s.y / 2 - topHeight / 2, 0)
      ];
    }

    case "gate": {
      const stile = Math.min(0.06, s.x * 0.08);
      const rail = Math.min(0.06, s.y * 0.06);
      const inner = s.x - 2 * stile;
      const bars = Math.max(2, Math.floor(inner / 0.15));
      const gap = inner / (bars + 1);
      return [
        ...[-1, 1].map((side) => box(stile, s.y, s.z, main, side * (s.x / 2 - stile / 2), 0, 0)),
        ...[-1, 1].map((side) => box(inner, rail, s.z, main, 0, side * (s.y / 2 - rail / 2), 0)),
        ...Array.from({ length: bars }, (_, index) => box(0.02, s.y - 2 * rail, s.z * 0.5, main, -inner / 2 + gap * (index + 1), 0, 0))
      ];
    }

    case "tree": {
      const trunkHeight = s.y * 0.45;
      const trunkRadius = Math.max(0.04, Math.min(s.x, s.z) * 0.06);
      const canopyHeight = s.y * 0.64;
      const canopy = part(new THREE.SphereGeometry(0.5, 20, 14), main, 0, s.y / 2 - canopyHeight / 2, 0);
      canopy.scale.set(s.x, canopyHeight, s.z);
      return [part(new THREE.CylinderGeometry(trunkRadius * 0.8, trunkRadius, trunkHeight, 12), plainMaterial(BARK, 0.95), 0, bottom + trunkHeight / 2, 0), canopy];
    }

    case "plant": {
      const potHeight = s.y * 0.3;
      const foliageHeight = s.y * 0.75;
      const foliage = part(new THREE.SphereGeometry(0.5, 16, 12), main, 0, s.y / 2 - foliageHeight / 2, 0);
      foliage.scale.set(s.x, foliageHeight, s.z);
      return [part(new THREE.CylinderGeometry(s.x * 0.3, s.x * 0.22, potHeight, 16), plainMaterial(TERRACOTTA, 0.9), 0, bottom + potHeight / 2, 0), foliage];
    }

    case "room": {
      // Only a thin, translucent floor plate is pickable - the room's
      // volume stays click-through, so the walls and furniture inside it
      // can still be selected in the viewport.
      const floor = new THREE.MeshStandardMaterial({
        color: element.color,
        transparent: true,
        opacity: 0.28,
        depthWrite: false,
        side: THREE.DoubleSide
      });
      return [box(s.x, 0.01, s.z, floor, 0, bottom + 0.03, 0)];
    }
  }
}

/** A room's volume drawn as always-visible edges - decoration, never picked. */
function roomEdges(s: ElementSize, color: string): THREE.LineSegments {
  const volume = new THREE.BoxGeometry(s.x, s.y, s.z);
  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(volume),
    new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.55 })
  );
  volume.dispose();
  return edges;
}

export function applyElementTransform(group: THREE.Group, element: ElementData): void {
  group.position.set(element.position.x, element.position.y, element.position.z);
  group.rotation.y = element.rotation;
}

/** Everything that decides how an element looks apart from where it is - when it changes, the visual is rebuilt. */
export function elementAppearanceKey(element: ElementData): string {
  return JSON.stringify([element.kind, element.dimensions, element.params, element.material, element.color]);
}

export function buildElementVisual(element: ElementData): ElementVisual {
  const definition = getElementKind(element.kind);
  const size = elementSize(element);
  const group = new THREE.Group();
  group.userData.objectId = element.id;

  const meshes = buildParts(definition?.shape ?? "box", size, element, surfaceMaterial(element));
  // A room's floor plate is deliberately click-through and depth-write-off
  // (see the "room" case in buildParts) - it stays out of the shadow pass
  // too, so it never casts a faint shadow onto whatever is below it.
  const isRoomFloor = definition?.shape === "room";
  for (const mesh of meshes) {
    // objectId on every part: SelectionRaycaster reads this same field on
    // whatever it hits, regardless of construction-object type.
    mesh.userData.objectId = element.id;
    mesh.castShadow = !isRoomFloor;
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  if (definition?.shape === "room") {
    group.add(roomEdges(size, element.color));
  }

  const volume = new THREE.BoxGeometry(size.x, size.y, size.z);
  const outline = new THREE.LineSegments(new THREE.EdgesGeometry(volume), new THREE.LineBasicMaterial({ color: OUTLINE_COLOR }));
  volume.dispose();
  outline.scale.setScalar(OUTLINE_SCALE);
  outline.visible = false;
  group.add(outline);

  applyElementTransform(group, element);
  return { group, meshes, outline };
}

export function disposeElementVisual(visual: ElementVisual): void {
  visual.group.traverse((object) => {
    if (object instanceof THREE.Mesh || object instanceof THREE.LineSegments) {
      object.geometry.dispose();
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) {
        material.dispose();
      }
    }
  });
}
