import * as THREE from "three";

/** Where a new object should go, in world X/Z (it rests on the ground at Y - each factory's own default). */
export interface GroundPoint {
  x: number;
  z: number;
}

/** One armed placement tool: what the ribbon/palette is currently "loaded" with. */
export interface PlacementTool {
  /** Matches a RibbonTool's id (ribbonTabs.ts), so the ribbon can show which one is active. */
  id: string;
  label: string;
  /** The new object's rough footprint, for the ghost preview - world meters, before rotation. */
  ghostSize: { x: number; y: number; z: number };
  /**
   * Whether a successful placement should leave the tool armed for
   * another one, instead of returning to normal selection mode. Defaults
   * to false (single-shot) when omitted - see main.ts's armPlacement()
   * for the per-tool decision. Only Wall currently opts into true: walls
   * are naturally placed end-to-end in a run, while a pillar/door/window/
   * room/asset is normally placed once per click of its own tool.
   */
  repeat?: boolean;
  /** Executes the real construction command at the clicked ground point - the same command path a ribbon click used to run instantly. */
  place(point: GroundPoint): void;
}

export type PlacementListener = (tool: PlacementTool | null) => void;

export interface PlacementControllerOptions {
  /** The element wrapping the canvas - presses are intercepted here, in the capture phase, mirroring ManipulationController's own established pattern (see its docs). */
  container: HTMLElement;
  canvas: HTMLElement;
  camera: THREE.Camera;
  scene: THREE.Scene;
}

/** Pointer must stay within this many pixels between down/up to count as a placement click rather than an orbit/pan drag. */
const CLICK_DRAG_THRESHOLD_PX = 5;
const GROUND_PLANE = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const GHOST_COLOR = 0x4fa8ff;

function buildGhost(): THREE.Group {
  const group = new THREE.Group();
  group.visible = false;
  group.renderOrder = 999;
  return group;
}

function sizeGhost(group: THREE.Group, size: { x: number; y: number; z: number }): void {
  group.clear();
  const geometry = new THREE.BoxGeometry(Math.max(size.x, 0.05), Math.max(size.y, 0.05), Math.max(size.z, 0.05));
  const material = new THREE.MeshBasicMaterial({ color: GHOST_COLOR, transparent: true, opacity: 0.35, depthWrite: false });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.y = size.y / 2;
  const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geometry), new THREE.LineBasicMaterial({ color: GHOST_COLOR }));
  edges.position.y = size.y / 2;
  group.add(mesh, edges);
}

/**
 * Turns "a ribbon/palette tool is armed" into "clicking the viewport
 * places a real construction object there" - the pick-and-place
 * interaction. Owns no construction data itself: `PlacementTool.place()`
 * (supplied by main.ts) is what calls the shared CommandExecutor, the
 * exact same Add*Command path a ribbon click used to run instantly at a
 * fixed slot - only the position source changed, from a computed slot to
 * a clicked ground point. AI-created and placement-created objects are
 * therefore indistinguishable in every store: same factory, same
 * command, same undo history.
 *
 * A translucent ghost box previews the tool's rough footprint at the
 * hovered ground point - "where technically safe": a generic box sized
 * to the type's own default dimensions, not each type's exact mesh
 * (doors/windows cut a hole in a wall, walls draw with openings, etc. -
 * reproducing that here would duplicate real rendering logic this
 * milestone doesn't need to touch).
 *
 * Event handling mirrors ManipulationController.ts exactly: intercepted
 * on `container` in the capture phase and stopped there once a press is
 * confirmed as a genuine click (not a drag - the same 5px threshold
 * SelectionRaycaster uses), so neither OrbitControls nor click-to-select
 * ever sees a placement click; an orbit/pan drag while armed is left
 * completely alone and still orbits normally. arm() clears the current
 * selection, so a placement click can never coincide with a manipulation
 * handle/body (ManipulationController only engages when something is
 * selected) - the two systems never contend for the same click.
 */
export class PlacementController {
  private tool: PlacementTool | null = null;
  private downPosition: { x: number; y: number } | null = null;
  private readonly raycaster = new THREE.Raycaster();
  private readonly ghost: THREE.Group;
  private readonly listeners = new Set<PlacementListener>();
  private onDeselect: (() => void) | null = null;
  /** See setGhostVisible()'s own docs. */
  private ghostSuppressed = false;

  constructor(private readonly options: PlacementControllerOptions) {
    this.ghost = buildGhost();
    options.scene.add(this.ghost);

    options.container.addEventListener("pointerdown", this.handlePointerDown, { capture: true });
    options.container.addEventListener("pointerup", this.handlePointerUp, { capture: true });
    options.canvas.addEventListener("pointermove", this.handlePointerMove);
    window.addEventListener("keydown", this.handleKeyDown);
  }

  /** Called once, by main.ts, so arm() can clear the current selection without PlacementController needing a SelectionStore reference of its own. */
  setDeselectCallback(onDeselect: () => void): void {
    this.onDeselect = onDeselect;
  }

  /**
   * Loads a tool: the next click in the viewport places it. Unless
   * `tool.repeat` is true, one successful placement disarms automatically
   * and returns to normal selection mode - see handlePointerUp(). A
   * repeating tool (or one placement still pending) can always be left
   * early with disarm()/Escape/arming a different tool.
   */
  arm(tool: PlacementTool): void {
    this.tool = tool;
    this.ghostSuppressed = false; // every new placement session starts with the generic ghost, exactly as before this existed
    sizeGhost(this.ghost, tool.ghostSize);
    this.ghost.visible = false; // shown again on the first pointermove over the canvas
    this.options.canvas.style.cursor = "crosshair";
    this.onDeselect?.();
    this.emit();
  }

  disarm(): void {
    if (!this.tool) {
      return;
    }
    this.tool = null;
    this.ghostSuppressed = false;
    this.ghost.visible = false;
    this.options.canvas.style.cursor = "";
    this.emit();
  }

  isArmed(): boolean {
    return this.tool !== null;
  }

  activeToolId(): string | null {
    return this.tool?.id ?? null;
  }

  /**
   * Shows or hides the generic box ghost without altering arm/disarm/
   * click/Escape semantics - lets a richer, asset-specific preview (see
   * scene/placement/assetPlacementPreview.ts) take over the visual once
   * its own real model is ready, while this class remains the sole owner
   * of the placement state machine itself. Purely a rendering toggle: it
   * never affects isArmed()/activeToolId()/subscribers, and is reset back
   * to "visible" by every arm()/disarm() so a tool that never calls this
   * (every non-asset tool) is completely unaffected.
   */
  setGhostVisible(visible: boolean): void {
    this.ghostSuppressed = !visible;
    if (this.ghostSuppressed) {
      this.ghost.visible = false;
    }
  }

  subscribe(listener: PlacementListener): () => void {
    this.listeners.add(listener);
    listener(this.tool);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener(this.tool);
    }
  }

  private readonly handlePointerDown = (event: PointerEvent): void => {
    if (!this.tool || event.button !== 0) {
      this.downPosition = null;
      return;
    }
    this.downPosition = { x: event.clientX, y: event.clientY };
  };

  private readonly handlePointerUp = (event: PointerEvent): void => {
    if (!this.tool) {
      return;
    }
    const start = this.downPosition;
    this.downPosition = null;
    if (!start || event.target !== this.options.canvas) {
      return;
    }
    if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > CLICK_DRAG_THRESHOLD_PX) {
      return; // an orbit/pan drag, not a placement click - OrbitControls already handled it normally
    }

    const point = this.groundPointFor(event);
    if (!point) {
      return;
    }
    // A genuine placement click - keep it from OrbitControls and click-to-select, exactly like a manipulation press.
    event.stopPropagation();
    event.preventDefault();
    const tool = this.tool;
    tool.place({ x: point.x, z: point.z });
    if (!tool.repeat) {
      this.disarm();
    }
  };

  private readonly handlePointerMove = (event: PointerEvent): void => {
    if (!this.tool) {
      return;
    }
    const point = this.groundPointFor(event);
    if (point) {
      this.ghost.visible = !this.ghostSuppressed;
      this.ghost.position.set(point.x, 0, point.z);
    } else {
      this.ghost.visible = false;
    }
  };

  private readonly handleKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Escape" && this.tool) {
      this.disarm();
    }
  };

  private groundPointFor(event: PointerEvent): THREE.Vector3 | null {
    const rect = this.options.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.options.camera);
    const out = new THREE.Vector3();
    return this.raycaster.ray.intersectPlane(GROUND_PLANE, out) ? out : null;
  }
}
