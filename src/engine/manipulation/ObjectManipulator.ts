// Explicit .ts extensions on these value imports (the rest are type-only)
// let Node run this module directly - see manipulation/verify.ts and
// ai/e2e/verify.ts. Harmless for Vite.
import { computeMove, computeResize, computeRotation, dimensionForAxis } from "./manipulationMath.ts";
import { resolveConstructionObject } from "../objects/resolveConstructionObject.ts";
import type { HandleSide, ManipulationAxis, Point3 } from "./manipulationMath";
import type { ConstructionObjectStores } from "../objects/resolveConstructionObject";
import type { CommandResult } from "../commands/types";

/** What a pointer gesture does to the selected object. */
export type ManipulationGesture =
  | { kind: "move" }
  | { kind: "resize"; axis: ManipulationAxis; side: HandleSide }
  | { kind: "rotate" };

/** A read-only view of the object being manipulated, as the stores currently hold it. */
export interface ManipulatedObject {
  id: string;
  type: string;
  position: Point3;
  rotation: number;
  dimensions: Record<string, number>;
}

/** The subset of HistoryManager a gesture needs - one group per gesture. */
export interface ManipulationHistory {
  beginGroup(): void;
  endGroup(): void;
  cancelGroup(): void;
}

export interface ObjectManipulatorOptions {
  /** The shared CommandExecutor - every change a gesture makes is an update_object command through it. */
  commandExecutor: { execute(input: unknown): CommandResult };
  /** The shared HistoryManager, so each gesture becomes one undo entry. */
  history: ManipulationHistory;
  /** Reads an object's current state - see createStoreObjectReader(). Only ever read. */
  readObject: (id: string) => ManipulatedObject | undefined;
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
}

/**
 * Turns a mouse gesture on one object - move, resize, or rotate - into
 * edits of the construction model. It owns no state of the model and
 * never writes anything itself: every change is an `update_object`
 * command through the shared CommandExecutor, so the per-type update,
 * the store's validation, and history are exactly what a Properties-panel
 * edit gets. The Three.js meshes follow because their layers subscribe to
 * the stores, not because anything here touches them.
 *
 * One gesture is one undo entry: begin() opens a HistoryManager group,
 * each update() that changes something executes one command inside it,
 * and end() closes the group (cancel() rolls it back instead). A press
 * that never moves far enough to change anything records nothing.
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
  private active: ActiveGesture | null = null;

  constructor(options: ObjectManipulatorOptions) {
    this.commandExecutor = options.commandExecutor;
    this.history = options.history;
    this.readObject = options.readObject;
  }

  /**
   * Starts a gesture on an existing object, with `grab` the point on the
   * drag plane the pointer pressed. Returns false - and opens nothing -
   * if a gesture is already running, the object doesn't exist, or a
   * resize targets an axis its type has no dimension for.
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
      const found = dimensionForAxis(start.type, gesture.axis);
      if (!found || !Object.prototype.hasOwnProperty.call(start.dimensions, found)) {
        return false;
      }
      dimension = found;
    }

    const active: ActiveGesture = { objectId, gesture, start, grab: { ...grab }, dimension, lastApplied: "" };
    // The change the gesture asks for before the pointer has moved is the
    // object's own current state - never worth a command.
    active.lastApplied = JSON.stringify(this.changesFor(active, active.grab));

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

    const changes = this.changesFor(active, point);
    const serialized = JSON.stringify(changes);
    if (serialized === active.lastApplied) {
      return null;
    }

    const result = this.commandExecutor.execute({ type: "update_object", objectId: active.objectId, changes });
    if (result.success) {
      active.lastApplied = serialized;
    }
    return result;
  }

  /** Finishes the gesture, keeping its changes as one undo entry (none if nothing changed). */
  end(): void {
    if (!this.active) {
      return;
    }
    this.active = null;
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

  private changesFor(active: ActiveGesture, point: Point3): Record<string, unknown> {
    const { start, grab, gesture } = active;
    switch (gesture.kind) {
      case "move":
        return { position: computeMove(start.position, grab, point) };
      case "resize": {
        const resized = computeResize(
          start,
          { axis: gesture.axis, side: gesture.side, dimension: active.dimension as string },
          grab,
          point
        );
        return { dimensions: resized.dimensions, position: resized.position };
      }
      case "rotate":
        return { rotation: computeRotation(start, grab, point) };
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
): { id: string; type: string; position: Point3; rotation: number; dimensions: object } | undefined {
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
    default:
      return undefined;
  }
}
