import * as THREE from "three";
import { layoutHandles } from "../../engine/manipulation/manipulationMath";
import type { HandleSide, ManipulationAxis } from "../../engine/manipulation/manipulationMath";
import type { ManipulatedObject } from "../../engine/manipulation/ObjectManipulator";

/** What pressing a handle starts - stored on each handle's hit mesh as `userData.handle`. */
export type HandleTarget =
  | { kind: "resize"; axis: ManipulationAxis; side: HandleSide }
  | { kind: "rotate" }
  | { kind: "endpoint"; endpoint: "start" | "end" };

const HANDLE_COLOR = 0x4f8ef7; // the app's accent blue - distinct from the amber selection outline and every object color
const ENDPOINT_COLOR = 0x3ddc84; // green - an endpoint is a different kind of handle from a resize diamond
const HANDLE_RADIUS = 0.13;
const HANDLE_HIT_RADIUS = 0.2;
const ENDPOINT_RADIUS = 0.11;
const ENDPOINT_HIT_RADIUS = 0.22;
const RING_TUBE = 0.035;
const RING_HIT_TUBE = 0.25; // the ring clears the side handles' 0.2 m hit spheres by at least 0.45 m (see layoutHandles)
const RING_SEGMENTS = 96;
const RING_LIFT = 0.03; // just above the object's base, so the ring doesn't z-fight the ground
const RESIZE_HANDLE_COUNT = 5;
const ENDPOINT_HANDLE_COUNT = 2;

export interface ManipulationHandlesOptions {
  scene: THREE.Scene;
  selectionStore: { get(): string | null; subscribe(listener: (selectedId: string | null) => void): unknown };
  /** Every construction-object store - any of them changing can move or resize the selected object. */
  stores: readonly { subscribe(listener: () => void): unknown }[];
  readObject(id: string): ManipulatedObject | undefined;
  /** Whether the selected object is currently hidden - its handles hide too, so a hidden object can't be dragged by them. */
  isHidden(id: string): boolean;
  /** So handles hide/reappear the moment visibility is toggled, not just on the next selection/store change. */
  subscribeVisibility(listener: () => void): unknown;
}

/**
 * The selected object's manipulation handles: a diamond just outside each
 * face along local X and Z, one on top, and a ring around the base for
 * rotation - or, for a linear element, a green sphere on each endpoint in
 * place of the lengthwise diamonds; a door or window in a wall has no ring
 * (see layoutHandles() in engine/manipulation/manipulationMath.ts for
 * where each goes and which dimension it drives).
 *
 * Like every <Type>Layer, this only renders store state: it subscribes to
 * the selection and the object stores and re-places itself from whatever
 * the selected object now is - so the handles follow a drag, an undo, or
 * a Properties-panel edit identically. It never changes an object.
 *
 * Handles are depth-tested like any object: one hidden behind the
 * selected object can't be grabbed through it either (the controller
 * picks whatever is nearest along the pointer ray), so what you can see
 * is what you can grab. Each has a slightly larger invisible hit mesh so
 * it's easy to grab; getHandleMeshes() returns the ones in use for
 * ManipulationController to raycast.
 */
export class ManipulationHandles {
  private readonly group = new THREE.Group();
  private readonly resizeHits: THREE.Mesh[] = [];
  private readonly endpointHits: THREE.Mesh[] = [];
  private readonly ring: THREE.Mesh;
  private readonly ringHit: THREE.Mesh;
  private ringRadius = 0;
  private readonly selectionStore: ManipulationHandlesOptions["selectionStore"];
  private readonly readObject: ManipulationHandlesOptions["readObject"];
  private readonly isHidden: ManipulationHandlesOptions["isHidden"];

  constructor(options: ManipulationHandlesOptions) {
    this.selectionStore = options.selectionStore;
    this.readObject = options.readObject;
    this.isHidden = options.isHidden;

    const handleMaterial = new THREE.MeshBasicMaterial({ color: HANDLE_COLOR });
    const endpointMaterial = new THREE.MeshBasicMaterial({ color: ENDPOINT_COLOR });
    const hitMaterial = new THREE.MeshBasicMaterial({ visible: false });
    const handleGeometry = new THREE.OctahedronGeometry(HANDLE_RADIUS);
    const handleHitGeometry = new THREE.SphereGeometry(HANDLE_HIT_RADIUS, 12, 8);
    const endpointGeometry = new THREE.SphereGeometry(ENDPOINT_RADIUS, 16, 12);
    const endpointHitGeometry = new THREE.SphereGeometry(ENDPOINT_HIT_RADIUS, 12, 8);

    for (let index = 0; index < RESIZE_HANDLE_COUNT; index += 1) {
      const hit = new THREE.Mesh(handleHitGeometry, hitMaterial);
      hit.add(new THREE.Mesh(handleGeometry, handleMaterial));
      this.group.add(hit);
      this.resizeHits.push(hit);
    }
    for (let index = 0; index < ENDPOINT_HANDLE_COUNT; index += 1) {
      const hit = new THREE.Mesh(endpointHitGeometry, hitMaterial);
      hit.add(new THREE.Mesh(endpointGeometry, endpointMaterial));
      hit.visible = false;
      this.group.add(hit);
      this.endpointHits.push(hit);
    }

    this.ring = new THREE.Mesh(
      new THREE.TorusGeometry(1, RING_TUBE, 8, RING_SEGMENTS),
      new THREE.MeshBasicMaterial({ color: HANDLE_COLOR, transparent: true, opacity: 0.85 })
    );
    this.ringHit = new THREE.Mesh(new THREE.TorusGeometry(1, RING_HIT_TUBE, 6, RING_SEGMENTS), hitMaterial);
    this.ringHit.userData.handle = { kind: "rotate" } satisfies HandleTarget;
    this.ringHit.add(this.ring);
    this.ringHit.rotation.x = Math.PI / 2; // lay the ring flat, in the object's base plane
    this.group.add(this.ringHit);

    this.group.visible = false;
    options.scene.add(this.group);

    const sync = (): void => this.sync();
    options.selectionStore.subscribe(sync);
    for (const store of options.stores) {
      store.subscribe(sync);
    }
    options.subscribeVisibility(sync);
  }

  /** The hit meshes of the handles in use, to raycast - empty while nothing is selected. */
  getHandleMeshes(): THREE.Object3D[] {
    if (!this.group.visible) {
      return [];
    }
    return [...this.resizeHits, ...this.endpointHits, this.ringHit].filter((mesh) => mesh.visible);
  }

  private sync(): void {
    const selectedId = this.selectionStore.get();
    const object = selectedId ? this.readObject(selectedId) : undefined;
    const layout = object ? layoutHandles(object) : null;
    if (!object || !layout || this.isHidden(selectedId as string)) {
      this.group.visible = false;
      return;
    }

    // The group takes the object's own transform; handles sit in its local frame.
    this.group.position.set(object.position.x, object.position.y, object.position.z);
    this.group.rotation.y = object.rotation;

    this.resizeHits.forEach((hit, index) => {
      const handle = layout.resize[index];
      hit.visible = !!handle;
      if (handle) {
        hit.position.set(handle.position.x, handle.position.y, handle.position.z);
        hit.userData.handle = { kind: "resize", axis: handle.axis, side: handle.side } satisfies HandleTarget;
      }
    });
    this.endpointHits.forEach((hit, index) => {
      const handle = layout.endpoints[index];
      hit.visible = !!handle;
      if (handle) {
        hit.position.set(handle.position.x, handle.position.y, handle.position.z);
        hit.userData.handle = { kind: "endpoint", endpoint: handle.endpoint } satisfies HandleTarget;
      }
    });

    this.ringHit.visible = layout.rotate !== null;
    if (layout.rotate) {
      if (layout.rotate.radius !== this.ringRadius) {
        this.ring.geometry.dispose();
        this.ringHit.geometry.dispose();
        this.ring.geometry = new THREE.TorusGeometry(layout.rotate.radius, RING_TUBE, 8, RING_SEGMENTS);
        this.ringHit.geometry = new THREE.TorusGeometry(layout.rotate.radius, RING_HIT_TUBE, 6, RING_SEGMENTS);
        this.ringRadius = layout.rotate.radius;
      }
      this.ringHit.position.set(0, layout.rotate.y + RING_LIFT, 0);
    }

    this.group.visible = true;
    this.group.updateMatrixWorld(true);
  }
}
