/**
 * Construction Method / Build Sequence - V1 domain model.
 *
 * Deliberately does NOT duplicate the construction object model: a step
 * only ever stores the real ids of objects that already exist in
 * AIContextObject form (see ../ai/types.ts, buildAIProjectSnapshot) - the
 * same registry the AI layer already reads the project through. See
 * generateConstructionSequence.ts for the classifier that assigns each
 * real object to a category, and README-level notes there for what this
 * feature is (a construction-planning visualization) and isn't (an
 * engineering/costing/BOQ system).
 */

/**
 * The construction phases this feature can recognize. A generated
 * sequence only ever contains steps for categories that have at least one
 * matching object in the project - see generateConstructionSequence()'s
 * skip-if-empty behavior.
 */
export type ConstructionCategory = "foundation" | "structure" | "walls" | "openings" | "services" | "finish" | "roof" | "interior" | "exterior";

/**
 * V1 has no construction-progress tracking (no way for a user to mark a
 * step built) - every generated step is "pending". The field exists so a
 * later milestone can add real status transitions without changing this
 * shape; it is never set to anything else today.
 */
export type ConstructionStepStatus = "pending";

/**
 * One material/component a step needs. `quantity` is a real, derivable
 * number (a count of real objects, a summed real dimension) wherever the
 * project actually records enough to compute one - never an invented
 * engineering estimate. When it can't be reliably derived (concrete
 * volume, reinforcement weight - nothing in this project's data model
 * tracks mix ratios or rebar), `quantity` is the honest placeholder
 * "Not calculated", or "As designed" for a property already fully
 * specified by the object itself rather than actually unknown.
 */
export interface RequiredComponent {
  name: string;
  /** A material/trade grouping (e.g. "structural", "masonry", "plumbing") - distinct from the step's own ConstructionCategory. */
  category: string;
  quantity: number | "As designed" | "Not calculated";
  unit: string;
  /** Real object ids this component was derived from - a subset of the owning step's own objectIds. */
  relatedObjectIds: string[];
}

export interface ConstructionStep {
  id: string;
  /** 1-based position in the sequence - only counts steps that were actually included. */
  order: number;
  title: string;
  category: ConstructionCategory;
  description: string;
  /** Real registry ids (AIContextObject.id) of every project object classified into this step - never a fabricated id. */
  objectIds: string[];
  requiredComponents: RequiredComponent[];
  status: ConstructionStepStatus;
}

export interface ConstructionSequence {
  id: string;
  /** The project this was generated from (ProjectMeta.id) - null for an unsaved project. */
  projectId: string | null;
  /** Date.now() at generation - the sequence is always regenerated fresh from current project state, never persisted (see task section 11). */
  generatedAt: number;
  steps: ConstructionStep[];
}
