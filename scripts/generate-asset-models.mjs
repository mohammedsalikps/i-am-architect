// Generates every design-asset .gltf file under src/assets/ from simple
// THREE.js primitives (boxes/cylinders/cones only - no textures, no
// external art). Each asset is authored directly at its real-world
// target size in meters, so the exported glTF's own bounding box IS the
// asset's natural/default size - see engine/assets/types.ts's
// ASSET_DEFINITIONS, whose defaultDimensions are copied from this
// script's own printed output, keeping the two in sync by construction.
//
// This is a one-time/rerunnable authoring tool, not part of the shipped
// app - run with `node scripts/generate-asset-models.mjs` from the repo
// root. Re-run it (after editing a build*() function below) to
// regenerate a file; commit the resulting .gltf like any other source.
//
// Honesty note: these are simple, recognizable representations (a few
// boxes/cylinders per object), not photorealistic or licensed furniture
// models - consistent with the milestone's "generated/simple
// project-owned representations" instruction.
import * as THREE from "three";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

// three's GLTFExporter needs FileReader (a browser API) to turn its
// output Blob into a base64 data: URI for a non-binary .gltf export.
// Node has Blob but not FileReader - this is the smallest possible
// polyfill for the one method GLTFExporter actually calls.
class FileReaderPolyfill {
  readAsDataURL(blob) {
    blob.arrayBuffer().then((buffer) => {
      this.result = `data:${blob.type};base64,${Buffer.from(buffer).toString("base64")}`;
      this.onloadend?.();
    });
  }
}
globalThis.FileReader = FileReaderPolyfill;

const OUT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "assets");
mkdirSync(OUT_DIR, { recursive: true });

function material(color, roughness = 0.85, metalness = 0) {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness });
}

function box(w, h, d, mat, x = 0, y = 0, z = 0) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  mesh.position.set(x, y, z);
  return mesh;
}

function cylinder(radiusTop, radiusBottom, h, mat, x = 0, y = 0, z = 0, segments = 20) {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radiusTop, radiusBottom, h, segments), mat);
  mesh.position.set(x, y, z);
  return mesh;
}

function cone(radius, h, mat, x = 0, y = 0, z = 0, segments = 20) {
  const mesh = new THREE.Mesh(new THREE.ConeGeometry(radius, h, segments), mat);
  mesh.position.set(x, y, z);
  return mesh;
}

function sphere(radius, mat, x = 0, y = 0, z = 0) {
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 20, 14), mat);
  mesh.position.set(x, y, z);
  return mesh;
}

// --- Living ---

function buildSofa() {
  const fabric = material("#7a8ca3", 1);
  const group = new THREE.Group();
  const seatH = 0.42;
  group.add(box(2.0, seatH, 0.85, fabric, 0, seatH / 2, 0));
  group.add(box(2.0, 0.5, 0.15, fabric, 0, seatH + 0.25, -0.35));
  group.add(box(0.16, 0.38, 0.85, fabric, -0.92, seatH + 0.19 - 0.04, 0));
  group.add(box(0.16, 0.38, 0.85, fabric, 0.92, seatH + 0.19 - 0.04, 0));
  return group;
}

function buildCoffeeTable() {
  const wood = material("#b08050", 0.6);
  const group = new THREE.Group();
  const legH = 0.4;
  const topH = 0.04;
  group.add(box(1.1, topH, 0.55, wood, 0, legH + topH / 2, 0));
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      group.add(cylinder(0.025, 0.025, legH, wood, sx * 0.5, legH / 2, sz * 0.24));
    }
  }
  return group;
}

function buildTvConsole() {
  const wood = material("#4a3a2c", 0.55);
  const group = new THREE.Group();
  group.add(box(1.6, 0.42, 0.4, wood, 0, 0.21, 0));
  const legH = 0.08;
  for (const sx of [-1, 1]) {
    group.add(box(0.05, legH, 0.05, material("#2b2b2b", 0.5, 0.6), sx * 0.7, legH / 2, 0));
  }
  return group;
}

function buildPlant() {
  const pot = material("#b5653b", 0.9);
  const foliage = material("#3f7d34", 1);
  const group = new THREE.Group();
  group.add(cylinder(0.16, 0.22, 0.32, pot, 0, 0.16, 0));
  const canopy = sphere(0.32, foliage, 0, 0.68, 0);
  canopy.scale.set(1, 1.25, 1);
  group.add(canopy);
  return group;
}

// --- Bedroom ---

function buildBed() {
  const wood = material("#6b4f35", 0.7);
  const mattress = material("#f5f5f0", 0.9);
  const linen = material("#e9e3d5", 0.9);
  const group = new THREE.Group();
  const frameH = 0.3;
  group.add(box(1.6, frameH, 2.0, wood, 0, frameH / 2, 0));
  group.add(box(1.5, 0.22, 1.9, mattress, 0, frameH + 0.11, 0));
  group.add(box(1.6, 0.85, 0.08, wood, 0, 0.45, -0.96));
  group.add(box(0.55, 0.12, 0.4, linen, -0.4, frameH + 0.22 + 0.06, -0.7));
  group.add(box(0.55, 0.12, 0.4, linen, 0.4, frameH + 0.22 + 0.06, -0.7));
  return group;
}

function buildBedsideTable() {
  const wood = material("#8a6a45", 0.6);
  const group = new THREE.Group();
  group.add(box(0.45, 0.55, 0.4, wood, 0, 0.275, 0));
  group.add(box(0.4, 0.18, 0.02, material("#6b4f35", 0.5), 0, 0.32, 0.2));
  return group;
}

function buildWardrobe() {
  const wood = material("#5c4630", 0.6);
  const panel = material("#4a3624", 0.5);
  const group = new THREE.Group();
  group.add(box(1.0, 2.0, 0.6, wood, 0, 1.0, 0));
  group.add(box(0.46, 1.85, 0.02, panel, -0.25, 1.0, 0.3));
  group.add(box(0.46, 1.85, 0.02, panel, 0.25, 1.0, 0.3));
  return group;
}

// --- Dining ---

function buildDiningTable() {
  const wood = material("#a97c50", 0.6);
  const group = new THREE.Group();
  const legH = 0.72;
  const topH = 0.05;
  group.add(box(1.6, topH, 0.9, wood, 0, legH + topH / 2, 0));
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      group.add(cylinder(0.03, 0.03, legH, wood, sx * 0.72, legH / 2, sz * 0.38));
    }
  }
  return group;
}

function buildDiningChair() {
  const wood = material("#a97c50", 0.65);
  const group = new THREE.Group();
  const seatTop = 0.46;
  const seatH = 0.04;
  group.add(box(0.42, seatH, 0.42, wood, 0, seatTop, 0));
  group.add(box(0.42, 0.42, 0.04, wood, 0, seatTop + 0.21, -0.19));
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      group.add(cylinder(0.02, 0.02, seatTop - seatH / 2, wood, sx * 0.18, (seatTop - seatH / 2) / 2, sz * 0.18));
    }
  }
  return group;
}

// --- Kitchen ---

function buildKitchenCounter() {
  const cabinet = material("#e5ded0", 0.55);
  const worktop = material("#3d3d3d", 0.35);
  const sink = material("#8c9198", 0.35, 0.6);
  const group = new THREE.Group();
  group.add(box(2.0, 0.85, 0.6, cabinet, 0, 0.425, 0));
  group.add(box(2.05, 0.04, 0.64, worktop, 0, 0.87, 0));
  group.add(box(0.5, 0.08, 0.36, sink, 0.55, 0.85, 0));
  return group;
}

// --- Bathroom ---

function buildToilet() {
  const ceramic = material("#f4f4f2", 0.3);
  const seatMat = material("#e8e8e8", 0.4);
  const group = new THREE.Group();
  group.add(box(0.38, 0.35, 0.18, ceramic, 0, 0.575, -0.28));
  group.add(cylinder(0.2, 0.22, 0.4, ceramic, 0, 0.2, 0.02));
  group.add(cylinder(0.21, 0.21, 0.02, seatMat, 0, 0.41, 0.02));
  return group;
}

// --- Lighting ---

function buildFloorLamp() {
  const metal = material("#8c9198", 0.35, 0.75);
  const shade = material("#f0e4c8", 0.9);
  const group = new THREE.Group();
  group.add(cylinder(0.16, 0.16, 0.02, metal, 0, 0.01, 0));
  group.add(cylinder(0.015, 0.015, 1.3, metal, 0, 0.66, 0));
  group.add(cylinder(0.16, 0.11, 0.28, shade, 0, 1.45, 0));
  return group;
}

// --- Decor ---

function buildRug() {
  const fabric = material("#a3402f", 1);
  const group = new THREE.Group();
  group.add(box(2.0, 0.02, 1.4, fabric, 0, 0.01, 0));
  return group;
}

const ASSETS = [
  { id: "sofa", build: buildSofa },
  { id: "coffee-table", build: buildCoffeeTable },
  { id: "tv-console", build: buildTvConsole },
  { id: "plant", build: buildPlant },
  { id: "bed", build: buildBed },
  { id: "bedside-table", build: buildBedsideTable },
  { id: "wardrobe", build: buildWardrobe },
  { id: "dining-table", build: buildDiningTable },
  { id: "dining-chair", build: buildDiningChair },
  { id: "kitchen-counter", build: buildKitchenCounter },
  { id: "toilet", build: buildToilet },
  { id: "floor-lamp", build: buildFloorLamp },
  { id: "rug", build: buildRug }
];

function exportAsset({ id, build }) {
  return new Promise((resolve, reject) => {
    const group = build();
    const box3 = new THREE.Box3().setFromObject(group);
    const size = box3.getSize(new THREE.Vector3());

    new GLTFExporter().parse(
      group,
      (result) => {
        const file = path.join(OUT_DIR, `${id}.gltf`);
        writeFileSync(file, JSON.stringify(result));
        console.log(`${id}.gltf  ->  width=${size.x.toFixed(3)} height=${size.y.toFixed(3)} depth=${size.z.toFixed(3)}`);
        resolve();
      },
      (error) => reject(error),
      { binary: false }
    );
  });
}

for (const asset of ASSETS) {
  await exportAsset(asset);
}
console.log(`\n${ASSETS.length} asset models written to ${OUT_DIR}`);
