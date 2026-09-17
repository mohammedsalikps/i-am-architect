import * as THREE from "three";

export interface FitCameraOptions {
  /** The camera's vertical field of view, in degrees (SceneManager's PerspectiveCamera uses 60). */
  fovDegrees: number;
  /** Extra breathing room around the content - 1.18 leaves about 18% margin. */
  padding?: number;
  /** Never closer than this, so a single small object doesn't zoom in uncomfortably close. */
  minDistance?: number;
}

export interface FitCameraResult {
  position: THREE.Vector3;
  target: THREE.Vector3;
  distance: number;
}

// Phase 3A: was 1.35 (about 35% margin) - the viewport inspection found
// "Fit House" left the model occupying roughly a fifth of the frame, with
// a lot of empty space doing nothing for it. Tightened one step, not
// removed - still real breathing room on every side, just enough less of
// it that the building reads as the hero rather than a small object in a
// big field. Every *ratio* this value affects (bigger box -> bigger
// distance, narrower FOV -> bigger distance, and so on - see verify.ts)
// is unchanged; only the margin itself is smaller.
const DEFAULT_PADDING = 1.18;
const DEFAULT_MIN_DISTANCE = 2;

/**
 * A camera position and look-at target that frame `box` entirely, viewed
 * from `directionFromTarget` (the direction from the box's center TOWARD
 * the camera - not normalized here, any non-zero vector works). Pure
 * math over a THREE.Box3/Vector3 - no THREE.Camera, DOM, OrbitControls,
 * or WebGL touched, so this is Node-testable without a browser (see
 * verify.ts). SceneManager.fitToScene()/focusOn() are what apply the
 * result to the real camera and controls, keeping the viewer's current
 * viewing angle (the direction they pass in) rather than jumping to a
 * fixed angle.
 *
 * The box is framed by its bounding SPHERE (radius = half the box's
 * diagonal), not its individual axis extents - simpler and correct
 * regardless of the box's aspect ratio or which direction it's viewed
 * from, at the cost of sometimes leaving a bit more margin than the
 * tightest possible fit for a very elongated box viewed end-on. That
 * trade-off is the right one here: "never clips the content" matters
 * more than "pixel-tight framing" for an architectural fit/focus.
 */
export function computeFitCamera(box: THREE.Box3, directionFromTarget: THREE.Vector3, options: FitCameraOptions): FitCameraResult {
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const radius = Math.max(size.length() / 2, 0.01);
  const verticalHalfFov = THREE.MathUtils.degToRad(options.fovDegrees) / 2;
  const distance = Math.max((radius * (options.padding ?? DEFAULT_PADDING)) / Math.sin(verticalHalfFov), options.minDistance ?? DEFAULT_MIN_DISTANCE);
  const direction = directionFromTarget.lengthSq() < 1e-9 ? new THREE.Vector3(1, 1, 1) : directionFromTarget.clone();
  direction.normalize();
  const position = center.clone().addScaledVector(direction, distance);
  return { position, target: center, distance };
}
