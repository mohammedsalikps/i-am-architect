import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { addLights } from "./lights";
import { addGround } from "./ground";
import { WallLayer } from "./wall/WallLayer";
import { PillarLayer } from "./pillar/PillarLayer";
import { BeamLayer } from "./beam/BeamLayer";
import { SlabLayer } from "./slab/SlabLayer";
import { SelectionRaycaster } from "./SelectionRaycaster";
import type { WallStore } from "../engine/wall/WallStore";
import type { PillarStore } from "../engine/pillar/PillarStore";
import type { BeamStore } from "../engine/beam/BeamStore";
import type { SlabStore } from "../engine/slab/SlabStore";
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
 * (WallLayer, PillarLayer, BeamLayer, SlabLayer, ...) rather than
 * inlined here, so this class stays a general-purpose scene host.
 * Click-to-select is likewise delegated to one shared
 * SelectionRaycaster spanning every layer.
 */
export class SceneManager {
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly controls: OrbitControls;
  private readonly container: HTMLElement;

  constructor(
    container: HTMLElement,
    wallStore: WallStore,
    pillarStore: PillarStore,
    beamStore: BeamStore,
    slabStore: SlabStore,
    selectionStore: SelectionStore
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

    // Not stored on `this`: WallLayer/PillarLayer/BeamLayer/SlabLayer
    // stay alive via the subscriptions they register with their
    // stores/selectionStore, which outlive this constructor.
    const wallLayer = new WallLayer(this.scene, wallStore, selectionStore);
    const pillarLayer = new PillarLayer(this.scene, pillarStore, selectionStore);
    const beamLayer = new BeamLayer(this.scene, beamStore, selectionStore);
    const slabLayer = new SlabLayer(this.scene, slabStore, selectionStore);

    // One shared raycaster combines every layer's meshes into a single
    // click handler - see SelectionRaycaster.ts for why independent
    // per-layer raycasters would race each other.
    const selectionRaycaster = new SelectionRaycaster(this.camera, this.renderer.domElement, selectionStore);
    selectionRaycaster.registerLayer(() => wallLayer.getMeshes());
    selectionRaycaster.registerLayer(() => pillarLayer.getMeshes());
    selectionRaycaster.registerLayer(() => beamLayer.getMeshes());
    selectionRaycaster.registerLayer(() => slabLayer.getMeshes());

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

  start(): void {
    const animate = (): void => {
      requestAnimationFrame(animate);
      this.controls.update(); // required when damping is enabled
      this.renderer.render(this.scene, this.camera);
    };
    animate();
  }
}
