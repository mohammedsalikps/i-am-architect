/**
 * One conversation turn at a time, cancellably. Each turn gets its own
 * AbortController, passed to ArchitectSession.handle() (and from there to
 * the AI pipeline), so:
 *
 * - Stop cancels the turn in flight: if it's still waiting on the AI, the
 *   reply is discarded unapplied - the model is never touched by it. The
 *   cancelled send() resolves at once (the user sees "Stopped" now, not
 *   when the abandoned request finally returns).
 * - A new turn while one is in flight (a spoken or typed correction)
 *   supersedes it: the old one is cancelled the same way and the new one
 *   runs at once - so an old reply can never land on top of a newer
 *   correction, and is never shown or read aloud.
 *
 * DOM-free and testable. The panel (architectPanel.ts) owns what is shown.
 */

export type TurnOutcome<R> =
  | { kind: "reply"; reply: R }
  /** Stopped by the user, or replaced by a newer turn - nothing of it should be shown or spoken. */
  | { kind: "cancelled"; reason: "stopped" | "superseded" }
  | { kind: "failed"; error: unknown };

export interface TurnController<R> {
  /** A turn is in flight. */
  readonly busy: boolean;
  /** Runs a turn; one already in flight is superseded (cancelled) first. */
  send(text: string): Promise<TurnOutcome<R>>;
  /** Cancels the turn in flight; returns whether there was one. */
  stop(): boolean;
}

interface Turn {
  controller: AbortController;
  reason: "stopped" | "superseded" | null;
}

export function createTurnController<R>(handle: (text: string, options: { signal: AbortSignal }) => Promise<R>): TurnController<R> {
  let current: Turn | null = null;

  const cancel = (turn: Turn, reason: "stopped" | "superseded"): void => {
    turn.reason = reason;
    turn.controller.abort();
  };

  return {
    get busy() {
      return current !== null;
    },
    async send(text) {
      if (current) cancel(current, "superseded");
      const turn: Turn = { controller: new AbortController(), reason: null };
      current = turn;
      const signal = turn.controller.signal;
      // Whichever comes first: the reply, or the cancel. A cancelled turn doesn't wait for its abandoned request -
      // which carries on in the background and, aborted, changes nothing (ArchitectSession/AICommandPipeline check the signal).
      const cancelled = new Promise<"cancelled">((resolve) => signal.addEventListener("abort", () => resolve("cancelled"), { once: true }));
      const answered = handle(text, { signal }).then(
        (reply) => ({ reply }),
        (error: unknown) => ({ error })
      );
      try {
        const first = await Promise.race([answered, cancelled]);
        if (first === "cancelled" || signal.aborted) return { kind: "cancelled", reason: turn.reason ?? "stopped" };
        return "error" in first ? { kind: "failed", error: first.error } : { kind: "reply", reply: first.reply };
      } finally {
        if (current === turn) current = null;
      }
    },
    stop() {
      if (!current) return false;
      cancel(current, "stopped");
      current = null;
      return true;
    }
  };
}
