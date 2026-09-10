import type { AIProvider } from "./AIProvider";
// Explicit .ts extensions on these two value imports (unlike the
// type-only imports elsewhere in this file) are required so Node can
// run this file directly, e.g. from src/engine/ai/verify.ts - see
// allowImportingTsExtensions in tsconfig.json. Harmless for Vite too.
import { AICommandPipeline } from "./AICommandPipeline.ts";
import type { CommandExecutorLike } from "./AICommandPipeline";
import { buildAIProjectSnapshot } from "./types.ts";
import type { AIProjectSnapshotSource, AIPipelineResult } from "./types";
import type { HistoryGroupLike } from "../commands/executeCommandBatch";

export interface AIServiceOptions {
  /** Real usage passes a real provider (e.g. BackendAIProvider - see providers/); tests pass a fake/mock. */
  provider: AIProvider;
  /**
   * The SAME shared CommandExecutor every manual UI action already uses
   * (from ProjectContext) - never a private instance of this service's
   * own. That's what makes an AI-issued command share the exact same
   * undo/redo history, validation, and store state as a manually-issued
   * one, with no special-casing anywhere.
   */
  commandExecutor: CommandExecutorLike;
  /**
   * The SAME shared HistoryManager every manual action records into
   * (ProjectContext.history). With it, a whole AI response is recorded as
   * ONE undo step, and a response that fails part-way is rolled back (see
   * commands/executeCommandBatch.ts). Only its group methods are used.
   * Optional so unit tests can run without one; the running app always
   * passes it.
   */
  history?: HistoryGroupLike;
  /**
   * Anything with the same shape as ProjectContext's stores/
   * selectionStore (see AIProjectSnapshotSource) - a live ProjectContext
   * object satisfies this automatically, no adapter needed.
   */
  snapshotSource: AIProjectSnapshotSource;
}

/**
 * The application-level entry point for turning one command-bar
 * instruction into executed construction commands - the "where
 * AICommandPipeline can be constructed safely" answer from
 * ai/README.md. Owns exactly two things: a single AICommandPipeline
 * instance (constructed once, here) and a reference to the project's
 * live snapshot source, re-summarized fresh on every `submit()` call
 * via buildAIProjectSnapshot() - never a stale/cached snapshot, so a
 * second instruction always sees the effects of the first.
 *
 * This class is deliberately UI-free: no DOM, no concept of "loading" -
 * see AiPromptController for that. It is also mutation-free BY
 * CONSTRUCTION, not just by convention: it holds no *Store reference at
 * all, only a CommandExecutorLike (a narrow `{ execute(input):
 * CommandResult }` shape - see AICommandPipeline.ts), an optional history
 * group handle it passes straight to the pipeline, and a snapshot SOURCE
 * (read-only `getAll()`/`get()` methods, per AIProjectSnapshotSource) -
 * the only thing this class can ever do is call `this.pipeline.run(...)`,
 * which itself only ever mutates through `commandExecutor.execute()`.
 */
export class AIService {
  // Plain field declarations + assignment in the constructor body,
  // deliberately NOT TypeScript parameter-property shorthand - same
  // reasoning as AICommandPipeline.ts/OpenAIProvider.ts: this class is
  // instantiated directly by verify.ts, and Node's native TypeScript
  // support cannot run parameter properties.
  private readonly pipeline: AICommandPipeline;
  private readonly snapshotSource: AIProjectSnapshotSource;

  constructor(options: AIServiceOptions) {
    this.pipeline = new AICommandPipeline(options.provider, options.commandExecutor, options.history);
    this.snapshotSource = options.snapshotSource;
  }

  /** Runs one instruction end-to-end: builds a fresh read-only snapshot of the current project, then delegates entirely to AICommandPipeline.run(). */
  submit(instruction: string): Promise<AIPipelineResult> {
    const snapshot = buildAIProjectSnapshot(this.snapshotSource);
    return this.pipeline.run(instruction, snapshot);
  }
}
