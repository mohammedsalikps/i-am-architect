/**
 * The workspace's view settings - the grid you see, how moves snap, and
 * which guides are drawn. They are a viewer's preference, not part of the
 * model: changing them never moves, resizes or adds anything, and they
 * are not undo steps. They are remembered per browser (WORKSPACE_KEY).
 *
 * The plot (the site) is NOT here: it is a real element of the model
 * (a landscape element), saved with the project - see ArchitectSession.
 *
 * Units are metres throughout. The coordinate conventions (one system,
 * shared by the scene, the inspector, the record book and the
 * conversation):
 *   - X: east (+) / west (-)
 *   - Y: up - elevation and heights
 *   - Z: south (+, "front") / north (-, "back")
 *   - origin (0, 0, 0): ground level at the world centre
 * A spoken plan point "X 8, Y 6" is world (x 8, z 6): the plan's second
 * axis is the world Z axis.
 *
 * DOM-free and testable; storage is injected.
 */

export interface WorkspaceState {
  /** Spacing of the minor grid lines, metres. */
  gridSpacing: number;
  /** Moves and resizes snap while dragging. */
  snapping: boolean;
  /** The increment moves snap to, metres. */
  snapStep: number;
  /** The X/Y/Z axes and the origin marker. */
  showAxes: boolean;
  /** Room and wall dimension labels. */
  showDimensions: boolean;
}

export const WORKSPACE_KEY = "iarchitect.workspace";

export const GRID_SPACINGS: readonly number[] = [0.1, 0.25, 0.5, 1, 2, 5];
export const SNAP_STEPS: readonly number[] = [0.01, 0.05, 0.1, 0.25, 0.5, 1];

/** Today's behaviour: a 1 m grid, snapping on at 0.1 m. */
export const DEFAULT_WORKSPACE: WorkspaceState = { gridSpacing: 1, snapping: true, snapStep: 0.1, showAxes: true, showDimensions: true };

/** The densest grid drawn (more lines than the eye can read, and the GPU would draw for nothing). */
export const MIN_GRID_SPACING = 0.1;
export const MAX_GRID_SPACING = 10;
export const MIN_SNAP_STEP = 0.01;
export const MAX_SNAP_STEP = 5;

export function gridSpacingProblem(metres: number): string | null {
  if (!Number.isFinite(metres)) return "The grid spacing must be a number of metres.";
  if (metres < MIN_GRID_SPACING) return `The grid spacing can't be finer than ${MIN_GRID_SPACING} m.`;
  if (metres > MAX_GRID_SPACING) return `The grid spacing can't be more than ${MAX_GRID_SPACING} m.`;
  return null;
}

export function snapStepProblem(metres: number): string | null {
  if (!Number.isFinite(metres)) return "The snap step must be a number of metres.";
  if (metres < MIN_SNAP_STEP) return `Snapping can't be finer than ${MIN_SNAP_STEP} m (1 cm).`;
  if (metres > MAX_SNAP_STEP) return `Snapping can't step by more than ${MAX_SNAP_STEP} m.`;
  return null;
}

export interface WorkspaceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Saved settings, each field checked - anything missing or invalid is the default. */
export function readWorkspace(storage: WorkspaceStorage | null): WorkspaceState {
  let saved: Record<string, unknown> = {};
  try {
    const raw = storage?.getItem(WORKSPACE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) saved = parsed as Record<string, unknown>;
  } catch {
    saved = {};
  }
  const d = DEFAULT_WORKSPACE;
  const num = (value: unknown, problem: (m: number) => string | null, fallback: number): number => (typeof value === "number" && problem(value) === null ? value : fallback);
  return {
    gridSpacing: num(saved.gridSpacing, gridSpacingProblem, d.gridSpacing),
    snapping: typeof saved.snapping === "boolean" ? saved.snapping : d.snapping,
    snapStep: num(saved.snapStep, snapStepProblem, d.snapStep),
    showAxes: typeof saved.showAxes === "boolean" ? saved.showAxes : d.showAxes,
    showDimensions: typeof saved.showDimensions === "boolean" ? saved.showDimensions : d.showDimensions
  };
}

/** What the Architect conversation needs: read the settings, and change them (each change returns a problem, or null). */
export interface WorkspaceControls {
  get(): WorkspaceState;
  setGridSpacing(metres: number): string | null;
  setSnapping(on: boolean): void;
  setSnapStep(metres: number): string | null;
}

export class WorkspaceSettings implements WorkspaceControls {
  // Plain fields, not parameter properties: Node's own TypeScript support (the verify suites) can't run those.
  private readonly storage: WorkspaceStorage | null;
  private state: WorkspaceState;
  private readonly listeners = new Set<(state: WorkspaceState) => void>();

  constructor(storage: WorkspaceStorage | null = null) {
    this.storage = storage;
    this.state = readWorkspace(storage);
  }

  get(): WorkspaceState {
    return this.state;
  }

  setGridSpacing(metres: number): string | null {
    const problem = gridSpacingProblem(metres);
    if (problem) return problem;
    this.change({ gridSpacing: metres });
    return null;
  }

  setSnapping(on: boolean): void {
    this.change({ snapping: on });
  }

  setSnapStep(metres: number): string | null {
    const problem = snapStepProblem(metres);
    if (problem) return problem;
    this.change({ snapStep: metres });
    return null;
  }

  setShowAxes(on: boolean): void {
    this.change({ showAxes: on });
  }

  setShowDimensions(on: boolean): void {
    this.change({ showDimensions: on });
  }

  /** Called now with the current settings, then on every change; returns an unsubscribe. */
  subscribe(listener: (state: WorkspaceState) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private change(changes: Partial<WorkspaceState>): void {
    const next = { ...this.state, ...changes };
    if (JSON.stringify(next) === JSON.stringify(this.state)) return;
    this.state = next;
    try {
      this.storage?.setItem(WORKSPACE_KEY, JSON.stringify(next));
    } catch {
      // Not remembered across reloads - the change itself still applies.
    }
    for (const listener of [...this.listeners]) listener(this.state);
  }
}

/** "0.5 m", "1 m", "0.25 m" - a spacing or step as shown. */
export function formatSpacing(metres: number): string {
  return `${Number(metres.toFixed(3))} m`;
}
