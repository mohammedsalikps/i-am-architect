import * as THREE from "three";
import { describeMeasurement, describeSnap, measureBetween, snapMeasurePoint, type MeasurePoint } from "../engine/measure/measure";
import type { SnapObject } from "../engine/snapping/snapping";
import type { PlacementController } from "./placement/PlacementController";
import { disposeChildren, overlayObject, textSprite } from "./siteOverlay";

export const MEASURE_TOOL_ID = "measure";

export interface MeasureToolOptions {
  scene: THREE.Scene;
  camera: THREE.Camera;
  canvas: HTMLCanvasElement;
  placementController: PlacementController;
  /** The objects a measured point may snap to - read fresh on every pointer move. */
  snapObjects(): readonly SnapObject[];
  /** Whether the viewport's Snap toggle is on. */
  snapping(): boolean;
  /** The tool's one-line readout changed (or null: the tool was put away). */
  onReadout(text: string | null): void;
}

export interface MeasureTool {
  /** Arms the Measure tool (or puts it away again if it's already armed). */
  toggle(): void;
  isActive(): boolean;
  /** The current readout, while armed. */
  readout(): string | null;
}

const MEASURE_COLOR = 0xc2410c;
const GRID_COLOR = 0x5f6b7a;
const LIFT = 0.04;
const GROUND_PLANE = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

/**
 * The viewport's Measure tool: click two points on the ground and read
 * the plan distance between them (engine/measure/measure.ts). It rides on
 * PlacementController's armed-tool lifecycle - the same crosshair, click
 * vs. drag threshold, Escape, status-bar Cancel and "one tool at a time"
 * as every placement tool - but its clicks only record points: it never
 * runs a command, so the model, undo history and record book are
 * untouched.
 *
 * While armed: a ring shows where the cursor snaps (an object's end,
 * corner or centre in orange, the grid in grey); after the first click a
 * dashed line follows the cursor with the live distance; the second click
 * fixes the measurement. A third click starts a new one. Putting the tool
 * away (Escape, Cancel, Select, or arming another tool) clears it.
 */
export function createMeasureTool(options: MeasureToolOptions): MeasureTool {
  const root = new THREE.Group();
  root.name = "measure-overlay";
  options.scene.add(root);
  const raycaster = new THREE.Raycaster();
  let active = false;
  let start: MeasurePoint | null = null;
  let end: MeasurePoint | null = null;
  let hover: MeasurePoint | null = null;

  const snap = (raw: { x: number; z: number }): MeasurePoint => snapMeasurePoint(raw, options.snapObjects(), options.snapping());

  function groundPointFor(event: PointerEvent): THREE.Vector3 | null {
    const rect = options.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(ndc, options.camera);
    const out = new THREE.Vector3();
    return raycaster.ray.intersectPlane(GROUND_PLANE, out) ? out : null;
  }

  function readout(): string | null {
    if (!active) return null;
    if (start && end) {
      return `Measured ${describeMeasurement(measureBetween(start, end))} - from ${describeSnap(start)} to ${describeSnap(end)}. Click to start a new measurement.`;
    }
    if (start) {
      const live = hover ? ` ${describeMeasurement(measureBetween(start, hover))} so far -` : "";
      return `Measuring from ${describeSnap(start)}:${live} click the second point.`;
    }
    if (!options.snapping()) return "Measure: click the first point (Snap is off - points aren't snapped).";
    return hover
      ? `Measure: click the first point - here it snaps to ${describeSnap(hover)}.`
      : "Measure: click the first point - it snaps to object ends, corners and centres, or the 0.1 m grid.";
  }

  function marker(point: MeasurePoint, radius: number): THREE.Object3D {
    const color = point.snap === "grid" || point.snap === "free" ? GRID_COLOR : MEASURE_COLOR;
    const ring = new THREE.Mesh(new THREE.RingGeometry(radius * 0.6, radius, 32), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95, depthTest: false, side: THREE.DoubleSide }));
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(point.x, LIFT, point.z);
    return overlayObject(ring);
  }

  function segment(from: MeasurePoint, to: MeasurePoint, dashed: boolean): THREE.Object3D {
    const material = dashed
      ? new THREE.LineDashedMaterial({ color: MEASURE_COLOR, dashSize: 0.25, gapSize: 0.15, depthTest: false })
      : new THREE.LineBasicMaterial({ color: MEASURE_COLOR, depthTest: false });
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(from.x, LIFT, from.z), new THREE.Vector3(to.x, LIFT, to.z)]), material);
    if (dashed) line.computeLineDistances();
    return overlayObject(line);
  }

  function redraw(): void {
    disposeChildren(root);
    if (active) {
      if (hover && !(start && end)) root.add(marker(hover, 0.2));
      if (start) root.add(marker(start, 0.14));
      if (end) root.add(marker(end, 0.14));
      const to = end ?? hover;
      if (start && to) {
        root.add(segment(start, to, !end));
        const measurement = measureBetween(start, to);
        if (measurement.distance >= 0.05) {
          const label = textSprite(describeMeasurement(measurement).replace(/ \(.*\)$/, ""), 0.55);
          label.position.set((start.x + to.x) / 2, 0.45, (start.z + to.z) / 2);
          root.add(label);
        }
      }
    }
    options.onReadout(readout());
  }

  function clear(): void {
    start = null;
    end = null;
    hover = null;
  }

  options.placementController.subscribe((tool) => {
    const nowActive = tool?.id === MEASURE_TOOL_ID;
    if (nowActive === active) return;
    active = nowActive;
    clear();
    redraw();
  });

  options.canvas.addEventListener("pointermove", (event) => {
    if (!active) return;
    const point = groundPointFor(event);
    hover = point ? snap({ x: point.x, z: point.z }) : null;
    redraw();
  });

  return {
    toggle() {
      if (active) {
        options.placementController.disarm();
        return;
      }
      options.placementController.arm({
        id: MEASURE_TOOL_ID,
        label: "Measure",
        ghostSize: { x: 0.1, y: 0.01, z: 0.1 },
        repeat: true,
        measures: true,
        place(point) {
          const picked = snap(point);
          if (!start || end) {
            start = picked;
            end = null;
          } else {
            end = picked;
          }
          redraw();
        }
      });
      // The snap ring stands in for the generic box ghost.
      options.placementController.setGhostVisible(false);
    },
    isActive: () => active,
    readout
  };
}
