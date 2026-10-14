/**
 * The AI Architect copilot's visible interaction state - what the panel's
 * stepper and status line show - as a small, DOM-free state machine:
 *
 *   Idle → Listening → Transcribing → Understanding →
 *     Clarifying (a question) | Previewing (a change laid out, awaiting a
 *     go-ahead) | Applied (the scene really changed) | Error
 *
 * "Applied" comes ONLY from a reply the session marked `applied` - it
 * measured that the scene's objects changed during that turn. A
 * transcript, a plan or a preview never shows as applied.
 *
 * Plus the input gate: speech recognition can deliver the same final
 * phrase twice, and a new instruction can arrive while the last one is
 * still being understood. Duplicates are dropped; while busy, only the
 * LATEST new instruction is kept, to run next.
 */

export type CopilotPhase = "idle" | "listening" | "transcribing" | "understanding" | "clarifying" | "previewing" | "applied" | "error";

export interface CopilotState {
  phase: CopilotPhase;
  /** Live or final recognized words, shown as heard - never sent until final. */
  transcript: string;
  /** One line saying what is happening, in plain words. */
  detail: string;
  /** What actually happened in the current task (from its first instruction until something is applied, fails or ends) - so the stepper never marks a step done that was skipped. */
  task: { voice: boolean; clarified: boolean; previewed: boolean };
}

const NEW_TASK = { voice: false, clarified: false, previewed: false };
/** Phases after which the next instruction starts a new task. */
const TASK_ENDED: ReadonlySet<CopilotPhase> = new Set(["idle", "applied", "error"]);

export type CopilotEvent =
  | { type: "listening" }
  | { type: "interim"; text: string }
  | { type: "heard"; text: string }
  | { type: "sent"; text: string }
  | { type: "reply"; reply: { tone: string; applied?: boolean; preview?: boolean; undone?: boolean } }
  | { type: "voice-error"; message: string }
  | { type: "stopped" };

export const INITIAL_COPILOT_STATE: CopilotState = { phase: "idle", transcript: "", detail: "", task: NEW_TASK };

export function nextCopilotState(state: CopilotState, event: CopilotEvent): CopilotState {
  const fresh = TASK_ENDED.has(state.phase);
  switch (event.type) {
    case "listening":
      return { phase: "listening", transcript: "", detail: "Listening… speak your instruction.", task: { ...(fresh ? NEW_TASK : state.task), voice: true } };
    case "interim":
      return { phase: "transcribing", transcript: event.text, detail: "Hearing you…", task: { ...state.task, voice: true } };
    case "heard":
      return { phase: "transcribing", transcript: event.text, detail: "Heard - sending it now.", task: { ...state.task, voice: true } };
    case "sent": {
      // Typed text arriving after a finished task starts a new one (spoken text already did, at "listening").
      const spoken = state.phase === "transcribing";
      const task = spoken ? state.task : fresh ? NEW_TASK : state.task;
      // The transcript line is for recognized speech only - typed text is already in the conversation.
      return { phase: "understanding", transcript: spoken ? state.transcript : "", detail: "Understanding…", task };
    }
    case "reply": {
      const { reply } = event;
      const transcript = state.transcript;
      if (reply.applied) return { phase: "applied", transcript, detail: reply.undone ? "Undone - the last change was reversed." : "Applied to the scene.", task: state.task };
      if (reply.tone === "error") return { phase: "error", transcript, detail: "Nothing was changed.", task: state.task };
      if (reply.tone === "question") {
        return reply.preview
          ? { phase: "previewing", transcript, detail: "Preview - nothing is built until you confirm.", task: { ...state.task, previewed: true } }
          : { phase: "clarifying", transcript, detail: "Waiting for your answer.", task: { ...state.task, clarified: true } };
      }
      return { phase: "idle", transcript, detail: "", task: state.task };
    }
    case "voice-error":
      return { phase: "error", transcript: "", detail: event.message, task: state.task };
    case "stopped":
      return { phase: "idle", transcript: "", detail: "Stopped.", task: state.task };
  }
}

export const COPILOT_STEPS: readonly { id: "listening" | "understanding" | "clarifying" | "previewing" | "applied"; label: string }[] = [
  { id: "listening", label: "Listening" },
  { id: "understanding", label: "Understanding" },
  { id: "clarifying", label: "Clarifying" },
  { id: "previewing", label: "Previewing" },
  { id: "applied", label: "Applied" }
];

const PHASE_STEP: Readonly<Record<CopilotPhase, number>> = {
  idle: -1,
  listening: 0,
  transcribing: 0,
  understanding: 1,
  clarifying: 2,
  previewing: 3,
  applied: 4,
  error: -1
};

export type StepStatus = "done" | "active" | "skipped" | "todo";

/**
 * Each step's status for the stepper, from what really happened in this
 * task: Listening is done only if the instruction was spoken, Clarifying
 * only if a question was actually asked, Previewing only if a change was
 * actually laid out - a step passed over is "skipped", never "done".
 */
export function stepStatuses(state: CopilotState): StepStatus[] {
  const current = PHASE_STEP[state.phase];
  if (current < 0) return COPILOT_STEPS.map(() => "todo"); // idle or error: nothing in progress
  const { voice, clarified, previewed } = state.task;
  const happened = [voice, current >= 1, clarified, previewed, state.phase === "applied"];
  return COPILOT_STEPS.map((_, index) => {
    if (index === current) return state.phase === "applied" ? "done" : "active";
    if (happened[index]) return "done";
    return index < current ? "skipped" : "todo";
  });
}

export interface InputGate {
  /** "send" now; "duplicate" (the same words just sent - dropped); or "queued" (busy - kept as the next instruction, replacing any earlier one). */
  admit(text: string, busy: boolean, now: number): "send" | "duplicate" | "queued";
  /** The queued instruction, if any - taken (cleared) once the current one finishes. */
  takeQueued(): string | null;
}

export function createInputGate(duplicateWindowMs = 2500): InputGate {
  let last = { text: "", at: -Infinity };
  let queued: string | null = null;
  const normalize = (text: string) => text.trim().toLowerCase().replace(/\s+/g, " ");
  return {
    admit(text, busy, now) {
      const said = normalize(text);
      if (said === last.text && now - last.at < duplicateWindowMs) return "duplicate";
      if (busy) {
        if (queued !== null && normalize(queued) === said) return "duplicate";
        queued = text.trim();
        return "queued";
      }
      last = { text: said, at: now };
      return "send";
    },
    takeQueued() {
      const next = queued;
      queued = null;
      return next;
    }
  };
}
