/**
 * Voice commands for the architect panel, through the browser's own Web
 * Speech API (SpeechRecognition - `webkitSpeechRecognition` in Chrome and
 * Edge). No audio leaves the app through any code of ours: the browser
 * runs recognition itself and hands back text, which goes through exactly
 * the same path as a typed instruction.
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
}
type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

export type VoiceState = "idle" | "listening" | "error";

export interface VoiceInputOptions {
  /** Partial text while the user is still speaking. */
  onInterim: (text: string) => void;
  /** The finished utterance. */
  onFinal: (text: string) => void;
  /** `code` is the Web Speech API's own error name ("not-allowed", "no-speech"...) when state is "error". */
  onState: (state: VoiceState, message?: string, code?: string) => void;
  /** Listening ended on its own (a result, silence, or an error) - not when stop() ended it. For hands-free turn-taking. */
  onEnd?: () => void;
}

export interface VoiceInput {
  readonly supported: boolean;
  /** Starts listening, or stops if already listening. */
  toggle(): void;
  /** Starts listening (no-op while already listening; queued if a stop is still finishing). */
  start(): void;
  stop(): void;
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

export function createVoiceInput(options: VoiceInputOptions): VoiceInput {
  const Recognition = recognitionConstructor();
  if (!Recognition) {
    return { supported: false, toggle: () => undefined, start: () => undefined, stop: () => undefined };
  }

  let recognition: SpeechRecognitionLike | null = null;
  let finalText = "";
  /** stop() was asked for: this session's end is ours, not the user's. */
  let stopRequested = false;
  /** start() arrived while a stopped session was still finishing - begin again once it has. */
  let startQueued = false;

  const stop = (): void => {
    startQueued = false;
    if (recognition) {
      stopRequested = true;
      recognition.stop();
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
    let errored = false;
    const instance = new Recognition();
    instance.lang = navigator.language || "en-US";
    instance.interimResults = true;
    instance.continuous = false;
    instance.maxAlternatives = 1;
    instance.onresult = (event) => {
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        if (result.isFinal) {
          finalText += result[0].transcript;
        } else {
          interim += result[0].transcript;
        }
      }
      options.onInterim((finalText + interim).trim());
    };
    instance.onerror = (event) => {
      errored = true;
      // Our own stop() can surface as "aborted" - not an error worth showing.
      if (event.error === "aborted" && stopRequested) return;
      options.onState("error", ERROR_MESSAGES[event.error] ?? `Speech recognition stopped (${event.error}).`, event.error);
    };
    instance.onend = () => {
      recognition = null;
      const text = finalText.trim();
      const stoppedByUs = stopRequested;
      stopRequested = false;
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
    } catch (error) {
      recognition = null;
      options.onState("error", error instanceof Error ? error.message : "Speech recognition couldn't start.");
    }
  };

  return {
    supported: true,
    toggle: () => (recognition ? stop() : start()),
    start,
    stop
  };
}
