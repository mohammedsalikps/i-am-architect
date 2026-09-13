// Explicit .ts extensions on these value imports (the rest are type-only)
// let Node run this module directly - see manipulation/verify.ts and
// ai/e2e/verify.ts. Harmless for Vite.
import { MOVE_STEP, computeMove, computeResize, computeRotation, dimensionForAxis, roundValue, snapToStep } from "./manipulationMath.ts";
import { resolveConstructionObject } from "../objects/resolveConstructionObject.ts";
import { getElementKind } from "../elements/catalog.ts";
import { endpointsOf, moveEndpoint } from "../connections/connections.ts";
import type { HandleSide, ManipulationAxis, Point3 } from "./manipulationMath";
import type { ConstructionObjectStores } from "../objects/resolveConstructionObject";
import type { CommandResult } from "../commands/types";
import type { Endpoint } from "../elements/types";

/** What a pointer gesture does to the selected object. */
export type ManipulationGesture =
  | { kind: "move" }
  | { kind: "resize"; axis: ManipulationAxis; side: HandleSide }
  | { kind: "rotate" }
  /** A linear element's endpoint: that end follows the pointer, the other stays put. */
  | { kind: "endpoint"; endpoint: Endpoint };

/** A read-only view of the object being manipulated, as the stores currently hold it. */
export interface ManipulatedObject {
  id: string;
  type: string;
  /** Elements only: the catalog kind, which decides which dimension each resize handle drives. */
  kind?: string;
  /** Doors and windows only: the host wall, or null. */
  hostId?: string | null;
  position: Point3;
  rotation: number;
  dimensions: Record<string, number>;
}

/** What a snapped point landed on. */
export interface SnapTarget {
  objectId: string;
  endpoint?: Endpoint;
  /** True when it's an endpoint the dragged endpoint can be connected to. */
  connectable: boolean;
}

/**
 * Snapping for gestures (see engine/snapping/). Optional: without one, a
 * move and an endpoint drag follow the pointer in their plain steps.
 */
export interface ManipulationSnapper {
  /** Where the object whose center would land at `candidate` snaps to. */
  move(objectId: string, candidate: Point3): Point3;
  /** Where the dragged endpoint snaps to, and what it snapped to. */
  endpoint(objectId: string, endpoint: Endpoint, candidate: Point3): { point: Point3; target: SnapTarget | null };
}

/** The subset of HistoryManager a gesture needs - one group per gesture. */
export interface ManipulationHistory {
  beginGroup(): void;
  endGroup(): void;
  cancelGroup(): void;
}

export interface ObjectManipulatorOptions {
  /** The shared CommandExecutor - every change a gesture makes is a command through it. */
  commandExecutor: { execute(input: unknown): CommandResult };
  /** The shared HistoryManager, so each gesture becomes one undo entry. */
  history: ManipulationHistory;
  /** Reads an object's current state - see createStoreObjectReader(). Only ever read. */
  readObject: (id: string) => ManipulatedObject | undefined;
  /** Optional snapping - see ManipulationSnapper. */
  snapper?: ManipulationSnapper;
}

interface ActiveGesture {
  objectId: string;
  gesture: ManipulationGesture;
  /** The object as it was when the gesture began - every update is measured from this. */
  start: ManipulatedObject;
  grab: Point3;
  /** For a resize: the dimension along the handle's axis. */
  dimension: string | null;
  /** The last change that was applied, serialized - identical follow-ups are skipped. */
  lastApplied: string;
  /** For an endpoint drag: what the applied endpoint snapped to. */
  snapTarget: SnapTarget | null;
}

/**
 * Turns a mouse gesture on one object - move, resize, rotate, or an
 * endpoint drag - into edits of the construction model. It owns no state
 * of the model and never writes anything itself: every change is an
 * `update_object` command through the shared CommandExecutor, so the
 * per-type update, the store's validation, relationships (a wall's
 * openings follow it; a door in a wall slides along it; joined pipes
 * follow a moved endpoint), and history are exactly what a
 * Properties-panel edit gets. The Three.js meshes follow because their
 * layers subscribe to the stores, not because anything here touches them.
 *
 * One gesture is one undo entry: begin() opens a HistoryManager group,
 * each update() that changes something executes one command inside it,
 * and end() closes the group (cancel() rolls it back instead). A press
 * that never moves far enough to change anything records nothing. An
 * endpoint dropped onto a compatible endpoint is connected to it before
 * the group closes - so the drag and the connection undo together.
 *
 * A change the store rejects (say, a resize that would make a dimension
 * zero or negative) leaves the object at its last valid state; the
 * gesture carries on and later valid positions still apply.
 *
 * No Three.js or DOM: points arrive already projected onto the drag plane
 * (see src/scene/manipulation/ManipulationController.ts), which is what
 * lets this run under Node against the real engine.
 */
export class ObjectManipulator {
  // Plain field declarations rather than parameter properties, so Node's
  // strip-only TypeScript support can run this class (see verify.ts).
  private readonly commandExecutor: ObjectManipulatorOptions["commandExecutor"];
  private readonly history: ManipulationHistory;
  private readonly readObject: ObjectManipulatorOptions["readObject"];
  private readonly snapper: ManipulationSnapper | undefined;
  private active: ActiveGesture | null = null;

  constructor(options: ObjectManipulatorOptions) {
    this.commandExecutor = options.commandExecutor;
    this.history = options.history;
    this.readObject = options.readObject;
    this.snapper = options.snapper;
  }

  /**
   * Starts a gesture on an existing object, with `grab` the point on the
   * drag plane the pointer pressed. Returns false - and opens nothing -
   * if a gesture is already running, the object doesn't exist, a resize
   * targets an axis its type has no dimension for, or an endpoint drag
   * targets something that isn't a linear element.
   */
  begin(objectId: string, gesture: ManipulationGesture, grab: Point3): boolean {
    if (this.active) {
      return false;
    }
    const start = this.readObject(objectId);
    if (!start) {
      return false;
    }

    let dimension: string | null = null;
    if (gesture.kind === "resize") {
      const found = dimensionForAxis(start.type, gesture.axis, start.kind);
      if (!found || !Object.prototype.hasOwnProperty.call(start.dimensions, found)) {
        return false;
      }
      dimension = found;
    }
    if (gesture.kind === "endpoint" && !(start.type === "element" && !!start.kind && getElementKind(start.kind)?.linear)) {
      return false;
    }

    const active: ActiveGesture = { objectId, gesture, start, grab: { ...grab }, dimension, lastApplied: "", snapTarget: null };
    // The change the gesture asks for before the pointer has moved is the
    // object's own current state - never worth a command.
    active.lastApplied = JSON.stringify(this.plan(active, active.grab).changes);

    this.history.beginGroup();
    this.active = active;
    return true;
  }

  /**
   * Follows the pointer to `point` on the drag plane. Executes one
   * update_object command when the gesture now asks for something new;
   * returns its result, or null when there was nothing new to apply.
   */
  update(point: Point3): CommandResult | null {
    const active = this.active;
    if (!active) {
      return null;
    }

    const { changes, snapTarget } = this.plan(active, point);
    const serialized = JSON.stringify(changes);
    if (serialized === active.lastApplied) {
      return null;
    }

    const result = this.commandExecutor.execute({ type: "update_object", objectId: active.objectId, changes });
    if (result.success) {
      active.lastApplied = serialized;
      active.snapTarget = snapTarget;
    }
    return result;
  }

  /**
   * Finishes the gesture, keeping its changes as one undo entry (none if
   * nothing changed). An endpoint left on a compatible endpoint is
   * connected to it first, inside the same entry.
   */
  end(): void {
    const active = this.active;
    if (!active) {
      return;
    }
    this.active = null;
    const target = active.snapTarget;
    if (active.gesture.kind === "endpoint" && target?.connectable && target.endpoint) {
      // Refused (e.g. already connected) leaves the drag itself intact.
      this.commandExecutor.execute({
        type: "element.connect",
        from: { id: active.objectId, endpoint: active.gesture.endpoint },
        to: { id: target.objectId, endpoint: target.endpoint }
      });
    }
    this.history.endGroup();
  }

  /** Abandons the gesture, restoring the object to where it began, with no undo entry. */
  cancel(): void {
    if (!this.active) {
      return;
    }
    this.active = null;
    this.history.cancelGroup();
  }

  isActive(): boolean {
    return this.active !== null;
  }

  /** The running gesture, if any - e.g. for a cursor. */
  activeGesture(): ManipulationGesture | null {
    return this.active ? this.active.gesture : null;
  }

  private plan(active: ActiveGesture, point: Point3): { changes: Record<string, unknown>; snapTarget: SnapTarget | null } {
    const { start, grab, gesture } = active;
    switch (gesture.kind) {
      case "move": {
        const moved = computeMove(start.position, grab, point);
        return { changes: { position: this.snapper ? this.snapper.move(active.objectId, moved) : moved }, snapTarget: null };
      }
      case "resize": {
        const resized = computeResize(
          start,
          { axis: gesture.axis, side: gesture.side, dimension: active.dimension as string },
          grab,
          point
        );
        return { changes: { dimensions: resized.dimensions, position: resized.position }, snapTarget: null };
      }
      case "rotate":
        return { changes: { rotation: computeRotation(start, grab, point) }, snapTarget: null };
      case "endpoint": {
        const from = endpointsOf(start)[gesture.endpoint];
        let target: Point3 = {
          x: roundValue(from.x + snapToStep(point.x - grab.x, MOVE_STEP)),
          y: from.y,
          z: roundValue(from.z + snapToStep(point.z - grab.z, MOVE_STEP))
        };
        let snapTarget: SnapTarget | null = null;
        if (this.snapper) {
          const snapped = this.snapper.endpoint(active.objectId, gesture.endpoint, target);
          target = snapped.point;
          snapTarget = snapped.target;
        }
        return { changes: moveEndpoint(start, gesture.endpoint, target), snapTarget };
      }
    }
  }
}

/**
 * Reads any construction object by id from the stores, as a plain copy -
 * the ObjectManipulator's `readObject`. Read-only: stores' get() already
 * returns a clone, and this copies it again into a plain view.
 */
export function createStoreObjectReader(stores: ConstructionObjectStores): (id: string) => ManipulatedObject | undefined {
  return (id) => {
    const ref = resolveConstructionObject(id, stores);
    if (!ref) {
      return undefined;
    }
    const record = readRecord(ref.type, id, stores);
    if (!record) {
      return undefined;
    }
    return {
      id: record.id,
      type: record.type,
      ...(typeof record.kind === "string" ? { kind: record.kind } : {}),
      ...(record.hostId !== undefined ? { hostId: record.hostId } : {}),
      position: { x: record.position.x, y: record.position.y, z: record.position.z },
      rotation: record.rotation,
      dimensions: Object.fromEntries(Object.entries(record.dimensions)) as Record<string, number>
    };
  };
}

function readRecord(
  type: string,
  id: string,
  stores: ConstructionObjectStores
): { id: string; type: string; kind?: string; hostId?: string | null; position: Point3; rotation: number; dimensions: object } | undefined {
  switch (type) {
    case "wall":
      return stores.wallStore.get(id);
    case "pillar":
      return stores.pillarStore.get(id);
    case "beam":
      return stores.beamStore.get(id);
    case "slab":
      return stores.slabStore.get(id);
    case "door":
      return stores.doorStore.get(id);
    case "window":
      return stores.windowStore.get(id);
    case "element":
      return stores.elementStore?.get(id);
    case "asset":
      return stores.assetStore?.get(id);
    default:
      return undefined;
  }
}
