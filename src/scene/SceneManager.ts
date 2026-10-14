import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { GTAOPass } from "three/examples/jsm/postprocessing/GTAOPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { addLights } from "./lights";
import { addGround } from "./ground";
import type { GroundHandle } from "./ground";
import { SCENE_PALETTES } from "./sceneTheme";
import { createCoordinateOverlay, type CoordinateOverlay } from "./coordinateOverlay";
import { createDimensionLayer, type DimensionLayer } from "./dimensionLayer";
import type { ViewportSize } from "./labelSprite";

/** Interior Explore's lens, degrees (vertical) - wide enough to take in a room from one corner. */
const INTERIOR_FOV = 70;

/** The fog's nearest start and end, metres - pushed further out as the camera backs away (see start()). */
const FOG_NEAR = 30;
const FOG_FAR = 80;
import { metresPerPixelAt } from "../engine/workspace/scaleBar";
import type { WorkspaceState } from "../engine/workspace/workspaceSettings";
import type { Theme } from "../ui/theme";
import { createHorizonBackground, HORIZON_FOG_COLOR } from "./environment";
import { WallLayer } from "./wall/WallLayer";
import { PillarLayer } from "./pillar/PillarLayer";
import { BeamLayer } from "./beam/BeamLayer";
import { SlabLayer } from "./slab/SlabLayer";
import { DoorLayer } from "./door/DoorLayer";
import { WindowLayer } from "./window/WindowLayer";
import { ElementLayer } from "./elements/ElementLayer";
import { FittingLayer } from "./elements/FittingLayer";
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
import { computeArchitecturalFit, withMinimumExtent } from "./camera/fitCamera";
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
import { InteriorCamera } from "./interior/InteriorCamera";
import type { InteriorCameraHandlers } from "./interior/InteriorCamera";
import type { InteriorRoom, InteriorViewpoint } from "../engine/interior/interiorExplore";

/** The smallest area "Fit House" frames, in metres - about a small plot (the fit itself is exact, so this is the visible area, not a fudge). */
const MIN_FIT_EXTENT = { x: 11, y: 3, z: 11 };
/** The smallest area "Focus" frames - enough to see an element in place. */
const MIN_FOCUS_EXTENT = { x: 7, y: 2.5, z: 7 };

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
  /**
   * The post-processing pipeline (Phase 3A: RenderPass -> GTAOPass ->
   * OutputPass) - null when it couldn't be set up (see the constructor's
   * try/catch) or has since failed at runtime, in which case start()
   * falls back to the plain renderer.render() call every previous
   * milestone used. Never required for the viewport to work; purely an
   * additive visual layer over the same scene/camera.
   */
  private composer: EffectComposer | null = null;
  private gtaoPass: GTAOPass | null = null;
  /** The pick-and-place interaction - armed by ribbon/palette tools (main.ts), placing through the same CommandExecutor every other path uses. */
  readonly placementController: PlacementController;
  private readonly getAllMeshes: () => THREE.Object3D[];
  /**
   * The Construction Method panel's temporary highlight (see
   * highlightConstructionObjects() below): every mesh currently tinted
   * away from its real material color, paired with that real color so it
   * can be restored exactly - never a second, permanent copy of project
   * data, and never written back to any store.
   */
  private readonly highlightedMeshes = new Map<THREE.Mesh, THREE.Color>();
  private readonly ground: GroundHandle;
  private theme: Theme = "light";
  /** The X/Y/Z axes and origin marker, and the room/wall dimension labels - view guides, never model objects. */
  private readonly axes: CoordinateOverlay;
  private readonly dimensions: DimensionLayer;
  private readonly dimensionListeners = new Set<(summary: string) => void>();
  /** Picking and dragging - paused while Interior Explore walks the camera. */
  private readonly selectionRaycaster: SelectionRaycaster;
  private readonly manipulation: ManipulationController;
  /** Interior Explore, while it is on: its camera, and the exterior view to return to. */
  private interior: { camera: InteriorCamera; saved: { position: THREE.Vector3; target: THREE.Vector3; fov: number } } | null = null;
  /** The workspace's view settings, re-applied when Interior Explore ends. */
  private workspaceState: WorkspaceState | null = null;
  private lastFrame = 0;
  private readonly viewListeners = new Set<(metresPerPixel: number) => void>();
  private readonly frameListeners = new Set<(camera: THREE.PerspectiveCamera, viewport: ViewportSize) => void>();

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
    this.scene.fog = new THREE.Fog(HORIZON_FOG_COLOR, FOG_NEAR, FOG_FAR);

    this.camera = new THREE.PerspectiveCamera(
      45,
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

    // Phase 3A: a light ambient-occlusion pass over the exact same
    // renderer/scene/camera above - never a second scene, never a
    // replacement renderer. RenderPass renders the scene into an
    // offscreen (linear, untonemapped - three.js skips tone mapping and
    // sRGB encoding for any non-null render target) buffer; GTAOPass
    // reads it, multiplies in a contact-occlusion term computed from its
    // own depth/normal pass, and writes the result onward; OutputPass is
    // what actually applies the renderer's ACES tone mapping and sRGB
    // output encoding, since that only happens when the target is the
    // screen (null) - skipping it would send raw linear values to the
    // canvas. Wrapped in try/catch: if this fails to construct for any
    // reason (an old/limited WebGL context, say), the viewport falls
    // back to the exact rendering every previous milestone used - see
    // start() and handleResize() below.
    try {
      const composer = new EffectComposer(this.renderer);
      composer.addPass(new RenderPass(this.scene, this.camera));

      const gtaoPass = new GTAOPass(this.scene, this.camera, container.clientWidth, container.clientHeight);
      gtaoPass.output = GTAOPass.OUTPUT.Default;
      // Kept deliberately restrained (task: "modest AO intensity...no
      // exaggerated black creases") - a subtle contact cue at wall/floor
      // and object/floor junctions, not a stylized AO look. blendIntensity
      // is GTAOPass's own overall-strength knob (default 1); radius is in
      // the SAME world-space meters every other measurement in this app
      // uses (the shader's own default, 0.25m, already suits this scale -
      // nudged slightly up here for a touch more presence at floor level).
      gtaoPass.blendIntensity = 0.75;
      gtaoPass.updateGtaoMaterial({ radius: 0.3, samples: 16 });
      // Presentation-only marks (labels, translucent previews) flagged
      // userData.excludeFromAO stay out of the AO depth/normal pass, as
      // GTAOPass already does for lines and points - otherwise every label
      // sprite casts a dark occlusion halo onto the ground behind it.
      // restoreVisibility() puts back what this hid (it caches first).
      const hideLinesAndPoints = gtaoPass.overrideVisibility.bind(gtaoPass);
      gtaoPass.overrideVisibility = () => {
        hideLinesAndPoints();
        this.scene.traverse((object) => {
          if (object.userData.excludeFromAO) object.visible = false;
        });
      };
      composer.addPass(gtaoPass);
      composer.addPass(new OutputPass());

      this.composer = composer;
      this.gtaoPass = gtaoPass;
      this.resizeGtaoPass(container.clientWidth, container.clientHeight);
    } catch (error) {
      console.warn("SceneManager: ambient-occlusion pipeline unavailable, rendering without it.", error);
      this.composer = null;
      this.gtaoPass = null;
    }

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true; // smoother pan/rotate/zoom feel
    this.controls.dampingFactor = 0.08;
    // Close enough to inspect a room from the inside (section 18's
    // "interior view" - no separate first-person system, just letting
    // OrbitControls get close), far enough out that "Fit House" on a
    // large project never asks for more distance than this allows. 0.3 m
    // lets a pipe fitting (a few centimetres across) be inspected up close.
    this.controls.minDistance = 0.3;
    this.controls.maxDistance = 80;
    // Stops just short of the horizon rather than letting the camera dip
    // underneath the ground plane and look up at the building's
    // underside - a small but real "does this feel like a professional
    // viewport" detail. Comfortably above the tightest interior angle
    // minDistance already allows.
    this.controls.maxPolarAngle = Math.PI * 0.49;
    // The scale bar follows every orbit, pan and zoom.
    this.controls.addEventListener("change", this.notifyView);

    addLights(this.scene);
    this.ground = addGround(this.scene);
    // The coordinate system, drawn - the same X (east) / Y (up) / Z (south) the inspector, record book and conversation use.
    this.axes = createCoordinateOverlay(this.scene, SCENE_PALETTES[this.theme]);
    this.dimensions = createDimensionLayer(this.scene, { wallStore, elementStore, visibilityStore }, SCENE_PALETTES[this.theme], (summary) => {
      for (const listener of this.dimensionListeners) listener(summary);
    });

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
    // Pipe fittings, worked out from the pipes' connections. A click on one selects the visible pipe whose leg it's on.
    const fittingLayer = new FittingLayer(this.scene, elementStore, visibilityStore);
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
      ...fittingLayer.getMeshes(),
      ...assetLayer.getMeshes()
    ];

    // One shared raycaster combines every layer's meshes into a single
    // click handler - see SelectionRaycaster.ts for why independent
    // per-layer raycasters would race each other.
    const selectionRaycaster = new SelectionRaycaster(this.camera, this.renderer.domElement, selectionStore);
    this.selectionRaycaster = selectionRaycaster;
    selectionRaycaster.registerLayer(() => wallLayer.getMeshes());
    selectionRaycaster.registerLayer(() => pillarLayer.getMeshes());
    selectionRaycaster.registerLayer(() => beamLayer.getMeshes());
    selectionRaycaster.registerLayer(() => slabLayer.getMeshes());
    selectionRaycaster.registerLayer(() => doorLayer.getMeshes());
    selectionRaycaster.registerLayer(() => windowLayer.getMeshes());
    selectionRaycaster.registerLayer(() => elementLayer.getMeshes());
    selectionRaycaster.registerLayer(() => fittingLayer.getMeshes());
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

    this.manipulation = new ManipulationController({
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
        snapper: createStoreSnapper(stores, snapSettings),
        // Drags move in the workspace's snap step while snapping is on; finely (1 cm) while it's off.
        moveStep: () => (snapSettings.isEnabled() ? snapSettings.getStep() : 0.01)
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
    // The workspace's panels open, close and resize without the window
    // changing: follow the viewport's own box too, so the canvas and the
    // camera's aspect always match it.
    if (typeof ResizeObserver !== "undefined") {
      let lastSize = "";
      new ResizeObserver(() => {
        const size = `${container.clientWidth}x${container.clientHeight}`;
        if (size === lastSize) return;
        lastSize = size;
        this.handleResize();
      }).observe(container);
    }
  }

  /** Pixels of the viewport's left edge covered by a floating panel (the AI Architect copilot) - see setOverlayInset. */
  private overlayInset = 0;

  /**
   * A floating panel covers `px` of the viewport's left edge: shift the
   * projection so the scene's centre sits in the middle of the UNCOVERED
   * area (and fits use that area's width) - instead of framing the house
   * behind the panel. Picking stays exact: the raycaster uses the same
   * projection. 0 restores the normal, centred projection.
   */
  setOverlayInset(px: number): void {
    const inset = Math.max(0, Math.round(px));
    if (inset === this.overlayInset) return;
    this.overlayInset = inset;
    this.applyProjection();
  }

  /** The width/height of the part of the viewport no panel covers. */
  private visibleAspect(): number {
    const width = this.container.clientWidth;
    const height = Math.max(1, this.container.clientHeight);
    const inset = this.effectiveInset(width);
    return Math.max(1, width - inset) / height;
  }

  private effectiveInset(width: number): number {
    // A panel covering most of a narrow viewport isn't worth offsetting for.
    return this.overlayInset > 0 && this.overlayInset < width * 0.6 ? this.overlayInset : 0;
  }

  private applyProjection(): void {
    const width = this.container.clientWidth;
    const height = Math.max(1, this.container.clientHeight);
    const inset = this.effectiveInset(width);
    if (inset > 0) {
      // A virtual image `inset` px wider than the canvas, centred on the camera
      // axis; the canvas shows its left `width` px - so the axis lands in the
      // middle of the uncovered part.
      this.camera.aspect = (width + inset) / height;
      this.camera.setViewOffset(width + inset, height, 0, 0, width, height);
    } else {
      this.camera.aspect = width / height;
      this.camera.clearViewOffset();
    }
    this.camera.updateProjectionMatrix();
  }

  private readonly handleResize = (): void => {
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;

    this.applyProjection();
    this.renderer.setSize(width, height);
    // The composer's own render targets must track the renderer's size
    // exactly like this.renderer.setSize() above - composer.setSize()
    // also resizes every pass it holds (including gtaoPass) to that same
    // full size, so the half-resolution AO override below has to be
    // re-applied every time, not just at construction.
    this.composer?.setSize(width, height);
    this.resizeGtaoPass(width, height);
    this.notifyView();
  };

  /**
   * Runs the AO pass's own depth/normal/occlusion computation at half the
   * viewport's actual pixel size (task: "reduced/half-resolution AO") -
   * the one deliberately-cheap corner of this pipeline, since GTAOPass's
   * own three internal render targets are the only per-frame cost this
   * milestone adds. The blend step still samples this smaller buffer
   * across the full-resolution frame, which is exactly the point: a
   * quarter of the pixels to shade for an effect that's meant to read as
   * a soft, low-frequency contact cue, not a sharp one.
   */
  private resizeGtaoPass(width: number, height: number): void {
    if (!this.gtaoPass) {
      return;
    }
    const pixelRatio = this.renderer.getPixelRatio();
    const aoWidth = Math.max(1, Math.round((width * pixelRatio) / 2));
    const aoHeight = Math.max(1, Math.round((height * pixelRatio) / 2));
    this.gtaoPass.setSize(aoWidth, aoHeight);
  }

  /**
   * A read-only handle on this viewport's real scene/camera/canvas - for a
   * small, additive presentation layer outside this class that must
   * render into the same world and track the same cursor-to-ground
   * convention as the rest of the viewport (the asset placement preview,
   * Phase 5A - see scene/placement/assetPlacementPreview.ts). Deliberately
   * the only thing this class exposes beyond its existing named actions
   * (setView/fitToScene/focusOn): construction data still only ever
   * changes through CommandExecutor, never through this reference.
   */
  getViewportContext(): { scene: THREE.Scene; camera: THREE.Camera; canvas: HTMLCanvasElement } {
    return { scene: this.scene, camera: this.camera, canvas: this.renderer.domElement };
  }

  /** Moves the camera to a named preset view, keeping the origin as the look-at target. */
  setView(preset: ViewPreset): void {
    if (this.interior) return; // Interior Explore holds the camera in its room; leave it first
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
    if (this.interior) return; // Interior Explore holds the camera in its room; leave it first
    const box = this.boundingBoxOf(null);
    // At least a typical plot's extent, so one wall or a first room is seen in context, not filling the screen.
    this.applyFit(box ? withMinimumExtent(box, MIN_FIT_EXTENT) : null);
  }

  /**
   * Frames exactly the given object ids ("Focus Selected"/"Focus Room"),
   * still skipping any that are currently hidden. A no-op if none of the
   * given ids currently has a visible mesh.
   */
  focusOn(objectIds: readonly string[]): void {
    if (this.interior) return; // Interior Explore holds the camera in its room; leave it first
    if (objectIds.length === 0) {
      return;
    }
    const box = this.boundingBoxOf(new Set(objectIds));
    // A small minimum, so a newly built wall is framed with some of its surroundings rather than filling the screen.
    this.applyFit(box ? withMinimumExtent(box, MIN_FOCUS_EXTENT) : null);
  }

  /**
   * Frames a region that isn't (yet) an object - the architect's preview
   * of a room or wall before it is built - with a margin of `margin`
   * metres around it so its neighbours stay in view. Camera only.
   */
  focusOnRegion(region: { center: { x: number; z: number }; sizeX: number; sizeZ: number; height: number }, margin = 2, minimum: { x: number; y: number; z: number } = MIN_FOCUS_EXTENT): void {
    if (this.interior) return; // Interior Explore holds the camera in its room; leave it first
    const { center, sizeX, sizeZ, height } = region;
    const framed = new THREE.Box3(
      new THREE.Vector3(center.x - sizeX / 2 - margin, 0, center.z - sizeZ / 2 - margin),
      new THREE.Vector3(center.x + sizeX / 2 + margin, height, center.z + sizeZ / 2 + margin)
    );
    this.applyFit(withMinimumExtent(framed, minimum));
  }

  /**
   * A close-up of one point - a pipe fitting at its joint, which is a few
   * centimetres across and invisible at house scale. Camera only.
   */
  focusOnPoint(point: { x: number; y: number; z: number }, extent = 0.25): void {
    if (this.interior) return; // Interior Explore holds the camera in its room; leave it first
    const half = extent / 2;
    // No ground clamp: a joint can be below ground (an under-slab drain), and the box must stay around it.
    const box = new THREE.Box3(new THREE.Vector3(point.x - half, point.y - half, point.z - half), new THREE.Vector3(point.x + half, point.y + half, point.z + half));
    this.applyFit(box, this.controls.minDistance);
  }

  /**
   * The Construction Method panel's step highlight (task: "selecting a
   * step must highlight its linked objects... the rest kept visible but
   * subdued... do NOT permanently modify object materials... do NOT
   * alter saved project data"). Every mesh (across every layer, via the
   * same getAllMeshes() closure focusOn() uses) is matched to `objectIds`
   * by its own `userData.objectId` - the same field every layer already
   * tags every selectable part with. `null` restores every mesh to its
   * real material color and highlights nothing (the panel's "Show All").
   *
   * Safe to mutate `material.color` directly and restore it afterwards
   * because every mesh this app builds gets its OWN material instance
   * (see buildWallMesh.ts/buildElementMesh.ts/AssetLoader.ts's per-instance
   * material cloning) - never one shared across multiple objects, so
   * tinting one object's meshes can never bleed into another's.
   *
   * Returns how many of the requested ids were actually found on a real
   * mesh (`resolved`) versus not (`unresolved`) - the caller shows the
   * step normally either way and only reports the unresolved count,
   * rather than throwing (task section 6).
   */
  /**
   * The workspace theme's viewport: the backdrop, fog, ground and grid
   * (scene/sceneTheme.ts). Construction objects keep their own colours.
   */
  setTheme(theme: Theme): void {
    if (theme === this.theme) return;
    this.theme = theme;
    const palette = SCENE_PALETTES[theme];
    const previous = this.scene.background;
    this.scene.background = createHorizonBackground(palette);
    if (previous instanceof THREE.Texture) previous.dispose();
    if (this.scene.fog instanceof THREE.Fog) this.scene.fog.color.setHex(palette.fog);
    this.ground.setPalette(palette);
    this.axes.setPalette(palette);
    this.dimensions.setPalette(palette);
  }

  /** The workspace's view settings (engine/workspace/workspaceSettings.ts): grid spacing, axes, dimension labels. Snapping goes through SnapSettings. */
  setWorkspace(state: WorkspaceState): void {
    this.workspaceState = state;
    this.ground.setSpacing(state.gridSpacing);
    // Inside a room the axes and labels would only clutter the view (and draw through walls).
    this.axes.setVisible(state.showAxes && !this.interior);
    this.dimensions.setVisible(state.showDimensions && !this.interior);
  }

  /**
   * Interior Explore: the camera stands in `room` at `view` (a person's eye
   * height) - on the first call the exterior view is remembered, OrbitControls,
   * picking and dragging pause, the axes and labels hide and the lens widens.
   * Later calls move to another room (or back to a room's starting view). A
   * view only: nothing here touches the model.
   */
  enterInterior(room: InteriorRoom, view: InteriorViewpoint, handlers: InteriorCameraHandlers): void {
    if (this.interior) {
      this.interior.camera.setRoom(room, view);
      return;
    }
    const saved = { position: this.camera.position.clone(), target: this.controls.target.clone(), fov: this.camera.fov };
    this.controls.enabled = false;
    this.selectionRaycaster.setEnabled(false);
    this.manipulation.setEnabled(false);
    this.axes.setVisible(false);
    this.dimensions.setVisible(false);
    this.camera.fov = INTERIOR_FOV;
    this.camera.updateProjectionMatrix();
    this.interior = { camera: new InteriorCamera(this.camera, this.renderer.domElement, room, view, handlers), saved };
  }

  /** Whether Interior Explore is on. */
  isInteriorActive(): boolean {
    return this.interior !== null;
  }

  /** Back to the exterior view exactly as it was, with orbiting, picking, dragging, axes and labels restored. */
  exitInterior(): void {
    if (!this.interior) return;
    const { camera, saved } = this.interior;
    camera.dispose();
    this.interior = null;
    this.camera.fov = saved.fov;
    this.camera.updateProjectionMatrix();
    this.camera.position.copy(saved.position);
    this.controls.target.copy(saved.target);
    this.camera.lookAt(saved.target);
    this.controls.enabled = true;
    this.controls.update();
    this.selectionRaycaster.setEnabled(true);
    this.manipulation.setEnabled(true);
    if (this.workspaceState) {
      this.setWorkspace(this.workspaceState);
    } else {
      this.axes.setVisible(true);
      this.dimensions.setVisible(true);
    }
    this.notifyView();
  }

  /** What the dimension labels show, in words ("Dimensions shown: 1 room, 4 walls.") - now and on every change. Returns an unsubscribe. */
  onDimensionSummary(listener: (summary: string) => void): () => void {
    this.dimensionListeners.add(listener);
    listener(this.dimensions.summary());
    return () => this.dimensionListeners.delete(listener);
  }

  /** Called every frame before it is drawn, with the camera and the viewport's size in pixels - for overlays that size their labels to the zoom (the plot's). Returns an unsubscribe. */
  onFrame(listener: (camera: THREE.PerspectiveCamera, viewport: ViewportSize) => void): () => void {
    this.frameListeners.add(listener);
    return () => this.frameListeners.delete(listener);
  }

  /** Metres per screen pixel at the camera's look-at point - now and whenever the view moves, zooms or resizes. For the scale bar. */
  onViewChange(listener: (metresPerPixel: number) => void): () => void {
    this.viewListeners.add(listener);
    listener(this.metresPerPixel());
    return () => this.viewListeners.delete(listener);
  }

  private metresPerPixel(): number {
    return metresPerPixelAt(this.camera.position.distanceTo(this.controls.target), this.camera.fov, this.container.clientHeight);
  }

  private readonly notifyView = (): void => {
    if (this.viewListeners.size === 0) return;
    const value = this.metresPerPixel();
    for (const listener of this.viewListeners) listener(value);
  };

  /** The viewport's current theme. */
  getTheme(): Theme {
    return this.theme;
  }

  highlightConstructionObjects(objectIds: readonly string[] | null): { resolved: number; unresolved: number } {
    for (const [mesh, color] of this.highlightedMeshes) {
      (mesh.material as THREE.MeshStandardMaterial).color.copy(color);
    }
    this.highlightedMeshes.clear();

    if (!objectIds || objectIds.length === 0) {
      return { resolved: 0, unresolved: objectIds?.length ?? 0 };
    }

    const wanted = new Set(objectIds);
    const resolved = new Set<string>();
    const HIGHLIGHT_TINT = new THREE.Color(0xffb703);

    for (const object of this.getAllMeshes()) {
      const mesh = object as THREE.Mesh;
      const material = mesh.material as THREE.MeshStandardMaterial | undefined;
      const objectId = mesh.userData.objectId as string | undefined;
      if (!material || !("color" in material) || !objectId) {
        continue;
      }
      this.highlightedMeshes.set(mesh, material.color.clone());
      if (wanted.has(objectId)) {
        resolved.add(objectId);
        material.color.lerp(HIGHLIGHT_TINT, 0.6);
      } else {
        material.color.multiplyScalar(0.3);
      }
    }

    return { resolved: resolved.size, unresolved: objectIds.length - resolved.size };
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
  private applyFit(box: THREE.Box3 | null, minDistance?: number): void {
    if (!box) {
      return;
    }
    const direction = this.camera.position.clone().sub(this.controls.target);
    const { position, target } = computeArchitecturalFit(box, direction, { fovDegrees: this.camera.fov, aspect: this.visibleAspect(), ...(minDistance !== undefined ? { minDistance } : {}) });
    this.camera.position.copy(position);
    this.controls.target.copy(target);
    this.camera.lookAt(target);
    this.controls.update();
  }

  start(): void {
    const animate = (): void => {
      requestAnimationFrame(animate);
      const now = performance.now();
      const seconds = this.lastFrame ? (now - this.lastFrame) / 1000 : 0;
      this.lastFrame = now;
      // Interior Explore walks the camera itself; otherwise OrbitControls (required every frame when damping is enabled).
      if (this.interior) this.interior.camera.update(seconds);
      else this.controls.update();
      // The fog starts beyond whatever is being looked at - a whole plot framed
      // from 60 m away stays crisp - while the far ground still fades out.
      if (this.scene.fog instanceof THREE.Fog) {
        const distance = this.camera.position.distanceTo(this.controls.target);
        this.scene.fog.near = Math.max(FOG_NEAR, distance * 1.6);
        this.scene.fog.far = Math.max(FOG_FAR, distance * 4.5);
      }
      // Labels keep a readable size at any zoom, and don't pile up (labelSprite.ts fitLabels).
      this.camera.updateMatrixWorld();
      const viewport = { width: this.container.clientWidth, height: this.container.clientHeight };
      this.axes.update(this.camera, viewport);
      this.dimensions.update(this.camera, viewport);
      for (const listener of this.frameListeners) listener(this.camera, viewport);
      if (this.composer) {
        try {
          this.composer.render();
          return;
        } catch (error) {
          // A runtime failure (rare - a lost/degraded WebGL context, say)
          // disables the composer permanently rather than erroring every
          // frame; the very same renderer.render() call every previous
          // milestone used takes over immediately below, so the viewport
          // keeps working with plain shadows/lighting instead of breaking.
          console.warn("SceneManager: ambient-occlusion pipeline failed at runtime, disabling it.", error);
          this.composer = null;
          this.gtaoPass = null;
        }
      }
      this.renderer.render(this.scene, this.camera);
    };
    animate();
  }
}
