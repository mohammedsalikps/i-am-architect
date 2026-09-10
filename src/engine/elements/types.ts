import type { ConstructionObjectBase, ObjectId } from "../objects/types";

export type ElementId = ObjectId;

/** Non-dimensional parameters a kind declares (see ParamSpec in catalog.ts) - e.g. a stair's step count. */
export type ElementParams = Record<string, number | string>;

/** The two ends of a linear element (pipe, conduit, cable): start is its local -X end, end its local +X end. */
export type Endpoint = "start" | "end";

/**
 * One endpoint connection: this element's `endpoint` is joined to
 * `objectId`'s `objectEndpoint`. Every connection is recorded on BOTH
 * elements, mirrored, and the two endpoints always coincide - see
 * engine/connections/connections.ts. Only element.connect and
 * element.disconnect change connections.
 */
export interface ElementConnection {
  endpoint: Endpoint;
  objectId: string;
  objectEndpoint: Endpoint;
}

/**
 * One parametric construction element - a foundation, roof, stair,
 * flooring, pipe, socket, bed, tree, room, and every other kind in the
 * element catalog (catalog.ts). It is an ordinary ConstructionObjectBase
 * (id, position, rotation, dimensions, material, color, assemblyId) with:
 *
 * - `kind`: which catalog entry it is. The catalog - not this type -
 *   decides its dimensions, how they map to its box, its default
 *   placement, materials, parameters, and mesh.
 * - `label`: the name shown to people (a room's name, "Master Bedroom").
 *   Defaults to the kind's label.
 * - `params`: the kind's non-dimensional parameters.
 * - `connections`: endpoint connections to other elements of a
 *   compatible kind (water pipe to water pipe, cable to cable, ...).
 *   Always empty for kinds without endpoints.
 *
 * `type` is always "element": the six original types keep their own
 * stores; every newer kind shares ElementStore, commands, history, and
 * scene layer.
 */
export interface ElementData extends ConstructionObjectBase<"element", Record<string, number>> {
  kind: string;
  label: string;
  params: ElementParams;
  connections: ElementConnection[];
}
