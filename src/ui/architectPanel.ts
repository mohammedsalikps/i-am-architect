import { el } from "./dom";
import { createVoiceInput } from "./voiceInput";
import type { VoiceState } from "./voiceInput";
import { createHandsFree, createSpeechOutput, matchSpokenChoice, spokenNumbers } from "./handsFree";
import type { HandsFreeStatus } from "./handsFree";
import { COPILOT_STEPS, INITIAL_COPILOT_STATE, createInputGate, nextCopilotState, stepStatuses } from "./copilotState";
import type { CopilotEvent, CopilotState } from "./copilotState";
import { createLevelMeter } from "./levelMeter";
import { isAiPromptSubmitKey } from "../engine/ai/AiPromptController";
import type { ArchitectChoice, ArchitectReply, ArchitectSession, ArchitectViewState } from "../engine/architect/ArchitectSession";
import type { PlanPoint } from "../engine/architect/parseUtterance";
import type { HouseFootprint } from "../engine/ai/housePlan";

/**
 * The EAVARA Architect conversation, floating over the left of the
 * viewport: a transcript, the latest reply's suggested answers as chips,
 * a progress strip for the house's six build stages, and a composer with
 * a location-pick button and a microphone.
 *
 * Owns no design state. Every turn - typed, spoken, or a chip click - goes
 * to `session.handle()`, and everything shown comes back from it (see
 * engine/architect/ArchitectSession.ts). The two things it does on the
 * session's behalf are viewport actions: framing the objects a turn built
 * (`onFocus`) and arming a ground pick when the session asks for a
 * location (`onPickLocation`).
 */
export interface ArchitectPanelOptions {
  session: ArchitectSession;
  onFocus: (objectIds: string[]) => void;
  /** Arms a one-click ground pick, previewing `footprint`; calls `done` with the point, or null if cancelled. */
  onPickLocation: (footprint: HouseFootprint | null, done: (point: PlanPoint | null) => void) => void;
  /** Hides or shows objects in the viewport (a view setting, never the model) - "show me the living room" lifts the roof out of the way. */
  onSetHidden: (objectIds: readonly string[], hidden: boolean) => void;
}

export interface ArchitectPanel {
  element: HTMLElement;
  focusInput(): void;
}

/** Picked points are kept to 0.1 m (see ArchitectSession.pickedLocation) - shown the same way. */
function fmt(value: number): string {
  return String(Math.round(value * 10) / 10);
}

export function createArchitectPanel(options: ArchitectPanelOptions): ArchitectPanel {
  const { session } = options;

  const log = el("div", { className: "architect__log", attrs: { role: "log", "aria-live": "polite", "aria-label": "Conversation with the EAVARA architect" } });
  const stages = el("ol", { className: "architect__stages", attrs: { "aria-label": "Build stages" } });
  stages.hidden = true;

  const input = el("input", {
    className: "architect__input",
    attrs: { type: "text", placeholder: "Describe your site or house…", "aria-label": "Instruction for the architect", autocomplete: "off" }
  });
  const pickButton = el("button", { className: "architect__tool", text: "📍", attrs: { type: "button", title: "Pick a location on the ground", "aria-label": "Pick a location" } });
  const micButton = el("button", { className: "architect__tool architect__mic", text: "🎤", attrs: { type: "button", "aria-label": "Speak an instruction" } });
  const handsFreeButton = el("button", {
    className: "architect__tool architect__hands-free",
    text: "🔊",
    attrs: { type: "button", "aria-label": "Hands-free: read questions aloud and listen for the answers", "aria-pressed": "false" }
  });
  const sendButton = el("button", { className: "architect__send", text: "Send", attrs: { type: "submit" } });
  const voiceNote = el("p", { className: "architect__voice-note" });
  voiceNote.hidden = true;

  const composer = el("form", { className: "architect__composer" }, [pickButton, input, micButton, handsFreeButton, sendButton]);

  const collapseButton = el("button", { className: "architect__collapse", text: "–", attrs: { type: "button", title: "Minimise", "aria-label": "Minimise the architect panel" } });
  const header = el("header", { className: "architect__header" }, [
    el("span", { className: "architect__mark", text: "✦", attrs: { "aria-hidden": "true" } }),
    el("span", { className: "architect__title", text: "EAVARA Architect" }),
    el("span", { className: "architect__badge", text: "works offline", attrs: { title: "Site, location, design and every build stage run locally - no AI server needed" } }),
    collapseButton
  ]);

  const stepper = el(
    "ol",
    { className: "copilot__steps", attrs: { "aria-label": "What the architect is doing" } },
    COPILOT_STEPS.map((step) => el("li", { className: "copilot__step", attrs: { "data-step": step.id } }, [el("span", { className: "copilot__dot", attrs: { "aria-hidden": "true" } }), el("span", { text: step.label })]))
  );
  const stateLine = el("p", { className: "copilot__state", attrs: { role: "status", "aria-live": "polite" } });
  const transcriptLine = el("p", { className: "copilot__transcript" });
  const levelBars = el("div", { className: "copilot__level", attrs: { "aria-hidden": "true" } }, Array.from({ length: 14 }, () => el("span", { className: "copilot__bar" })));
  levelBars.hidden = true; // shown only while a real microphone level arrives
  const stopButton = el("button", { className: "copilot__stop", text: "■ Stop", attrs: { type: "button", title: "Stop speaking and listening now" } });
  const status = el("div", { className: "copilot__status" }, [stepper, el("div", { className: "copilot__state-row" }, [levelBars, stateLine, stopButton]), transcriptLine]);
  const body = el("div", { className: "architect__body" }, [stages, status, log, composer, voiceNote]);
  const element = el("aside", { className: "architect", attrs: { "aria-label": "EAVARA Architect" } }, [header, body]);

  let busy = false;
  let activeChoices: HTMLElement | null = null;
  /** The latest reply - what a spoken answer is matched against, and what hands-free reads out when turned on. */
  let lastReply: ArchitectReply | null = null;
  let copilot: CopilotState = INITIAL_COPILOT_STATE;
  const gate = createInputGate();
  let levelHistory: number[] = [];

  const renderCopilot = (): void => {
    const statuses = stepStatuses(copilot);
    stepper.querySelectorAll("li").forEach((item, index) => {
      item.className = `copilot__step copilot__step--${statuses[index]}`;
    });
    stateLine.textContent = copilot.detail;
    stateLine.className = `copilot__state copilot__state--${copilot.phase}`;
    transcriptLine.hidden = copilot.transcript.length === 0;
    transcriptLine.textContent = copilot.transcript ? `“${copilot.transcript}”` : "";
    stopButton.hidden = !(copilot.phase === "listening" || copilot.phase === "transcribing" || handsFree.speaking || handsFree.enabled);
    status.hidden = copilot.phase === "idle" && copilot.detail.length === 0 && !handsFree.enabled;
  };
  const dispatch = (event: CopilotEvent): void => {
    copilot = nextCopilotState(copilot, event);
    renderCopilot();
  };
  const meter = createLevelMeter((level) => {
    levelBars.hidden = level === null;
    if (level === null) {
      levelHistory = [];
      return;
    }
    levelHistory = [...levelHistory.slice(-13), level];
    levelBars.querySelectorAll("span").forEach((bar, index) => {
      const value = levelHistory[index - (14 - levelHistory.length)] ?? 0;
      (bar as HTMLElement).style.height = `${Math.max(8, Math.round(value * 100))}%`;
    });
  });

  const setBusy = (value: boolean): void => {
    busy = value;
    input.disabled = value;
    sendButton.disabled = value;
    pickButton.disabled = value;
    element.classList.toggle("architect--busy", value);
  };

  const scrollToEnd = (): void => {
    log.scrollTop = log.scrollHeight;
  };

  const addUserMessage = (text: string): void => {
    log.append(el("div", { className: "architect__msg architect__msg--user", text }));
    scrollToEnd();
  };

  const retireChoices = (): void => {
    if (activeChoices) {
      for (const button of activeChoices.querySelectorAll("button")) button.disabled = true;
      activeChoices.classList.add("architect__choices--used");
      activeChoices = null;
    }
  };

  const renderChoices = (choices: readonly ArchitectChoice[]): HTMLElement | null => {
    if (choices.length === 0) return null;
    const row = el(
      "div",
      { className: "architect__choices" },
      choices.map((choice) => {
        const button = el("button", { className: "architect__choice", text: choice.label, attrs: { type: "button" } });
        button.addEventListener("click", () => {
          if (!busy) void send(choice.say, choice.label);
        });
        return button;
      })
    );
    return row;
  };

  const showReply = (reply: ArchitectReply): void => {
    const tags = [
      ...(reply.source === "ai" ? [el("span", { className: "copilot__tag copilot__tag--ai", text: "AI model", attrs: { title: "Answered by the AI model through the backend" } })] : []),
      ...(reply.preview ? [el("span", { className: "copilot__tag copilot__tag--preview", text: "Preview", attrs: { title: "Nothing is built until you confirm" } })] : []),
      ...(reply.applied
        ? [
            reply.undone
              ? el("span", { className: "copilot__tag copilot__tag--applied", text: "Undone ✓", attrs: { title: "The last change was reversed in the scene" } })
              : el("span", { className: "copilot__tag copilot__tag--applied", text: "Applied ✓", attrs: { title: "The scene changed" } })
          ]
        : [])
    ];
    const message = el("div", { className: `architect__msg architect__msg--architect architect__msg--${reply.tone}` }, [
      ...(tags.length > 0 ? [el("div", { className: "copilot__tags" }, tags)] : []),
      el("p", { className: "architect__text", text: reply.text })
    ]);
    const choices = renderChoices(reply.choices);
    if (choices) {
      message.append(choices);
      activeChoices = choices;
    }
    log.append(message);
    scrollToEnd();
    if (reply.hideIds && reply.hideIds.length > 0) {
      options.onSetHidden(reply.hideIds, true);
    }
    if (reply.showIds && reply.showIds.length > 0) {
      options.onSetHidden(reply.showIds, false);
    }
    if (reply.focusIds && reply.focusIds.length > 0) {
      options.onFocus(reply.focusIds);
    }
    if (reply.pickLocation) {
      startPick(reply.pickLocation.footprint);
    }
    lastReply = reply;
    handsFree.replied(reply);
  };

  const startPick = (footprint: HouseFootprint | null): void => {
    element.classList.add("architect--picking");
    options.onPickLocation(footprint, (point) => {
      element.classList.remove("architect--picking");
      if (!point) {
        showReply({ text: "Location pick cancelled. Click 📍 to try again, or type coordinates like “at 4, -2”.", tone: "info", choices: [] });
        return;
      }
      retireChoices();
      addUserMessage(`📍 (${fmt(point.x)}, ${fmt(point.z)})`);
      const picked = session.pickedLocation(point);
      dispatch({ type: "reply", reply: picked });
      showReply(picked);
    });
  };

  async function send(text: string, shown = text): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) return;
    const admitted = gate.admit(trimmed, busy, Date.now());
    if (admitted === "duplicate") return;
    if (admitted === "queued") {
      setNote(`Queued: “${trimmed}” - I'll take it as soon as the current answer is in.`);
      return;
    }
    retireChoices();
    addUserMessage(shown);
    input.value = "";
    setBusy(true);
    dispatch({ type: "sent", text: trimmed });
    try {
      const reply = await session.handle(trimmed);
      dispatch({ type: "reply", reply });
      showReply(reply);
    } catch (error) {
      const failure: ArchitectReply = { text: `Something went wrong: ${error instanceof Error ? error.message : String(error)} Nothing was changed.`, tone: "error", choices: [] };
      dispatch({ type: "reply", reply: failure });
      showReply(failure);
    } finally {
      setBusy(false);
      input.focus();
      const next = gate.takeQueued();
      if (next) void send(next, next);
    }
  }

  composer.addEventListener("submit", (event) => {
    event.preventDefault();
    // Sending the box while recognition is still running: the box is what's sent - drop the speech session, so its final words don't run a second time.
    if (voice.listening) voice.cancel();
    void send(input.value);
  });
  input.addEventListener("keydown", (event) => {
    // The form's own submit handles a plain Enter; this only stops an IME-composition Enter from submitting half-typed text.
    if (event.key === "Enter" && !isAiPromptSubmitKey(event)) event.preventDefault();
  });
  pickButton.addEventListener("click", () => void send("Pick a location", "📍 Pick a location"));

  const setNote = (text: string | null, error = false): void => {
    voiceNote.hidden = text === null;
    voiceNote.textContent = text ?? "";
    voiceNote.classList.toggle("architect__voice-note--error", error);
  };

  const voice = createVoiceInput({
    onInterim: (text) => {
      input.value = text;
      if (text) dispatch({ type: "interim", text });
    },
    onFinal: (text) => {
      dispatch({ type: "heard", text });
      handsFree.heard();
      // "Concrete block", "build it", "pick another spot": a spoken choice
      // sends that choice; anything else is sent as said - with numbers
      // said in words as digits ("four by five" → "4 by 5"), shown openly.
      const choice = lastReply ? matchSpokenChoice(text, lastReply.choices) : null;
      const said = spokenNumbers(text);
      void send(choice ? choice.say : said, said === text || choice ? `🎤 ${text}` : `🎤 ${text} → “${said}”`);
    },
    onState: (state: VoiceState, message?: string, code?: string) => {
      micButton.classList.toggle("architect__mic--listening", state === "listening");
      micButton.setAttribute("aria-pressed", String(state === "listening"));
      if (state === "listening") {
        dispatch({ type: "listening" });
        meter.start();
      } else {
        meter.stop();
        if (state === "error") dispatch({ type: "voice-error", message: message ?? "Speech recognition stopped." });
        else if (copilot.phase === "listening") dispatch({ type: "stopped" });
      }
      if (handsFree.enabled) {
        if (state === "error") handsFree.listenerError(code ?? "", message ?? "Speech recognition stopped.");
        return;
      }
      setNote(state === "idle" ? null : state === "listening" ? "Listening… speak your instruction." : (message ?? ""), state === "error");
    },
    onEnd: () => handsFree.listenerEnded()
  });

  const handsFree = createHandsFree({
    speech: createSpeechOutput(),
    listener: voice,
    onStatus: (status: HandsFreeStatus) => {
      const on = status.kind === "speaking" || status.kind === "listening";
      handsFreeButton.setAttribute("aria-pressed", String(on));
      handsFreeButton.classList.toggle("architect__hands-free--on", on);
      renderCopilot();
      if (status.kind === "speaking") setNote("🔊 Speaking… (hands-free)");
      else if (status.kind === "listening") setNote("🎤 Listening… answer out loud, or type.");
      else if (status.kind === "stopped") setNote(status.message, true);
      else setNote(null);
    }
  });
  if (voice.supported) {
    micButton.title = "Speak an instruction";
    micButton.addEventListener("click", () => {
      if (handsFree.speaking) {
        handsFree.bargeIn();
        return;
      }
      if (!busy) voice.toggle();
    });
    handsFreeButton.title = createSpeechOutput()
      ? "Hands-free: I read each question aloud and listen for your answer"
      : "Hands-free: I listen for your answer after each question (this browser can't speak, so read the questions here)";
    handsFreeButton.addEventListener("click", () => {
      if (handsFree.enabled) handsFree.setEnabled(false);
      else handsFree.enableWith(lastReply);
    });
  } else {
    micButton.disabled = true;
    micButton.title = "Voice input needs the Web Speech API - use Chrome or Edge. Typing works everywhere.";
    handsFreeButton.disabled = true;
    handsFreeButton.title = "Hands-free needs speech recognition - use Chrome or Edge. Typing works everywhere.";
  }

  stopButton.addEventListener("click", () => {
    if (handsFree.enabled || handsFree.speaking) handsFree.interrupt();
    // Stop means stop: whatever was half-heard is dropped, never sent.
    voice.cancel();
    if (input.value && copilot.phase === "transcribing") input.value = "";
    meter.stop();
    dispatch({ type: "stopped" });
  });

  collapseButton.addEventListener("click", () => {
    const collapsed = element.classList.toggle("architect--collapsed");
    collapseButton.textContent = collapsed ? "+" : "–";
    collapseButton.title = collapsed ? "Expand" : "Minimise";
    collapseButton.setAttribute("aria-label", collapsed ? "Expand the architect panel" : "Minimise the architect panel");
  });

  session.subscribe((state: ArchitectViewState) => {
    stages.hidden = !state.stages;
    stages.replaceChildren(
      ...(state.stages ?? []).map((stage) =>
        el("li", { className: `architect__stage architect__stage--${stage.status}`, attrs: { title: `${stage.label}: ${stage.status === "done" ? "built" : stage.status === "next" ? "next" : "to do"}` } }, [
          el("span", { className: "architect__stage-dot", attrs: { "aria-hidden": "true" } }),
          el("span", { className: "architect__stage-label", text: stage.label })
        ])
      )
    );
  });

  showReply(session.greeting());
  renderCopilot();

  return {
    element,
    focusInput: () => {
      element.classList.remove("architect--collapsed");
      collapseButton.textContent = "–";
      input.focus();
    }
  };
}
