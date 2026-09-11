import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { addLights } from "./lights";
import { addGround } from "./ground";
import { WallLayer } from "./wall/WallLayer";
import { PillarLayer } from "./pillar/PillarLayer";
import { BeamLayer } from "./beam/BeamLayer";
import { SlabLayer } from "./slab/SlabLayer";
import { DoorLayer } from "./door/DoorLayer";
import { WindowLayer } from "./window/WindowLayer";
import { ElementLayer } from "./elements/ElementLayer";
import { SelectionRaycaster } from "./SelectionRaycaster";
import { ManipulationHandles } from "./manipulation/ManipulationHandles";
import { ManipulationController } from "./manipulation/ManipulationController";
import { ObjectManipulator, createStoreObjectReader } from "../engine/manipulation/ObjectManipulator";
import type { ManipulationHistory } from "../engine/manipulation/ObjectManipulator";
import { createStoreSnapper } from "../engine/snapping/storeSnapper";
import type { SnapSettings } from "../engine/snapping/SnapSettings";
import type { VisibilityStore } from "./visibility/VisibilityStore";
import { PlacementController } from "./placement/PlacementController";
import { computeFitCamera } from "./camera/fitCamera";
import type { CommandResult } from "../engine/commands/types";
import type { WallStore } from "../engine/wall/WallStore";
import type { PillarStore } from "../engine/pillar/PillarStore";
import type { BeamStore } from "../engine/beam/BeamStore";
import type { SlabStore } from "../engine/slab/SlabStore";
import type { DoorStore } from "../engine/door/DoorStore";
import type { WindowStore } from "../engine/window/WindowStore";
import type { ElementStore } from "../engine/elements/ElementStore";
import type { SelectionStore } from "../engine/selection/SelectionStore";

/** Camera view presets the UI's view-control buttons can request. */
export type ViewPreset = "perspective" | "top" | "front" | "side";

const VIEW_CAMERA_POSITIONS: Record<ViewPreset, THREE.Vector3Tuple> = {
  perspective: [8, 8, 8],
  top: [0, 14, 0.01], // tiny Z offset avoids OrbitControls gimbal lock looking straight down
  front: [0, 4, 14],
  side: [14, 4, 0]
};

/**
 * Owns the Three.js scene, camera, renderer and controls for the
 * 3D workspace. Purely a rendering/viewport concern - construction
 * *data* logic (walls, bricks, dimensions, etc.) belongs in src/engine.
 * Rendering of construction objects is delegated to dedicated layers
 * (WallLayer, PillarLayer, BeamLayer, SlabLayer, DoorLayer,
 * WindowLayer, and ElementLayer for every catalog element kind) rather
 * than inlined here, so this class stays a general-purpose scene host.
 * Click-to-select is likewise delegated to one shared SelectionRaycaster
 * spanning every layer.
 */
export class SceneManager {
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly controls: OrbitControls;
  private readonly container: HTMLElement;
  /** The pick-and-place interaction - armed by ribbon/palette tools (main.ts), placing through the same CommandExecutor every other path uses. */
  readonly placementController: PlacementController;
  private readonly getAllMeshes: () => THREE.Object3D[];

  constructor(
    container: HTMLElement,
    wallStore: WallStore,
    pillarStore: PillarStore,
    beamStore: BeamStore,
    slabStore: SlabStore,
    doorStore: DoorStore,
    windowStore: WindowStore,
    elementStore: ElementStore,
    selectionStore: SelectionStore,
    /** The shared CommandExecutor and HistoryManager - mouse manipulation edits the model only through these. */
    commandExecutor: { execute(input: unknown): CommandResult },
    history: ManipulationHistory,
    /** Whether drags snap - see engine/snapping/. */
    snapSettings: SnapSettings,
    /** Which construction objects are hidden right now - constructed once in main.ts (shared with the left sidebar's visibility controls), not owned by this class. See VisibilityStore's own docs. */
    visibilityStore: VisibilityStore
  ) {
    this.container = container;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x1a1a1a);

    this.camera = new THREE.PerspectiveCamera(
      60,
      container.clientWidth / container.clientHeight,
      0.1,
      1000
    );
    this.camera.position.set(8, 8, 8);
    this.camera.lookAt(0, 0, 0);

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    container.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true; // smoother pan/rotate/zoom feel

    addLights(this.scene);
    addGround(this.scene);

    // Not stored on `this`: every *Layer stays alive via the
    // subscriptions it registers with its store/selectionStore/
    // visibilityStore, which outlive this constructor.
    // Walls also follow the door and window stores: they're drawn with a hole for each hosted opening.
    const wallLayer = new WallLayer(this.scene, wallStore, doorStore, windowStore, selectionStore, visibilityStore);
    const pillarLayer = new PillarLayer(this.scene, pillarStore, selectionStore, visibilityStore);
    const beamLayer = new BeamLayer(this.scene, beamStore, selectionStore, visibilityStore);
    const slabLayer = new SlabLayer(this.scene, slabStore, selectionStore, visibilityStore);
    const doorLayer = new DoorLayer(this.scene, doorStore, selectionStore, visibilityStore);
    const windowLayer = new WindowLayer(this.scene, windowStore, selectionStore, visibilityStore);
    const elementLayer = new ElementLayer(this.scene, elementStore, selectionStore, visibilityStore);
    this.getAllMeshes = () => [
      ...wallLayer.getMeshes(),
      ...pillarLayer.getMeshes(),
      ...beamLayer.getMeshes(),
      ...slabLayer.getMeshes(),
      ...doorLayer.getMeshes(),
      ...windowLayer.getMeshes(),
      ...elementLayer.getMeshes()
    ];

    // One shared raycaster combines every layer's meshes into a single
    // click handler - see SelectionRaycaster.ts for why independent
    // per-layer raycasters would race each other.
    const selectionRaycaster = new SelectionRaycaster(this.camera, this.renderer.domElement, selectionStore);
    selectionRaycaster.registerLayer(() => wallLayer.getMeshes());
    selectionRaycaster.registerLayer(() => pillarLayer.getMeshes());
    selectionRaycaster.registerLayer(() => beamLayer.getMeshes());
    selectionRaycaster.registerLayer(() => slabLayer.getMeshes());
    selectionRaycaster.registerLayer(() => doorLayer.getMeshes());
    selectionRaycaster.registerLayer(() => windowLayer.getMeshes());
    selectionRaycaster.registerLayer(() => elementLayer.getMeshes());

    // Mouse manipulation of the selected object: handles render from the
    // stores like any layer, and every drag becomes update_object commands
    // through the shared CommandExecutor, one history entry per gesture.
    // See engine/manipulation/ObjectManipulator.ts. Kept alive by their
    // own listeners, like the layers above.
    const stores = { wallStore, pillarStore, beamStore, slabStore, doorStore, windowStore, elementStore };
    const readObject = createStoreObjectReader(stores);
    const handles = new ManipulationHandles({
      scene: this.scene,
      selectionStore,
      stores: [wallStore, pillarStore, beamStore, slabStore, doorStore, windowStore, elementStore],
      readObject
    });
    new ManipulationController({
      container,
      canvas: this.renderer.domElement,
      camera: this.camera,
      selection: selectionStore,
      handles,
      getObjectMeshes: () => [
        ...wallLayer.getMeshes(),
        ...pillarLayer.getMeshes(),
        ...beamLayer.getMeshes(),
        ...slabLayer.getMeshes(),
        ...doorLayer.getMeshes(),
        ...windowLayer.getMeshes(),
        ...elementLayer.getMeshes()
      ],
      manipulator: new ObjectManipulator({
        commandExecutor,
        history,
        readObject,
        // Endpoints, corners, centers, alignment, the grid, wall faces - see engine/snapping/.
        snapper: createStoreSnapper(stores, snapSettings)
      })
    });

    // Pick-and-place: armed by ribbon/palette tools (main.ts). Constructed
    // last so its capture-phase listeners on `container` register after
    // ManipulationController's - see PlacementController's own docs for
    // why the two never contend for the same click regardless of order
    // (arm() always deselects first).
    this.placementController = new PlacementController({ container, canvas: this.renderer.domElement, camera: this.camera, scene: this.scene });
    this.placementController.setDeselectCallback(() => selectionStore.clear());

    window.addEventListener("resize", this.handleResize);
  }

  private readonly handleResize = (): void => {
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;

    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
  };

  /** Moves the camera to a named preset view, keeping the origin as the look-at target. */
  setView(preset: ViewPreset): void {
    const [x, y, z] = VIEW_CAMERA_POSITIONS[preset];
    this.camera.position.set(x, y, z);
    this.controls.target.set(0, 0, 0);
    this.camera.lookAt(0, 0, 0);
    this.controls.update();
  }

  /**
   * Frames every VISIBLE construction object ("Fit House"). Objects
   * hidden through visibilityStore don't count toward the frame - fitting
   * with something hidden frames only what's actually shown. A no-op
   * when nothing is visible (an empty project, or everything hidden) -
   * the camera is left exactly where it was rather than jumping
   * somewhere arbitrary.
   */
  fitToScene(): void {
    this.applyFit(this.boundingBoxOf(null));
  }

  /**
   * Frames exactly the given object ids ("Focus Selected"/"Focus Room"),
   * still skipping any that are currently hidden. A no-op if none of the
   * given ids currently has a visible mesh.
   */
  focusOn(objectIds: readonly string[]): void {
    if (objectIds.length === 0) {
      return;
    }
    this.applyFit(this.boundingBoxOf(new Set(objectIds)));
  }

  /** The union bounding box of every visible mesh, optionally restricted to `ids`; null when nothing qualifies. */
  private boundingBoxOf(ids: ReadonlySet<string> | null): THREE.Box3 | null {
    const box = new THREE.Box3();
    let found = false;
    for (const mesh of this.getAllMeshes()) {
      if (!mesh.visible) {
        continue;
      }
      const objectId = mesh.userData.objectId as string | undefined;
      if (ids && (!objectId || !ids.has(objectId))) {
        continue;
      }
      box.expandByObject(mesh);
      found = true;
    }
    return found ? box : null;
  }

  /** Keeps the camera's current viewing angle, moving only its distance and look-at target to frame `box`. */
  private applyFit(box: THREE.Box3 | null): void {
    if (!box) {
      return;
    }
    const direction = this.camera.position.clone().sub(this.controls.target);
    const { position, target } = computeFitCamera(box, direction, { fovDegrees: this.camera.fov });
    this.camera.position.copy(position);
    this.controls.target.copy(target);
    this.camera.lookAt(target);
    this.controls.update();
  }

  start(): void {
    const animate = (): void => {
      requestAnimationFrame(animate);
      this.controls.update(); // required when damping is enabled
      this.renderer.render(this.scene, this.camera);
    };
    animate();
  }
}
