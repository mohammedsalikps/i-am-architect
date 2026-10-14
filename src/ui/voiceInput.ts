/**
 * Voice commands for the architect panel, through the browser's own Web
 * Speech API (SpeechRecognition - `webkitSpeechRecognition` in Chrome and
 * Edge). No audio leaves the app through any code of ours: the browser
 * runs recognition itself and hands back text, which goes through exactly
 * the same path as a typed instruction.
 *
 * End of turn is decided here, not by the browser: recognition runs
 * continuously and your turn ends only after `pauseMs` of silence AFTER
 * you've spoken (a short pause mid-sentence keeps listening), or after
 * `silenceMs` with nothing said at all. While a reply is read out the
 * session can be held open (holdOpen) so speaking over it can interrupt.
 *
 * Where the API doesn't exist (Firefox, the Android WebView), `supported`
 * is false and the panel disables its mic button with an explanation -
 * typing still works everywhere.
 */

/** The slice of the Web Speech API this file uses - not in TypeScript's DOM lib. */
interface SpeechRecognitionResultLike {
  readonly isFinal: boolean;
  readonly 0: { transcript: string };
}
interface SpeechRecognitionEventLike {
  readonly resultIndex: number;
  readonly results: { readonly length: number; readonly [index: number]: SpeechRecognitionResultLike };
}
interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  maxAlternatives: number;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

export type VoiceState = "idle" | "listening" | "error";

export interface Timers {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface VoiceInputOptions {
  /** Partial text while the user is still speaking. */
  onInterim: (text: string) => void;
  /** The finished utterance. */
  onFinal: (text: string) => void;
  /** `code` is the Web Speech API's own error name ("not-allowed", "no-speech"...) when state is "error". */
  onState: (state: VoiceState, message?: string, code?: string) => void;
  /** Listening ended on its own (end of turn, silence, or an error) - not when stop()/cancel() ended it. For hands-free turn-taking. */
  onEnd?: () => void;
  /** Recognition language (BCP 47); defaults to the browser's. */
  lang?: string;
  /** Silence after speech that ends the turn, ms (default 1600). */
  pauseMs?: number;
  /** With nothing said at all, listening ends after this, ms (default 8000). */
  silenceMs?: number;
  /** For tests. */
  timers?: Timers;
}

export interface VoiceInput {
  readonly supported: boolean;
  /** A recognition session is open (listening, or finishing). */
  readonly listening: boolean;
  /** Starts listening, or stops if already listening. */
  toggle(): void;
  /** Starts listening (no-op while already listening; queued if a stop is still finishing). */
  start(): void;
  /** Stops listening; what was already recognised is still delivered (onFinal) - "I've finished speaking". */
  stop(): void;
  /** Stops listening and throws away whatever was heard - nothing reaches onFinal. For Stop, and for typed text sent mid-recognition. */
  cancel(): void;
  /** While true, silence never ends the session (a reply is being read out and may be interrupted by speaking). */
  holdOpen(on: boolean): void;
  /** What the open session has heard so far - empty when none is open. */
  pendingWords(): string;
  setLanguage(lang: string): void;
  setPauseMs(ms: number): void;
}

function recognitionConstructor(): SpeechRecognitionConstructor | null {
  const scope = window as unknown as { SpeechRecognition?: SpeechRecognitionConstructor; webkitSpeechRecognition?: SpeechRecognitionConstructor };
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition ?? null;
}

const ERROR_MESSAGES: Readonly<Record<string, string>> = {
  "not-allowed": "Microphone access was blocked. Allow it in the browser's site settings to speak commands.",
  "service-not-allowed": "Speech recognition isn't allowed in this browser.",
  "no-speech": "I didn't hear anything — try again.",
  "audio-capture": "No microphone was found.",
  network: "Speech recognition needs a network connection in this browser."
};

/** "make the kitchen" + "four point five" → "make the kitchen four point five" (the browser's own results usually carry the space). */
function joinWords(first: string, second: string): string {
  const a = first.trim();
  const b = second.trim();
  return a && b ? `${a} ${b}` : a || b;
}

const REAL_TIMERS: Timers = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
};

export function createVoiceInput(options: VoiceInputOptions): VoiceInput {
  const Recognition = recognitionConstructor();
  if (!Recognition) {
    const nothing = (): void => undefined;
    return { supported: false, listening: false, toggle: nothing, start: nothing, stop: nothing, cancel: nothing, holdOpen: nothing, pendingWords: () => "", setLanguage: nothing, setPauseMs: nothing };
  }
  const timers = options.timers ?? REAL_TIMERS;
  let lang = options.lang ?? (navigator.language || "en-US");
  let pauseMs = options.pauseMs ?? 1600;
  const silenceMs = options.silenceMs ?? 8000;

  let recognition: SpeechRecognitionLike | null = null;
  let finalText = "";
  /** The latest words not yet final - delivered if the turn ends on a pause before the browser finalises them. */
  let interimText = "";
  /** stop()/cancel() was asked for: this session's end is ours, not the user's. */
  let stopRequested = false;
  /** start() arrived while a stopped session was still finishing - begin again once it has. */
  let startQueued = false;
  /** cancel() was asked for: this session's words are dropped, never delivered. */
  let discard = false;
  /** The turn ended on a pause (our own timer) - the words so far are the turn. */
  let endedByPause = false;
  let held = false;
  let pauseTimer: unknown = null;
  let silenceTimer: unknown = null;

  const clearTimers = (): void => {
    if (pauseTimer !== null) timers.clear(pauseTimer);
    if (silenceTimer !== null) timers.clear(silenceTimer);
    pauseTimer = null;
    silenceTimer = null;
  };

  /** Ends the turn the way the user would - by going quiet: what was said is delivered, and hands-free carries on. */
  const endTurn = (instance: SpeechRecognitionLike): void => {
    if (recognition !== instance) return;
    endedByPause = true;
    clearTimers();
    instance.stop();
  };

  const armSilence = (instance: SpeechRecognitionLike): void => {
    if (silenceTimer !== null) timers.clear(silenceTimer);
    silenceTimer = held ? null : timers.set(() => endTurn(instance), silenceMs);
  };

  const stop = (): void => {
    startQueued = false;
    if (recognition) {
      stopRequested = true;
      clearTimers();
      recognition.stop();
    }
  };

  const cancel = (): void => {
    startQueued = false;
    if (recognition) {
      discard = true;
      stopRequested = true;
      finalText = "";
      interimText = "";
      clearTimers();
      recognition.abort();
    }
  };

  const start = (): void => {
    if (recognition) {
      if (stopRequested) startQueued = true;
      return;
    }
    begin();
  };

  const begin = (): void => {
    finalText = "";
    interimText = "";
    discard = false;
    endedByPause = false;
    let errored = false;
    const instance = new Recognition();
    instance.lang = lang;
    instance.interimResults = true;
    // Continuous: the browser doesn't end the turn at the first short pause - endTurn() does, after pauseMs.
    instance.continuous = true;
    instance.maxAlternatives = 1;
    instance.onresult = (event) => {
      // Dropped (Stop), or from a session that has already ended.
      if (discard || recognition !== instance) return;
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        if (result.isFinal) {
          finalText += result[0].transcript;
        } else {
          interim += result[0].transcript;
        }
      }
      interimText = interim;
      const heard = (finalText + interim).trim();
      options.onInterim(heard);
      if (heard) {
        // Words arrived: the turn ends only after a full pause from now.
        if (silenceTimer !== null) timers.clear(silenceTimer);
        silenceTimer = null;
        if (pauseTimer !== null) timers.clear(pauseTimer);
        pauseTimer = held ? null : timers.set(() => endTurn(instance), pauseMs);
      }
    };
    instance.onerror = (event) => {
      errored = true;
      // Our own stop() can surface as "aborted" - not an error worth showing.
      if (event.error === "aborted" && stopRequested) return;
      options.onState("error", ERROR_MESSAGES[event.error] ?? `Speech recognition stopped (${event.error}).`, event.error);
    };
    instance.onend = () => {
      clearTimers();
      recognition = null;
      // Ended on a pause: words the browser hadn't finalised yet are part of the turn too.
      const said = endedByPause ? joinWords(finalText, interimText) : finalText.trim();
      const text = discard ? "" : said;
      const stoppedByUs = stopRequested;
      stopRequested = false;
      discard = false;
      if (!errored || stoppedByUs) options.onState("idle");
      if (text) options.onFinal(text);
      if (!stoppedByUs) options.onEnd?.();
      if (startQueued) {
        startQueued = false;
        begin();
      }
    };
    recognition = instance;
    try {
      instance.start();
      options.onState("listening");
      armSilence(instance);
    } catch (error) {
      recognition = null;
      clearTimers();
      options.onState("error", error instanceof Error ? error.message : "Speech recognition couldn't start.");
    }
  };

  return {
    supported: true,
    get listening() {
      return recognition !== null;
    },
    toggle: () => (recognition ? stop() : start()),
    start,
    stop,
    cancel,
    holdOpen(on) {
      held = on;
      const instance = recognition;
      if (!instance) return;
      if (on) {
        clearTimers();
      } else if ((finalText + interimText).trim()) {
        // Words already said while it was held: the pause starts now.
        if (pauseTimer !== null) timers.clear(pauseTimer);
        pauseTimer = timers.set(() => endTurn(instance), pauseMs);
      } else {
        armSilence(instance);
      }
    },
    pendingWords() {
      return recognition && !discard ? joinWords(finalText, interimText) : "";
    },
    setLanguage(next) {
      lang = next;
    },
    setPauseMs(ms) {
      pauseMs = ms;
    }
  };
}
