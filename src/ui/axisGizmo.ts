import * as THREE from "three";
import { el } from "./dom";
import type { ScenePalette } from "../scene/sceneTheme";

const SVG = "http://www.w3.org/2000/svg";
const SIZE = 76;
const RADIUS = 25;

/** The world axes the gizmo draws - the app's one convention (engine/workspace/workspaceSettings.ts). */
const AXES = [
  { name: "X", hint: "east", direction: new THREE.Vector3(1, 0, 0), color: (palette: ScenePalette) => palette.axisX },
  { name: "Y", hint: "up", direction: new THREE.Vector3(0, 1, 0), color: (palette: ScenePalette) => palette.axisY },
  { name: "Z", hint: "south", direction: new THREE.Vector3(0, 0, 1), color: (palette: ScenePalette) => palette.axisZ }
] as const;

const hex = (color: number): string => `#${color.toString(16).padStart(6, "0")}`;

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
}

export interface AxisGizmo {
  element: HTMLElement;
  /** Turns the axes to match the camera - cheap, and skipped when the camera hasn't turned. */
  update(camera: THREE.Camera): void;
  setPalette(palette: ScenePalette): void;
}

/**
 * The viewport's orientation gizmo: the world's X (east), Y (up) and Z
 * (south) axes as seen from the camera, in a corner where they never sit
 * on top of the building. The axes drawn in the scene itself stay at the
 * origin; this only names them.
 */
export function createAxisGizmo(palette: ScenePalette): AxisGizmo {
  const root = svg("svg", { width: SIZE, height: SIZE, viewBox: `0 0 ${SIZE} ${SIZE}`, "aria-hidden": "true" });
  const parts = AXES.map((axis) => {
    const group = svg("g", {});
    const line = svg("line", { x1: SIZE / 2, y1: SIZE / 2, x2: SIZE / 2, y2: SIZE / 2, "stroke-width": 2.5, "stroke-linecap": "round" });
    const dot = svg("circle", { r: 8.5 });
    const label = svg("text", { "text-anchor": "middle", "dominant-baseline": "central", "font-size": 10, "font-weight": 700 });
    label.textContent = axis.name;
    group.append(line, dot, label);
    root.append(group);
    return { axis, group, line, dot, label };
  });
  const element = el("div", {
    className: "axis-gizmo",
    attrs: { role: "img", "aria-label": "Orientation: X runs east, Y up, Z south (the plan's Y)", title: "X east · Y up · Z south (the plan's Y)" }
  });
  element.append(root);

  let colors = palette;
  const paint = (): void => {
    for (const { axis, line, dot, label } of parts) {
      const color = hex(axis.color(colors));
      line.setAttribute("stroke", color);
      dot.setAttribute("fill", color);
      label.setAttribute("fill", "#ffffff");
    }
  };
  paint();

  const inverse = new THREE.Quaternion();
  const turned = new THREE.Vector3();
  let last = "";
  return {
    element,
    update(camera) {
      const key = camera.quaternion.toArray().map((value) => value.toFixed(4)).join(",");
      if (key === last) return;
      last = key;
      inverse.copy(camera.quaternion).invert();
      const placed = parts.map((part) => {
        turned.copy(part.axis.direction).applyQuaternion(inverse);
        return { part, x: SIZE / 2 + turned.x * RADIUS, y: SIZE / 2 - turned.y * RADIUS, depth: turned.z };
      });
      // Nearer axes drawn last, so they sit on top; an axis pointing away is dimmed.
      placed.sort((a, b) => a.depth - b.depth);
      for (const { part, x, y, depth } of placed) {
        part.line.setAttribute("x2", x.toFixed(1));
        part.line.setAttribute("y2", y.toFixed(1));
        part.dot.setAttribute("cx", x.toFixed(1));
        part.dot.setAttribute("cy", y.toFixed(1));
        part.label.setAttribute("x", x.toFixed(1));
        part.label.setAttribute("y", y.toFixed(1));
        part.group.setAttribute("opacity", depth < -0.2 ? "0.55" : "1");
        root.append(part.group);
      }
    },
    setPalette(next) {
      colors = next;
      paint();
    }
  };
}
