import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { addLights } from "./lights";
import { addGround } from "./ground";
import { createHorizonBackground, HORIZON_FOG_COLOR } from "./environment";
import { WallLayer } from "./wall/WallLayer";
import { PillarLayer } from "./pillar/PillarLayer";
import { BeamLayer } from "./beam/BeamLayer";
import { SlabLayer } from "./slab/SlabLayer";
import { DoorLayer } from "./door/DoorLayer";
import { WindowLayer } from "./window/WindowLayer";
import { ElementLayer } from "./elements/ElementLayer";
import { AssetLayer } from "./assets/AssetLayer";
import { AssetLoader } from "./assets/AssetLoader";
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
import type { AssetStore } from "../engine/assets/AssetStore";
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
    assetStore: AssetStore,
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
    // A soft vertical gradient (see environment.ts) rather than a flat
    // fill - a lighter "horizon" band gives the viewport depth, the
    // single biggest lever on "does this look like an empty void" short
    // of a full sky/landscape (left for a later milestone) - plus a
    // matching fog so distant geometry softens into that same tone
    // instead of clipping hard at the camera's far plane.
    this.scene.background = createHorizonBackground();
    this.scene.fog = new THREE.Fog(HORIZON_FOG_COLOR, 30, 80);

    this.camera = new THREE.PerspectiveCamera(
      60,
      container.clientWidth / container.clientHeight,
      0.1,
      1000
    );
    this.camera.position.set(8, 8, 8);
    this.camera.lookAt(0, 0, 0);

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    // Capped at 2x: a real quality/perf tradeoff - uncapped device pixel
    // ratio on a 3x display quadruples fragment-shader cost for a gain
    // no one can see, and this app is judged on interaction smoothness.
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    // Soft shadows (see lights.ts's shadow-casting sun) and filmic tone
    // mapping are what actually make MeshStandardMaterial read as real
    // materials instead of flat-shaded primitives - this is the
    // renderer-level half of "materials should look like materials"
    // (the other half is resolveSurfaceAppearance() feeding each mesh's
    // material from engine/materials/materialLibrary.ts).
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true; // smoother pan/rotate/zoom feel
    this.controls.dampingFactor = 0.08;
    // Close enough to inspect a room from the inside (section 18's
    // "interior view" - no separate first-person system, just letting
    // OrbitControls get close), far enough out that "Fit House" on a
    // large project never asks for more distance than this allows.
    this.controls.minDistance = 1.2;
    this.controls.maxDistance = 80;
    // Stops just short of the horizon rather than letting the camera dip
    // underneath the ground plane and look up at the building's
    // underside - a small but real "does this feel like a professional
    // viewport" detail. Comfortably above the tightest interior angle
    // minDistance already allows.
    this.controls.maxPolarAngle = Math.PI * 0.49;

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
    const assetLoader = new AssetLoader();
    const assetLayer = new AssetLayer(this.scene, assetStore, selectionStore, visibilityStore, assetLoader);
    this.getAllMeshes = () => [
      ...wallLayer.getMeshes(),
      ...pillarLayer.getMeshes(),
      ...beamLayer.getMeshes(),
      ...slabLayer.getMeshes(),
      ...doorLayer.getMeshes(),
      ...windowLayer.getMeshes(),
      ...elementLayer.getMeshes(),
      ...assetLayer.getMeshes()
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
    selectionRaycaster.registerLayer(() => assetLayer.getMeshes());

    // Mouse manipulation of the selected object: handles render from the
    // stores like any layer, and every drag becomes update_object commands
    // through the shared CommandExecutor, one history entry per gesture.
    // See engine/manipulation/ObjectManipulator.ts. Kept alive by their
    // own listeners, like the layers above.
    const stores = { wallStore, pillarStore, beamStore, slabStore, doorStore, windowStore, elementStore, assetStore };
    const readObject = createStoreObjectReader(stores);
    const handles = new ManipulationHandles({
      scene: this.scene,
      selectionStore,
      stores: [wallStore, pillarStore, beamStore, slabStore, doorStore, windowStore, elementStore, assetStore],
      readObject,
      isHidden: (id) => visibilityStore.isHidden(id),
      subscribeVisibility: (listener) => visibilityStore.subscribe(listener)
    });
    // A small, compact readout for the gesture currently in progress
    // ("X 4.20 m   Z -1.30 m", "Length 5.80 m", "Rotation 90°") - shown
    // only while dragging, gone the instant it ends. Purely a display of
    // the same value the Properties panel already shows live during a
    // drag (confirmed by hand: dragging a wall's endpoint updates its
    // Length field in real time) - this doesn't compute or store
    // anything of its own, see ManipulationController's formatReadout().
    const readout = document.createElement("div");
    readout.className = "manipulation-readout";
    readout.hidden = true;
    container.appendChild(readout);

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
        ...elementLayer.getMeshes(),
        ...assetLayer.getMeshes()
      ],
      readObject,
      onReadout: (text) => {
        readout.hidden = text === null;
        readout.textContent = text ?? "";
      },
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
