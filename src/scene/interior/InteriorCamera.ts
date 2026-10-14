import * as THREE from "three";
import { lookDirection, turn, walk } from "../../engine/interior/interiorExplore";
import type { InteriorRoom, InteriorViewpoint } from "../../engine/interior/interiorExplore";

export interface InteriorCameraHandlers {
  /** The eye moved or turned - for the navigator's readout. */
  onChange(view: InteriorViewpoint): void;
  /** Escape was pressed: leave Interior Explore. */
  onExit(): void;
}

/** Walking pace, metres per second; turning with the arrow keys, radians per second. */
const WALK_SPEED = 1.4;
const TURN_SPEED = 1.6;
/** Drag-to-look: radians per pixel dragged. */
const LOOK_PER_PIXEL = 0.005;
/** One wheel notch walks this far, metres. */
const WHEEL_STEP = 0.5;

/** Keys that walk, step sideways or turn - and what they do. */
const KEYS: Readonly<Record<string, { forward?: number; sideways?: number; turn?: number }>> = {
  KeyW: { forward: 1 },
  ArrowUp: { forward: 1 },
  KeyS: { forward: -1 },
  ArrowDown: { forward: -1 },
  KeyA: { sideways: -1 },
  KeyD: { sideways: 1 },
  ArrowLeft: { turn: 1 },
  ArrowRight: { turn: -1 }
};

/** Typing in a field (the companion's input, the inspector) is never walking. */
function isTyping(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  return !!element && (element.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName));
}

/**
 * Interior Explore's camera: a person standing in a room. Drag to look
 * around (the view follows the pointer, as in a street-level viewer);
 * W/S or ↑/↓ walk, A/D step sideways, ←/→ turn, the wheel steps; Escape
 * leaves. Every move goes through walk()/turn(), so the eye stays inside
 * the room at eye height. It only moves the camera - SceneManager pauses
 * OrbitControls, picking and dragging while it is active.
 */
export class InteriorCamera {
  private readonly camera: THREE.PerspectiveCamera;
  private readonly canvas: HTMLCanvasElement;
  private readonly handlers: InteriorCameraHandlers;
  private room: InteriorRoom;
  private view: InteriorViewpoint;
  private readonly held = new Set<string>();
  private drag: { pointerId: number; x: number; y: number } | null = null;

  constructor(camera: THREE.PerspectiveCamera, canvas: HTMLCanvasElement, room: InteriorRoom, view: InteriorViewpoint, handlers: InteriorCameraHandlers) {
    this.camera = camera;
    this.canvas = canvas;
    this.handlers = handlers;
    this.room = room;
    this.view = view;
    canvas.addEventListener("pointerdown", this.handlePointerDown);
    canvas.addEventListener("pointermove", this.handlePointerMove);
    canvas.addEventListener("pointerup", this.handlePointerUp);
    canvas.addEventListener("pointercancel", this.handlePointerUp);
    canvas.addEventListener("wheel", this.handleWheel, { passive: false });
    window.addEventListener("keydown", this.handleKeyDown);
    window.addEventListener("keyup", this.handleKeyUp);
    window.addEventListener("blur", this.handleBlur);
    canvas.style.cursor = "grab";
    this.apply(true);
  }

  /** Into another room (or back to this room's starting view - "Fit room"). */
  setRoom(room: InteriorRoom, view: InteriorViewpoint): void {
    this.room = room;
    this.view = view;
    this.apply(true);
  }

  /** One frame: walking and turning from the keys held, `seconds` since the last frame. */
  update(seconds: number): void {
    if (this.held.size === 0) return;
    let forward = 0;
    let sideways = 0;
    let turning = 0;
    for (const code of this.held) {
      const key = KEYS[code];
      forward += key?.forward ?? 0;
      sideways += key?.sideways ?? 0;
      turning += key?.turn ?? 0;
    }
    const step = Math.min(seconds, 0.1); // a stalled frame never jumps across the room
    let next = turning !== 0 ? turn(this.view, turning * TURN_SPEED * step, 0) : this.view;
    if (forward !== 0 || sideways !== 0) next = walk(next, forward * WALK_SPEED * step, sideways * WALK_SPEED * step, this.room);
    this.view = next;
    this.apply(false);
  }

  dispose(): void {
    this.canvas.removeEventListener("pointerdown", this.handlePointerDown);
    this.canvas.removeEventListener("pointermove", this.handlePointerMove);
    this.canvas.removeEventListener("pointerup", this.handlePointerUp);
    this.canvas.removeEventListener("pointercancel", this.handlePointerUp);
    this.canvas.removeEventListener("wheel", this.handleWheel);
    window.removeEventListener("keydown", this.handleKeyDown);
    window.removeEventListener("keyup", this.handleKeyUp);
    window.removeEventListener("blur", this.handleBlur);
    this.canvas.style.cursor = "";
    this.held.clear();
    this.drag = null;
  }

  private apply(always: boolean): void {
    const { position } = this.view;
    const look = lookDirection(this.view);
    const moved = always || this.camera.position.distanceToSquared(new THREE.Vector3(position.x, position.y, position.z)) > 1e-10;
    this.camera.position.set(position.x, position.y, position.z);
    this.camera.lookAt(position.x + look.x, position.y + look.y, position.z + look.z);
    if (moved || always) this.handlers.onChange(this.view);
  }

  private readonly handlePointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    this.drag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
    this.canvas.setPointerCapture?.(event.pointerId);
    this.canvas.style.cursor = "grabbing";
  };

  private readonly handlePointerMove = (event: PointerEvent): void => {
    if (!this.drag || event.pointerId !== this.drag.pointerId) return;
    const dx = event.clientX - this.drag.x;
    const dy = event.clientY - this.drag.y;
    this.drag = { ...this.drag, x: event.clientX, y: event.clientY };
    // The view follows the pointer: drag right to look left, drag up to look down.
    this.view = turn(this.view, dx * LOOK_PER_PIXEL, dy * LOOK_PER_PIXEL);
    this.apply(true);
  };

  private readonly handlePointerUp = (event: PointerEvent): void => {
    if (!this.drag || event.pointerId !== this.drag.pointerId) return;
    this.drag = null;
    this.canvas.style.cursor = "grab";
  };

  private readonly handleWheel = (event: WheelEvent): void => {
    event.preventDefault();
    this.view = walk(this.view, event.deltaY < 0 ? WHEEL_STEP : -WHEEL_STEP, 0, this.room);
    this.apply(true);
  };

  private readonly handleKeyDown = (event: KeyboardEvent): void => {
    // A key a control already handled (a menu's or a panel edge's arrows) is not walking.
    if (event.defaultPrevented || isTyping(event.target) || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === "Escape") {
      this.handlers.onExit();
      return;
    }
    if (!KEYS[event.code]) return;
    event.preventDefault();
    this.held.add(event.code);
  };

  private readonly handleKeyUp = (event: KeyboardEvent): void => {
    this.held.delete(event.code);
  };

  private readonly handleBlur = (): void => {
    this.held.clear();
  };
}
