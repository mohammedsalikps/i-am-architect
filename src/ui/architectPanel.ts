import { el } from "./dom";
import { createVoiceInput } from "./voiceInput";
import type { VoiceState } from "./voiceInput";
import { createHandsFree, createSpeechOutput, matchSpokenChoice, spokenNumbers } from "./handsFree";
import type { HandsFreeStatus } from "./handsFree";
import { COMPANION_STATE_LABEL, COPILOT_STEPS, INITIAL_COPILOT_STATE, companionStateOf, createInputGate, nextCopilotState, stepStatuses } from "./copilotState";
import type { CompanionState, CopilotEvent, CopilotState } from "./copilotState";
import { SHELL_ICONS } from "./shellIcons";
import { createLevelMeter } from "./levelMeter";
import { createTurnController } from "./turnController";
import { LANGUAGE_CHOICES, PAUSE_CHOICES, chooseVoice, readVoiceSettings, saveVoiceSettings } from "./voiceSettings";
import type { SettingsStorage, VoiceSettings } from "./voiceSettings";
import { isAiPromptSubmitKey } from "../engine/ai/AiPromptController";
import type { ArchitectChoice, ArchitectReply, ArchitectSession, ArchitectViewState } from "../engine/architect/ArchitectSession";
import type { PlanPoint } from "../engine/architect/parseUtterance";
import type { HouseFootprint } from "../engine/ai/housePlan";

/**
 * The EAVARA Architect conversation, in the workspace's assistant drawer
 * (ui/layout.ts): a transcript, the latest reply's suggested answers as chips,
 * a progress strip for the house's six build stages, and a composer with
 * a location-pick button and a microphone.
 *
 * Owns no design state. Every turn - typed, spoken, or a chip click - goes
 * to `session.handle()`, and everything shown comes back from it (see
 * engine/architect/ArchitectSession.ts). The two things it does on the
 * session's behalf are viewport actions: framing the objects a turn built
 * (`onFocus`) and arming a ground pick when the session asks for a
 * location (`onPickLocation`).
 *
 * Turns are cancellable (turnController.ts): Stop cancels the one in
 * flight, and a new turn while one is thinking replaces it - a reply that
 * arrives after either never changes the model, and is neither shown nor
 * read aloud. With "interrupt by speaking" on, the microphone stays open
 * while a reply is read, and the user's own words (not the reply echoing
 * back) stop the speech at once and become the next turn.
 */
export interface ArchitectPanelOptions {
  session: ArchitectSession;
  onFocus: (objectIds: string[]) => void;
  /** Arms a one-click ground pick, previewing `footprint`; calls `done` with the point, or null if cancelled. */
  onPickLocation: (footprint: HouseFootprint | null, done: (point: PlanPoint | null) => void) => void;
  /** Hides or shows objects in the viewport (a view setting, never the model) - "show me the living room" lifts the roof out of the way. */
  onSetHidden: (objectIds: readonly string[], hidden: boolean) => void;
  /** Where the voice settings are remembered (localStorage); null: for this page only. */
  storage?: SettingsStorage | null;
  /** The panel lives in a drawer: its header button closes the drawer (the conversation is kept) instead of minimising the panel in place. */
  onClose?: () => void;
}

/** What the assistant is doing, and how many replies it has given - for the button that opens it. */
export interface ArchitectActivity {
  state: CompanionState;
  replies: number;
}

export interface ArchitectPanel {
  element: HTMLElement;
  focusInput(): void;
  /** A turn is waiting on the sign-in dialog (main.ts's AI fallback): the header says "Waiting", not "Thinking". */
  setWaitingForSignIn(waiting: boolean): void;
  /** Calls `listener` now and whenever the state or the reply count changes; returns an unsubscribe. */
  subscribeActivity(listener: (activity: ArchitectActivity) => void): () => void;
}

/** Picked points are kept to 0.1 m (see ArchitectSession.pickedLocation) - shown the same way. */
function fmt(value: number): string {
  return String(Math.round(value * 10) / 10);
}

/** A labelled tool button: an icon and a word, so nobody has to guess what it does. */
function toolButton(className: string, icon: string, label: string, ariaLabel: string): HTMLButtonElement {
  return el("button", { className: `architect__tool ${className}`, attrs: { type: "button", "aria-label": ariaLabel } }, [
    el("span", { className: "architect__tool-icon", text: icon, attrs: { "aria-hidden": "true" } }),
    el("span", { className: "architect__tool-label", text: label })
  ]) as HTMLButtonElement;
}

function speechVoices(): SpeechSynthesisVoice[] {
  try {
    return typeof window !== "undefined" && "speechSynthesis" in window ? window.speechSynthesis.getVoices() : [];
  } catch {
    return [];
  }
}

export function createArchitectPanel(options: ArchitectPanelOptions): ArchitectPanel {
  const { session } = options;
  const storage = options.storage ?? null;
  let settings: VoiceSettings = readVoiceSettings(storage);

  const log = el("div", { className: "architect__log", attrs: { role: "log", "aria-live": "polite", "aria-label": "Conversation with the EAVARA architect" } });
  const stages = el("ol", { className: "architect__stages", attrs: { "aria-label": "Build stages" } });
  stages.hidden = true;

  const input = el("input", {
    className: "architect__input",
    attrs: { type: "text", placeholder: "Describe your site, a room, or a change…", "aria-label": "Instruction for the architect", autocomplete: "off" }
  }) as HTMLInputElement;
  const pickButton = toolButton("architect__pick", "📍", "Pick", "Pick a location on the ground");
  pickButton.title = "Pick a location on the ground";
  const micButton = toolButton("architect__mic", "🎤", "Speak", "Speak an instruction");
  const handsFreeButton = toolButton("architect__hands-free", "🔊", "Hands-free", "Hands-free: read replies aloud and listen for the answers");
  handsFreeButton.setAttribute("aria-pressed", "false");
  const settingsButton = toolButton("architect__voice-settings-toggle", "⚙", "Voice", "Voice settings");
  settingsButton.setAttribute("aria-expanded", "false");
  settingsButton.title = "Voice settings: language, voice, pause before your turn ends, interrupting";
  const sendButton = el("button", { className: "architect__send", text: "Send", attrs: { type: "submit" } });
  const voiceNote = el("p", { className: "architect__voice-note" });
  voiceNote.hidden = true;

  const composer = el("form", { className: "architect__composer" }, [pickButton, input, micButton, handsFreeButton, settingsButton, sendButton]);

  // --- voice settings ---
  const field = (label: string, control: HTMLElement): HTMLElement => el("label", { className: "architect__setting" }, [el("span", { className: "architect__setting-label", text: label }), control]);
  const languageSelect = el("select", { className: "architect__select", attrs: { "aria-label": "Language for listening and speaking" } }, LANGUAGE_CHOICES.map((choice) => el("option", { text: choice.label, attrs: { value: choice.code } }))) as HTMLSelectElement;
  const voiceSelect = el("select", { className: "architect__select", attrs: { "aria-label": "Voice for spoken replies" } }) as HTMLSelectElement;
  const pauseSelect = el("select", { className: "architect__select", attrs: { "aria-label": "Pause that ends your turn" } }, PAUSE_CHOICES.map((choice) => el("option", { text: choice.label, attrs: { value: String(choice.ms) } }))) as HTMLSelectElement;
  const lengthSelect = el("select", { className: "architect__select", attrs: { "aria-label": "How much of each reply is read aloud" } }, [
    el("option", { text: "Short - the gist and the question", attrs: { value: "short" } }),
    el("option", { text: "Full - everything on screen", attrs: { value: "full" } })
  ]) as HTMLSelectElement;
  const bargeInBox = el("input", { attrs: { type: "checkbox" } }) as HTMLInputElement;
  const bargeInLabel = el("label", { className: "architect__setting architect__setting--check" }, [bargeInBox, el("span", { text: "Speaking over a reply interrupts it - use headphones (with speakers it would hear itself). 🎤 Speak and Stop always interrupt." })]);
  const voiceDescription = el("p", { className: "architect__setting-note", attrs: { role: "status" } });
  const settingsPanel = el("section", { className: "architect__voice-settings", attrs: { "aria-label": "Voice settings" } }, [
    field("Language", languageSelect),
    field("Voice", voiceSelect),
    field("Your turn ends after a pause of", pauseSelect),
    field("Read replies", lengthSelect),
    bargeInLabel,
    voiceDescription
  ]);
  settingsPanel.hidden = true;

  const collapseButton = el("button", { className: "architect__collapse", text: "–", attrs: { type: "button", title: "Minimise", "aria-label": "Minimise the architect panel" } });
  const stateChip = el("span", { className: "architect__state architect__state--ready", text: "Ready", attrs: { role: "status", "aria-live": "polite", title: "What the architect is doing" } });
  const header = el("header", { className: "architect__header" }, [
    el("span", { className: "architect__mark", text: "✦", attrs: { "aria-hidden": "true" } }),
    el("span", { className: "architect__title", text: "EAVARA Architect" }),
    stateChip,
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
  const stopButton = el("button", { className: "copilot__stop", text: "■ Stop", attrs: { type: "button", title: "Stop speaking, listening and any request still thinking - nothing half-done is applied" } });
  const status = el("div", { className: "copilot__status" }, [stepper, el("div", { className: "copilot__state-row" }, [levelBars, stateLine, stopButton]), transcriptLine]);
  const body = el("div", { className: "architect__body" }, [stages, status, log, settingsPanel, composer, voiceNote]);
  const element = el("aside", { className: "architect", attrs: { "aria-label": "EAVARA Architect" } }, [header, body]);

  let activeChoices: HTMLElement | null = null;
  /** The latest reply - what a spoken answer is matched against, and what hands-free reads out when turned on. */
  let lastReply: ArchitectReply | null = null;
  let copilot: CopilotState = INITIAL_COPILOT_STATE;
  const gate = createInputGate();
  let levelHistory: number[] = [];
  let stopped = false;
  const turns = createTurnController<ArchitectReply>((text, { signal }) => session.handle(text, { signal }));

  let waitingForSignIn = false;
  const activityListeners = new Set<(activity: ArchitectActivity) => void>();
  let replyCount = 0;
  let lastActivity: ArchitectActivity | null = null;
  const companionState = () =>
    companionStateOf({ speaking: handsFree.speaking, listening: voice.listening, busy: turns.busy, waitingForSignIn, stopped, applied: copilot.phase === "applied" });
  const emitActivity = (): void => {
    const activity = { state: companionState(), replies: replyCount };
    if (lastActivity && lastActivity.state === activity.state && lastActivity.replies === activity.replies) return;
    lastActivity = activity;
    for (const listener of activityListeners) listener(activity);
  };
  const renderState = (): void => {
    const state = companionState();
    emitActivity();
    stateChip.textContent = COMPANION_STATE_LABEL[state];
    stateChip.title = state === "waiting" ? "Waiting for you to sign in - or to continue without an account" : "What the architect is doing";
    stateChip.className = `architect__state architect__state--${state}`;
    element.classList.toggle("architect--busy", turns.busy);
  };

  const renderCopilot = (): void => {
    const statuses = stepStatuses(copilot);
    stepper.querySelectorAll("li").forEach((item, index) => {
      item.className = `copilot__step copilot__step--${statuses[index]}`;
    });
    // The step tracker only while a turn is under way; at rest, the one state line says it all.
    stepper.hidden = copilot.phase === "idle" || copilot.phase === "applied" || copilot.phase === "error";
    stateLine.textContent = copilot.detail;
    stateLine.className = `copilot__state copilot__state--${copilot.phase}`;
    transcriptLine.hidden = copilot.transcript.length === 0;
    transcriptLine.textContent = copilot.transcript ? `“${copilot.transcript}”` : "";
    stopButton.hidden = !(copilot.phase === "listening" || copilot.phase === "transcribing" || handsFree.speaking || handsFree.enabled || turns.busy);
    status.hidden = copilot.phase === "idle" && copilot.detail.length === 0 && !handsFree.enabled && !turns.busy;
    renderState();
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

  const scrollToEnd = (): void => {
    log.scrollTop = log.scrollHeight;
  };

  const addUserMessage = (text: string): HTMLElement => {
    const message = el("div", { className: "architect__msg architect__msg--user", text });
    log.append(message);
    scrollToEnd();
    return message;
  };

  /** A quiet line in the conversation (a cancelled or replaced request) - never read aloud. */
  const addNote = (text: string): void => {
    log.append(el("div", { className: "architect__msg architect__msg--note", text, attrs: { role: "note" } }));
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
        button.addEventListener("click", () => void send(choice.say, choice.label));
        return button;
      })
    );
    return row;
  };

  const showReply = (reply: ArchitectReply): void => {
    replyCount += 1;
    emitActivity();
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
        showReply({ text: "Location pick cancelled. Click 📍 Pick to try again, or type coordinates like “at 4, -2”.", tone: "info", choices: [] });
        return;
      }
      retireChoices();
      addUserMessage(`📍 (${fmt(point.x)}, ${fmt(point.z)})`);
      const picked = session.pickedLocation(point);
      dispatch({ type: "reply", reply: picked });
      showReply(picked);
    });
  };

  /**
   * One turn. A turn still thinking is replaced by this one (cancelled
   * first - its late reply changes nothing and is never shown or spoken).
   */
  async function send(text: string, shown = text): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) return;
    // The same words twice within a moment (a spoken final and a typed Send of the same box) run once.
    if (gate.admit(trimmed, false, Date.now()) === "duplicate") return;
    stopped = false;
    retireChoices();
    addUserMessage(shown);
    input.value = "";
    dispatch({ type: "sent", text: trimmed });
    const turn = turns.send(trimmed);
    renderCopilot(); // now busy: Thinking, with Stop
    const outcome = await turn;
    if (outcome.kind === "cancelled") {
      addNote(
        outcome.reason === "stopped"
          ? `Stopped - “${trimmed}” was cancelled before it changed anything.`
          : `Replaced - “${trimmed}” was cancelled in favour of your newer instruction; it changed nothing.`
      );
      renderCopilot();
      return;
    }
    const reply: ArchitectReply =
      outcome.kind === "failed"
        ? { text: `Something went wrong: ${outcome.error instanceof Error ? outcome.error.message : String(outcome.error)} Nothing was changed.`, tone: "error", choices: [] }
        : outcome.reply;
    if (reply.cancelled) {
      addNote(`“${trimmed}” was cancelled before it changed anything.`);
      renderCopilot();
      return;
    }
    dispatch({ type: "reply", reply });
    showReply(reply);
    renderCopilot();
    if (document.activeElement === document.body || document.activeElement === null) input.focus();
  }

  composer.addEventListener("submit", (event) => {
    event.preventDefault();
    // Sending the box while recognition is still running: the box is what's sent - drop the speech session, so its final words don't run a second time.
    if (voice.listening) voice.cancel();
    // Typing a correction while a reply is read: stop reading it.
    if (handsFree.speaking) handsFree.bargeIn();
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
    lang: settings.lang,
    pauseMs: settings.pauseMs,
    onInterim: (heardText) => {
      // While a reply is read with the mic open: only the user's own words count - and they interrupt it.
      if (handsFree.speaking && !handsFree.heardWhileSpeaking(heardText)) return;
      const text = handsFree.userWords(heardText);
      input.value = text;
      if (text) dispatch({ type: "interim", text });
    },
    onFinal: (heardText) => {
      const text = handsFree.acceptFinal(heardText);
      if (!text) return; // only the reply echoing back
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
      // The browser's own no-speech timeout while the mic is only held open during a reply: not an error to show (hands-free reopens it).
      if (state === "error" && code === "no-speech" && handsFree.speaking) {
        handsFree.listenerError(code, message ?? "");
        renderState();
        return;
      }
      if (state === "listening") {
        handsFree.sessionStarted();
        if (!handsFree.speaking) dispatch({ type: "listening" });
        meter.start();
      } else {
        meter.stop();
        if (state === "error") dispatch({ type: "voice-error", message: message ?? "Speech recognition stopped." });
        else if (copilot.phase === "listening") dispatch({ type: "stopped" });
      }
      renderState();
      if (handsFree.enabled) {
        if (state === "error") handsFree.listenerError(code ?? "", message ?? "Speech recognition stopped.");
        return;
      }
      setNote(state === "idle" ? null : state === "listening" ? "Listening… speak your instruction; a pause ends your turn." : (message ?? ""), state === "error");
    },
    onEnd: () => handsFree.listenerEnded()
  });

  /** The voice replies are read with - recomputed per reply, since the browser's voice list loads late. */
  const currentVoice = (): SpeechSynthesisVoice | null => chooseVoice(speechVoices(), settings).voice;
  const speechOutput = createSpeechOutput(() => ({ voice: currentVoice(), lang: settings.lang }));
  const handsFree = createHandsFree({
    speech: speechOutput,
    listener: voice,
    bargeIn: () => settings.bargeIn,
    replyLength: () => settings.replyLength,
    onStatus: (status: HandsFreeStatus) => {
      const on = status.kind === "speaking" || status.kind === "listening";
      handsFreeButton.setAttribute("aria-pressed", String(on));
      handsFreeButton.classList.toggle("architect__hands-free--on", on);
      renderCopilot();
      if (status.kind === "speaking") setNote(settings.bargeIn ? "🔊 Speaking… talk over me, or press Stop, to interrupt." : "🔊 Speaking… press 🎤 Speak or Stop to interrupt.");
      else if (status.kind === "listening") setNote("🎤 Listening… answer out loud, or type.");
      else if (status.kind === "stopped") setNote(status.message, true);
      else setNote(null);
    }
  });
  if (voice.supported) {
    micButton.title = "Speak an instruction (a pause ends your turn)";
    micButton.addEventListener("click", () => {
      if (handsFree.speaking) {
        handsFree.bargeIn();
        return;
      }
      // Speaking while the architect is still thinking is allowed: what you say replaces that request.
      voice.toggle();
    });
    handsFreeButton.title = speechOutput
      ? "Hands-free: I read each reply aloud and listen for your answer"
      : "Hands-free: I listen for your answer after each reply (this browser can't speak, so read the replies here)";
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
    // Stop means stop: whatever was half-heard is dropped, never sent - and a request still thinking is cancelled unapplied.
    voice.cancel();
    if (input.value && copilot.phase === "transcribing") input.value = "";
    meter.stop();
    turns.stop();
    stopped = true;
    dispatch({ type: "stopped" });
  });

  // --- voice settings: shown values, changes saved and applied at once ---
  const fillVoices = (): void => {
    const family = settings.lang.split("-")[0].toLowerCase();
    const voices = speechVoices().filter((candidate) => candidate.lang.replace(/_/g, "-").toLowerCase().split("-")[0] === family);
    voiceSelect.replaceChildren(
      el("option", { text: "Automatic - best for the language", attrs: { value: "" } }),
      ...voices.map((candidate) => el("option", { text: `${candidate.name} (${candidate.lang})`, attrs: { value: candidate.voiceURI } }))
    );
    voiceSelect.value = settings.voiceURI && voices.some((candidate) => candidate.voiceURI === settings.voiceURI) ? settings.voiceURI : "";
    voiceDescription.textContent = speechOutput ? chooseVoice(speechVoices(), settings).note : "This browser can't speak replies - they stay on screen.";
  };
  const showSettings = (): void => {
    languageSelect.value = settings.lang;
    pauseSelect.value = String(settings.pauseMs);
    lengthSelect.value = settings.replyLength;
    bargeInBox.checked = settings.bargeIn;
    fillVoices();
  };
  const update = (changes: Partial<VoiceSettings>): void => {
    settings = { ...settings, ...changes };
    saveVoiceSettings(storage, settings);
    voice.setLanguage(settings.lang);
    voice.setPauseMs(settings.pauseMs);
    showSettings();
  };
  languageSelect.addEventListener("change", () => update({ lang: languageSelect.value, voiceURI: null }));
  voiceSelect.addEventListener("change", () => update({ voiceURI: voiceSelect.value || null }));
  pauseSelect.addEventListener("change", () => update({ pauseMs: Number(pauseSelect.value) }));
  lengthSelect.addEventListener("change", () => update({ replyLength: lengthSelect.value === "full" ? "full" : "short" }));
  bargeInBox.addEventListener("change", () => update({ bargeIn: bargeInBox.checked }));
  settingsButton.addEventListener("click", () => {
    settingsPanel.hidden = !settingsPanel.hidden;
    settingsButton.setAttribute("aria-expanded", String(!settingsPanel.hidden));
    settingsButton.classList.toggle("architect__tool--on", !settingsPanel.hidden);
    if (!settingsPanel.hidden) showSettings();
  });
  if (typeof window !== "undefined" && "speechSynthesis" in window) {
    // The browser's voice list arrives after the page loads.
    window.speechSynthesis.addEventListener?.("voiceschanged", () => {
      if (!settingsPanel.hidden) fillVoices();
    });
  }
  showSettings();

  const onClose = options.onClose;
  if (onClose) {
    collapseButton.innerHTML = SHELL_ICONS.close;
    collapseButton.title = "Close the assistant - the conversation is kept";
    collapseButton.setAttribute("aria-label", "Close the assistant");
  }
  collapseButton.addEventListener("click", () => {
    if (onClose) {
      onClose();
      return;
    }
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
      if (!onClose) collapseButton.textContent = "–";
      // Opened (the drawer, after replies arrived while it was closed): show the newest reply, not where it was left.
      log.scrollTop = log.scrollHeight;
      input.focus();
    },
    setWaitingForSignIn: (waiting) => {
      waitingForSignIn = waiting;
      renderState();
    },
    subscribeActivity(listener) {
      activityListeners.add(listener);
      listener({ state: companionState(), replies: replyCount });
      return () => activityListeners.delete(listener);
    }
  };
}
