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

export interface ArchitecturalFitOptions extends FitCameraOptions {
  /** The camera's aspect ratio (width/height) - needed to fit the box's actual projected width, not just a spherical approximation of it. */
  aspect: number;
}

/**
 * Like computeFitCamera, but frames the box's own projected silhouette
 * from the given viewing direction - both the vertical AND horizontal
 * field of view - rather than its bounding sphere.
 *
 * Phase 5B finding: a typical single-story building is wide and flat, so
 * its bounding-SPHERE radius is dominated by the long horizontal
 * diagonal. computeFitCamera then sizes distance off that same radius
 * for the VERTICAL fov too, which - for a low building - leaves large,
 * empty margins above and below it (task: "avoid huge empty areas...
 * building should occupy a meaningful portion of the viewport";
 * confirmed by inspection: "Fit House" on the AI-generated 10m x 8m
 * house left it occupying under a fifth of the frame). This measures the
 * box's real extent along the camera's own right/up axes instead, so a
 * wide flat building is framed by its true, smaller silhouette.
 *
 * Deliberately a separate function rather than a change to
 * computeFitCamera itself: the asset-thumbnail generator
 * (scripts/generate-thumbnails.html) also calls computeFitCamera, for
 * single, roughly cubic assets where the sphere/silhouette distinction
 * is moot - left untouched rather than risking a behavior change to
 * already-generated, committed thumbnails.
 */
export function computeArchitecturalFit(box: THREE.Box3, directionFromTarget: THREE.Vector3, options: ArchitecturalFitOptions): FitCameraResult {
  const center = box.getCenter(new THREE.Vector3());
  const outward = directionFromTarget.lengthSq() < 1e-9 ? new THREE.Vector3(1, 1, 1) : directionFromTarget.clone();
  outward.normalize();
  const forward = outward.clone().negate(); // the direction the camera looks, into the scene

  const worldUp = new THREE.Vector3(0, 1, 0);
  const right = new THREE.Vector3().crossVectors(forward, worldUp);
  if (right.lengthSq() < 1e-9) {
    right.set(1, 0, 0); // looking straight down/up - fall back to world X as "right"
  }
  right.normalize();
  const camUp = new THREE.Vector3().crossVectors(right, forward).normalize();

  let halfWidth = 0;
  let halfHeight = 0;
  const corner = new THREE.Vector3();
  const offset = new THREE.Vector3();
  for (let i = 0; i < 8; i += 1) {
    corner.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z);
    offset.subVectors(corner, center);
    halfWidth = Math.max(halfWidth, Math.abs(offset.dot(right)));
    halfHeight = Math.max(halfHeight, Math.abs(offset.dot(camUp)));
  }

  const padding = options.padding ?? DEFAULT_PADDING;
  const verticalHalfFov = THREE.MathUtils.degToRad(options.fovDegrees) / 2;
  const horizontalHalfFov = Math.atan(Math.tan(verticalHalfFov) * options.aspect);
  const distanceForHeight = halfHeight / Math.tan(verticalHalfFov);
  const distanceForWidth = halfWidth / Math.tan(horizontalHalfFov);
  // halfDepth is deliberately NOT added to distance here: the padding
  // margin below already covers the perspective foreshortening a deep
  // box's near corner introduces (the same "generous, not pixel-tight"
  // trade-off computeFitCamera's own docs already make) - adding the
  // full half-depth on top of it was measured to over-correct, pushing a
  // corner-viewed box's distance back ABOVE the sphere-based fit this
  // function exists to improve on.
  const distance = Math.max(Math.max(distanceForHeight, distanceForWidth) * padding, options.minDistance ?? DEFAULT_MIN_DISTANCE);

  const position = center.clone().addScaledVector(outward, distance);
  return { position, target: center, distance };
}
