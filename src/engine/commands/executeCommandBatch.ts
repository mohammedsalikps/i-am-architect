import type { CommandResult } from "./types";

/**
 * The part of HistoryManager (history/HistoryManager.ts) a batch needs:
 * its groups. HistoryManager satisfies this structurally, so nothing here
 * imports it.
 */
export interface HistoryGroupLike {
  beginGroup(): void;
  endGroup(): void;
  cancelGroup(): void;
  isGrouping(): boolean;
}

/** The part of CommandExecutor a batch needs - the same narrow shape as AICommandPipeline's CommandExecutorLike. */
export interface BatchCommandExecutor {
  execute(input: unknown): CommandResult;
}

export interface CommandBatchResult {
  success: boolean;
  /**
   * One result per command that ran, in order. The batch stops at the
   * first failure, so after a failure this is shorter than the batch and
   * its last entry is the failing command's own result.
   */
  results: CommandResult[];
  /** Index of the command that failed, when one did. */
  failedIndex?: number;
  /** Why the batch couldn't start at all, when it couldn't - nothing ran. */
  message?: string;
}

/**
 * Runs a list of commands as ONE all-or-nothing, undoable operation.
 *
 * - Every command goes through `executor.execute()` - the normal mutation
 *   path, with each store's own validation - in order.
 * - With a `history`, the whole batch becomes a single history entry: one
 *   Undo removes all of it, one Redo brings all of it back. This is
 *   HistoryManager's existing group mechanism, the same one a mouse drag
 *   uses.
 * - The first failing command stops the batch and the group is
 *   cancelled, which undoes everything the batch had already done. The
 *   model is exactly as it was, and the undo/redo stacks are untouched.
 *
 * Rolling back relies on every mutation being recorded in `history`.
 * That holds for every construction-object command, since they all go
 * through the *HistoryController classes. Assembly commands aren't
 * recorded, so a batch that contains them can't be fully rolled back.
 * AICommandPipeline, the caller that needs all-or-nothing, never sends
 * them.
 *
 * Without a `history`, the batch still stops at the first failure, but
 * whatever already ran stays applied, because there is nothing to roll
 * back with.
 *
 * If a group is already open (for example, a drag is in progress),
 * nothing runs. Groups don't nest, and folding this batch into the drag's
 * entry would make one Undo reverse both.
 */
export function executeCommandBatch(
  executor: BatchCommandExecutor,
  commands: readonly unknown[],
  history?: HistoryGroupLike
): CommandBatchResult {
  if (history?.isGrouping()) {
    return {
      success: false,
      results: [],
      message: "Another edit (such as a drag) is still in progress, so nothing was changed. Try again once it finishes."
    };
  }

  history?.beginGroup();
  const results: CommandResult[] = [];
  let failedIndex: number | undefined;
  try {
    for (let index = 0; index < commands.length; index += 1) {
      const result = executor.execute(commands[index]);
      results.push(result);
      if (!result.success) {
        failedIndex = index;
        break;
      }
    }
  } catch (error) {
    // execute() reports failures as results, so a throw is unexpected - but the group must still be closed.
    failedIndex = results.length;
    results.push({ success: false, message: `Command threw an error: ${error instanceof Error ? error.message : String(error)}` });
  } finally {
    if (failedIndex === undefined) {
      history?.endGroup();
    } else {
      history?.cancelGroup();
    }
  }

  return failedIndex === undefined ? { success: true, results } : { success: false, results, failedIndex };
}
