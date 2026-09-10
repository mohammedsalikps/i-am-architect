import * as THREE from "three";
import type { ManipulationGesture, ObjectManipulator } from "../../engine/manipulation/ObjectManipulator";
import type { HandleTarget, ManipulationHandles } from "./ManipulationHandles";

export interface ManipulationControllerOptions {
  /** The element wrapping the canvas - presses are intercepted here, in the capture phase. */
  container: HTMLElement;
  canvas: HTMLElement;
  camera: THREE.Camera;
  selection: { get(): string | null };
  handles: ManipulationHandles;
  /** Every construction-object mesh (the layers' getMeshes()), for picking the selected object's body. */
  getObjectMeshes: () => THREE.Object3D[];
  manipulator: ObjectManipulator;
}

interface Drag {
  pointerId: number;
  /** The plane the pointer is projected onto for this gesture. */
  plane: THREE.Plane;
}

const UP = new THREE.Vector3(0, 1, 0);

function cursorFor(gesture: ManipulationGesture, dragging: boolean): string {
  switch (gesture.kind) {
    case "move":
      return "move";
    case "resize":
      return gesture.axis === "y" ? "ns-resize" : "ew-resize";
    case "rotate":
      return dragging ? "grabbing" : "grab";
  }
}

function gestureFor(target: HandleTarget): ManipulationGesture {
  return target.kind === "rotate" ? { kind: "rotate" } : { kind: "resize", axis: target.axis, side: target.side };
}

/**
 * Pointer handling for mouse manipulation. It turns a press on the
 * selected object's body (move) or one of its handles (resize, rotate)
 * into a gesture, projects each pointer position onto that gesture's drag
 * plane, and hands the point to ObjectManipulator - which is the only
 * thing that changes the model, through CommandExecutor. Nothing here
 * writes a store or moves a construction mesh; the layers redraw from
 * the stores as the commands land.
 *
 * Drag planes: a move or a side/rotate handle uses the horizontal plane
 * through the grab point; the top handle uses a vertical plane through
 * it, facing the camera. In a straight-down view there is no usable
 * vertical plane, so the top handle does nothing there.
 *
 * Only presses that start a gesture are taken. They are caught on the
 * container in the capture phase and stopped, so neither OrbitControls
 * nor click-to-select (both on the canvas) ever sees them; every other
 * press - empty space, another object, the right button - reaches them
 * exactly as before. Escape or a cancelled pointer abandons the gesture
 * and restores the object.
 *
 * A running gesture follows the pointer on the window, not just the
 * canvas, so it ends wherever the pointer is released - even outside the
 * canvas when pointer capture isn't available. And if a new press arrives
 * while a gesture is still open, that gesture's release was lost (it
 * happened somewhere this page never heard about): it is finished where
 * it stands, as one undo entry, before the new press is considered - so a
 * lost release can never leave the history group open.
 */
export class ManipulationController {
  private readonly canvas: HTMLElement;
  private readonly camera: THREE.Camera;
  private readonly selection: ManipulationControllerOptions["selection"];
  private readonly handles: ManipulationHandles;
  private readonly getObjectMeshes: () => THREE.Object3D[];
  private readonly manipulator: ObjectManipulator;

  // Reused for every pointer event - no per-move allocations.
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private readonly hitPoint = new THREE.Vector3();
  private readonly anchor = new THREE.Vector3();
  private readonly normal = new THREE.Vector3();

  private drag: Drag | null = null;

  constructor(options: ManipulationControllerOptions) {
    this.canvas = options.canvas;
    this.camera = options.camera;
    this.selection = options.selection;
    this.handles = options.handles;
    this.getObjectMeshes = options.getObjectMeshes;
    this.manipulator = options.manipulator;

    options.container.addEventListener("pointerdown", this.handlePointerDown, { capture: true });
    this.canvas.addEventListener("pointermove", this.handleHover);
    window.addEventListener("pointermove", this.handleDragMove);
    window.addEventListener("pointerup", this.handlePointerUp);
    window.addEventListener("pointercancel", this.handlePointerCancel);
    window.addEventListener("keydown", this.handleKeyDown);
  }

  private readonly handlePointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 || event.target !== this.canvas) {
      return;
    }
    if (this.drag) {
      // The open gesture's release never arrived - finish it where it stands.
      this.manipulator.end();
      this.finishDrag();
    }
    const selectedId = this.selection.get();
    if (!selectedId) {
      return;
    }

    this.aim(event);
    const start = this.pickGesture(selectedId);
    if (!start || !this.manipulator.begin(selectedId, start.gesture, start.grab)) {
      return;
    }

    // This press is a manipulation - keep it from OrbitControls and click-to-select.
    event.stopPropagation();
    event.preventDefault();
    this.drag = { pointerId: event.pointerId, plane: start.plane };
    this.canvas.style.cursor = cursorFor(start.gesture, true);
    try {
      // Keeps moves and the release coming here even off the canvas.
      this.canvas.setPointerCapture(event.pointerId);
    } catch {
      // The pointer is no longer active (it can be released before this
      // runs). The gesture still works while the pointer stays over the
      // canvas, and ends on its pointerup/pointercancel as usual.
    }
  };

  /** Follows the running gesture's pointer anywhere on the page. */
  private readonly handleDragMove = (event: PointerEvent): void => {
    if (!this.drag || event.pointerId !== this.drag.pointerId) {
      return;
    }
    this.aim(event);
    const point = this.raycaster.ray.intersectPlane(this.drag.plane, this.hitPoint);
    if (point) {
      this.manipulator.update(point);
    }
  };

  /** Hover feedback over the canvas while no button is pressed. */
  private readonly handleHover = (event: PointerEvent): void => {
    if (!this.drag && event.buttons === 0) {
      this.updateHoverCursor(event);
    }
  };

  private readonly handlePointerUp = (event: PointerEvent): void => {
    if (this.drag && event.pointerId === this.drag.pointerId) {
      this.manipulator.end();
      this.finishDrag();
      if (event.target === this.canvas) {
        this.updateHoverCursor(event);
      }
    }
  };

  private readonly handlePointerCancel = (event: PointerEvent): void => {
    if (this.drag && event.pointerId === this.drag.pointerId) {
      this.manipulator.cancel();
      this.finishDrag();
    }
  };

  private readonly handleKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Escape" && this.drag) {
      this.manipulator.cancel();
      this.finishDrag();
    }
  };

  private finishDrag(): void {
    if (this.drag && this.canvas.hasPointerCapture(this.drag.pointerId)) {
      this.canvas.releasePointerCapture(this.drag.pointerId);
    }
    this.drag = null;
    this.canvas.style.cursor = "";
  }

  /** Points the raycaster through the pointer's position on the canvas. */
  private aim(event: PointerEvent): void {
    const rect = this.canvas.getBoundingClientRect();
    this.pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
  }

  /**
   * What the aimed ray points at first: a handle, or the selected
   * object's body - whichever is nearer, like the depth-tested picture.
   * A handle behind the object isn't reachable through it, and another
   * object in front blocks both (that press then goes to click-to-select
   * as usual).
   */
  private pick(selectedId: string): { kind: "handle"; hit: THREE.Intersection } | { kind: "body"; hit: THREE.Intersection } | null {
    const handleHit = this.raycaster.intersectObjects(this.handles.getHandleMeshes(), false)[0];
    const bodyHit = this.raycaster.intersectObjects(this.getObjectMeshes(), false)[0];
    if (handleHit && (!bodyHit || handleHit.distance <= bodyHit.distance)) {
      return { kind: "handle", hit: handleHit };
    }
    if (bodyHit && bodyHit.object.userData.objectId === selectedId) {
      return { kind: "body", hit: bodyHit };
    }
    return null;
  }

  private pickGesture(selectedId: string): { gesture: ManipulationGesture; grab: THREE.Vector3; plane: THREE.Plane } | null {
    const picked = this.pick(selectedId);
    if (!picked) {
      return null;
    }
    if (picked.kind === "body") {
      return {
        gesture: { kind: "move" },
        grab: picked.hit.point.clone(),
        plane: new THREE.Plane().setFromNormalAndCoplanarPoint(UP, picked.hit.point)
      };
    }
    const target = picked.hit.object.userData.handle as HandleTarget;
    picked.hit.object.getWorldPosition(this.anchor);
    const plane = this.planeFor(target, this.anchor);
    const grab = plane ? this.raycaster.ray.intersectPlane(plane, new THREE.Vector3()) : null;
    return plane && grab ? { gesture: gestureFor(target), grab, plane } : null;
  }

  /** Horizontal through `at` for side and rotate handles; vertical and facing the camera for the top handle. */
  private planeFor(target: HandleTarget, at: THREE.Vector3): THREE.Plane | null {
    if (target.kind === "resize" && target.axis === "y") {
      this.camera.getWorldDirection(this.normal);
      this.normal.y = 0;
      if (this.normal.lengthSq() < 1e-6) {
        return null; // looking straight down - no vertical plane to drag on
      }
      return new THREE.Plane().setFromNormalAndCoplanarPoint(this.normal.normalize(), at);
    }
    return new THREE.Plane().setFromNormalAndCoplanarPoint(UP, at);
  }

  private updateHoverCursor(event: PointerEvent): void {
    const selectedId = this.selection.get();
    if (!selectedId) {
      this.canvas.style.cursor = "";
      return;
    }
    this.aim(event);
    const picked = this.pick(selectedId);
    if (!picked) {
      this.canvas.style.cursor = "";
    } else if (picked.kind === "body") {
      this.canvas.style.cursor = "move";
    } else {
      this.canvas.style.cursor = cursorFor(gestureFor(picked.hit.object.userData.handle as HandleTarget), false);
    }
  }
}
