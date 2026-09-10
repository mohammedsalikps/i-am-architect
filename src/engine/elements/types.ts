import type { ConstructionObjectBase, ObjectId } from "../objects/types";

export type ElementId = ObjectId;

/** Non-dimensional parameters a kind declares (see ParamSpec in catalog.ts) - e.g. a stair's step count. */
export type ElementParams = Record<string, number | string>;

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
 *
 * `type` is always "element": the six original types keep their own
 * stores; every newer kind shares ElementStore, commands, history, and
 * scene layer.
 */
export interface ElementData extends ConstructionObjectBase<"element", Record<string, number>> {
  kind: string;
  label: string;
  params: ElementParams;
}
