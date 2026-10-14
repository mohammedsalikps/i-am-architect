import * as THREE from "three";
import { clearGroup, fitLabels, labelSprite, type ViewportSize } from "./labelSprite";
import type { ScenePalette } from "./sceneTheme";

/** How long each drawn axis is, metres - long enough to read, short enough not to cross a house built near the origin. */
export const AXIS_LENGTH = 3;

/** The axis names - the app's one coordinate convention (see engine/workspace/workspaceSettings.ts); shown by the corner gizmo and the Grid & plot popover. */
export const AXIS_LABELS = { x: "X  east", y: "Y  up", z: "Z  south (plan Y)" } as const;

export interface CoordinateOverlay {
  setPalette(palette: ScenePalette): void;
  setVisible(visible: boolean): void;
  /** Keeps the axis labels readable at this frame's zoom (see fitLabels). */
  update(camera: THREE.PerspectiveCamera, viewport: ViewportSize): void;
}

/**
 * The world's coordinate system, drawn: the X (east), Y (up) and Z (south)
 * axes from the origin, each with an arrowhead, and a marker at (0, 0, 0)
 * labelled "0, 0". The axes' names are shown by the corner orientation
 * gizmo (ui/axisGizmo.ts) rather than here, so they never sit on top of a
 * building raised over the origin. Unlit and unfogged (always its true
 * colour), never picked, never saved - a view guide like the grid.
 * Theme-aware; hidden with the workspace's "axes" setting.
 */
export function createCoordinateOverlay(scene: THREE.Scene, palette: ScenePalette): CoordinateOverlay {
  const root = new THREE.Group();
  root.name = "coordinate-axes";
  root.userData.excludeFromAO = true;
  scene.add(root);

  const build = (colors: ScenePalette): void => {
    clearGroup(root);
    const lift = 0.02; // just above the ground and grid
    const axis = (direction: THREE.Vector3, color: number): void => {
      const material = new THREE.MeshBasicMaterial({ color, fog: false });
      const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, AXIS_LENGTH - 0.25, 12), material);
      const head = new THREE.Mesh(new THREE.ConeGeometry(0.08, 0.25, 16), material);
      // Cylinders and cones point along +Y: turn them onto the axis.
      const turn = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction);
      shaft.quaternion.copy(turn);
      head.quaternion.copy(turn);
      shaft.position.copy(direction.clone().multiplyScalar((AXIS_LENGTH - 0.25) / 2));
      head.position.copy(direction.clone().multiplyScalar(AXIS_LENGTH - 0.125));
      for (const part of [shaft, head]) {
        part.position.y += direction.y === 0 ? lift : 0;
        part.userData.excludeFromAO = true;
        part.raycast = () => undefined;
        root.add(part);
      }
    };
    axis(new THREE.Vector3(1, 0, 0), colors.axisX);
    axis(new THREE.Vector3(0, 1, 0), colors.axisY);
    axis(new THREE.Vector3(0, 0, 1), colors.axisZ);

    // The origin: a ring and a dot at (0, 0, 0).
    const originMaterial = new THREE.MeshBasicMaterial({ color: colors.origin, side: THREE.DoubleSide, fog: false });
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.16, 0.22, 32), originMaterial);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = lift;
    const dot = new THREE.Mesh(new THREE.SphereGeometry(0.07, 16, 12), originMaterial);
    dot.position.y = 0.07;
    for (const part of [ring, dot]) {
      part.userData.excludeFromAO = true;
      part.raycast = () => undefined;
      root.add(part);
    }
    // Depth-tested: a building over the origin hides it rather than wearing it.
    const originLabel = labelSprite("0, 0", colors, { height: 0.28, minPixels: 12 });
    originLabel.position.set(-0.45, 0.3, -0.45);
    root.add(originLabel);
  };
  build(palette);

  return {
    setPalette: build,
    setVisible(visible) {
      root.visible = visible;
    },
    update(camera, viewport) {
      fitLabels(root, camera, viewport);
    }
  };
}
