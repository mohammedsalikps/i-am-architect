import type { ArchitectChoice } from "../engine/architect/ArchitectSession";

/**
 * Hands-free voice for the EAVARA Architect: every reply is spoken - its
 * question and the choices on offer - and the microphone opens again as
 * soon as it has been said, so a whole build can be talked through
 * without touching the keyboard. Typing keeps working throughout.
 *
 * The browser pieces are injected (`SpeechOutput` for speechSynthesis,
 * `Listener` for voiceInput.ts), so this file stays DOM-free and testable.
 * Nothing is faked: a browser without speech recognition can't turn this
 * on; a blocked microphone turns it off and says so; silence pauses it
 * after two tries rather than listening forever.
 */

export interface SpeechOutput {
  speak(text: string, onDone: () => void): void;
  cancel(): void;
}

export interface Listener {
  readonly supported: boolean;
  start(): void;
  /** Stop listening; words already recognised are still sent. */
  stop(): void;
  /** Stop listening and drop whatever was heard. */
  cancel(): void;
}

export type HandsFreeStatus =
  | { kind: "off" }
  | { kind: "speaking" }
  | { kind: "listening" }
  /** Turned itself off - the message says why and what still works. */
  | { kind: "stopped"; message: string };

/** Errors after which listening again can't help: the microphone itself is unavailable. */
const FATAL = new Set(["not-allowed", "service-not-allowed", "audio-capture"]);
const SILENT_TURNS_BEFORE_PAUSE = 2;

const EMOJI = /[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu;

const UNITS: Readonly<Record<string, number>> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19
};
const TENS: Readonly<Record<string, number>> = { twenty: 20, thirty: 30, forty: 40, fifty: 50 };
const NUMBER_WORD = String.raw`(?:${[...Object.keys(TENS), ...Object.keys(UNITS)].join("|")})`;
/** "twenty five", "three", "fifty": one whole number said in words. */
const WHOLE = String.raw`(?:(?:${Object.keys(TENS).join("|")})(?:[\s-]+(?:${Object.keys(UNITS).filter((word) => UNITS[word] > 0 && UNITS[word] < 10).join("|")}))?|${NUMBER_WORD})`;

function wordsToNumber(words: string): number {
  const parts = words.toLowerCase().split(/[\s-]+/);
  return parts.reduce((total, part) => total + (TENS[part] ?? UNITS[part] ?? 0), 0);
}

/**
 * A recognised transcript with its numbers as digits, the way a typed
 * instruction would have them - "four by five metres" → "4 by 5 metres",
 * "three point five" → "3.5", "two comma zero" → "2, 0", "minus three" →
 * "-3". Only numbers said as words change; everything else stays as heard.
 * For speech only: typed text is never rewritten.
 */
export function spokenNumbers(transcript: string): string {
  const whole = new RegExp(String.raw`\b(${WHOLE})\b`, "gi");
  return transcript
    .replace(new RegExp(String.raw`\b(${WHOLE}|\d+)\s+point\s+((?:${NUMBER_WORD}|\d)(?:\s+(?:${NUMBER_WORD}|\d))*)\b`, "gi"), (_match, integer: string, decimals: string) => {
      const head = /^\d+$/.test(integer) ? integer : String(wordsToNumber(integer));
      const tail = decimals.split(/\s+/).map((digit) => (/^\d$/.test(digit) ? digit : String(UNITS[digit.toLowerCase()] ?? ""))).join("");
      return `${head}.${tail}`;
    })
    // A bare "one" stays a word ("the one on the left") unless it reads as a measure or coordinate.
    .replace(whole, (match: string, _word: string, offset: number, text: string) =>
      match.toLowerCase() === "one" &&
      !/^\s*(?:m\b|mm\b|cm\b|met|by\b|x\b|point\b|comma\b|,)/i.test(text.slice(offset + match.length)) &&
      !/(?:\bby|\bat|\bcomma|,)\s*$/i.test(text.slice(0, offset))
        ? match
        : String(wordsToNumber(match))
    )
    .replace(/\b(?:minus|negative)\s+(?=\d)/gi, "-")
    .replace(/(\d)\s+comma\s+(?=-?\d)/gi, "$1, ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** Text as a speech engine should read it: no emoji, units in words, "×" as "by". */
export function speakable(text: string): string {
  return text
    .replace(EMOJI, "")
    .replace(/m³/g, " cubic metres")
    .replace(/m²/g, " square metres")
    .replace(/(\d)\s*mm\b/g, "$1 millimetres")
    .replace(/(\d)\s*m\b/g, "$1 metres")
    .replace(/\s*×\s*/g, " by ")
    .replace(/[–—]/g, " ")
    .replace(/[“”"]/g, "")
    .replace(/\s*\n+\s*/g, ". ")
    .replace(/\(\s*([^)]*?)\s*\)/g, ", $1,")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/([,.])[,.]+/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** A reply as it is spoken: the text, then the choices ("You can say: brick, concrete block, or cancel."). */
export function spokenReply(reply: { text: string; choices: readonly ArchitectChoice[] }): string {
  const labels = reply.choices.map((choice) => speakable(choice.label).replace(/[,.]+$/, "")).filter((label) => label.length > 0);
  const options = labels.length === 0 ? "" : labels.length === 1 ? ` You can say: ${labels[0]}.` : ` You can say: ${labels.slice(0, -1).join(", ")}, or ${labels[labels.length - 1]}.`;
  return `${speakable(reply.text)}${options}`;
}

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(EMOJI, " ")
    .replace(/[^a-z0-9.\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The offered choice a spoken answer names - "concrete block", "build it",
 * "pick another spot" - or null when it names none (or more than one), in
 * which case the words are sent as said and the architect parses them.
 */
export function matchSpokenChoice(transcript: string, choices: readonly ArchitectChoice[]): ArchitectChoice | null {
  const said = normalize(transcript);
  if (said.length === 0) return null;
  const labelled = choices.map((choice) => ({ choice, label: normalize(choice.label) })).filter((entry) => entry.label.length > 0);
  const exact = labelled.filter((entry) => entry.label === said);
  if (exact.length === 1) return exact[0].choice;
  if (said.length < 3) return null;
  const partial = labelled.filter((entry) => entry.label.startsWith(`${said} `) || entry.label.startsWith(said) || said.includes(entry.label));
  return partial.length === 1 ? partial[0].choice : null;
}

export interface HandsFree {
  readonly enabled: boolean;
  /** Turns hands-free on or off; returns false when it can't be turned on (no speech recognition). */
  setEnabled(on: boolean): boolean;
  /** The architect replied: speak it, then listen for the answer. */
  replied(reply: { text: string; choices: readonly ArchitectChoice[] }): void;
  /** Turns on and reads out `current` (the question waiting for an answer). */
  enableWith(current: { text: string; choices: readonly ArchitectChoice[] } | null): boolean;
  /** A final transcript arrived. */
  heard(): void;
  /** Speech recognition failed with `code` (the Web Speech API's error name). */
  listenerError(code: string, message: string): void;
  /** Recognition ended - with or without a result. */
  listenerEnded(): void;
  /** True while a reply is being read out. */
  readonly speaking: boolean;
  /** The user pressed the microphone while the reply was being read: stop speaking at once and listen. */
  bargeIn(): void;
  /** The explicit Stop: silence speech and the microphone at once, and turn hands-free off. */
  interrupt(): void;
}

export function createHandsFree(options: { speech: SpeechOutput | null; listener: Listener; onStatus: (status: HandsFreeStatus) => void }): HandsFree {
  const { speech, listener, onStatus } = options;
  let enabled = false;
  let awaiting = false;
  let silentTurns = 0;
  /** Listen again once the current recognition session has ended (after a silent turn). */
  let pendingRestart = false;
  /** Bumped whenever speaking or listening is superseded, so a stale "speech finished" can't reopen the mic. */
  let turn = 0;
  let speaking = false;

  const stop = (message?: string): void => {
    enabled = false;
    awaiting = false;
    pendingRestart = false;
    speaking = false;
    turn += 1;
    speech?.cancel();
    // Turning hands-free off or pressing Stop must not send half-heard words.
    listener.cancel();
    onStatus(message ? { kind: "stopped", message } : { kind: "off" });
  };

  /** Nothing was heard: listen once more (when this session ends), or pause after two silent turns. */
  const silentTurn = (): void => {
    silentTurns += 1;
    if (silentTurns >= SILENT_TURNS_BEFORE_PAUSE) {
      stop("I didn't hear anything, so hands-free is paused. Press 🔊 to resume, or type.");
    } else {
      pendingRestart = true;
    }
  };

  const listen = (): void => {
    if (!enabled) return;
    awaiting = true;
    onStatus({ kind: "listening" });
    listener.start();
  };

  const say = (text: string): void => {
    const mine = (turn += 1);
    listener.stop();
    awaiting = false;
    pendingRestart = false;
    if (!speech) {
      listen();
      return;
    }
    speaking = true;
    onStatus({ kind: "speaking" });
    speech.speak(text, () => {
      if (turn !== mine) return;
      speaking = false;
      if (enabled) listen();
    });
  };

  return {
    get enabled() {
      return enabled;
    },
    get speaking() {
      return speaking;
    },
    bargeIn() {
      if (!enabled) return;
      turn += 1;
      speaking = false;
      speech?.cancel();
      silentTurns = 0;
      listen();
    },
    interrupt() {
      stop("Stopped. Press 🎤 to speak, 🔊 for hands-free, or type.");
    },
    setEnabled(on: boolean): boolean {
      if (!on) {
        stop();
        return true;
      }
      if (!listener.supported) {
        stop("Hands-free needs speech recognition, which this browser doesn't offer (use Chrome or Edge). Typing works everywhere.");
        return false;
      }
      return this.enableWith(null);
    },
    enableWith(current) {
      if (!listener.supported) {
        stop("Hands-free needs speech recognition, which this browser doesn't offer (use Chrome or Edge). Typing works everywhere.");
        return false;
      }
      enabled = true;
      silentTurns = 0;
      const intro = speech ? "Hands-free is on. I'll read out each question; answer out loud." : "";
      say(`${intro}${current ? ` ${spokenReply(current)}` : ""}`.trim());
      return true;
    },
    replied(reply) {
      if (enabled) say(spokenReply(reply));
    },
    heard() {
      awaiting = false;
      silentTurns = 0;
      pendingRestart = false;
    },
    listenerError(code, message) {
      if (!enabled || code === "aborted") return; // "aborted": our own stop()
      awaiting = false;
      if (FATAL.has(code)) {
        stop(`${message} Hands-free is off - type your answer instead.`);
        return;
      }
      if (code === "no-speech") {
        silentTurn();
        return;
      }
      stop(`${message} Hands-free is paused - press 🔊 to try again, or type.`);
    },
    listenerEnded() {
      if (!enabled) return;
      // Ended with neither a result nor an error: a silent turn too.
      if (awaiting) {
        awaiting = false;
        silentTurn();
      }
      if (pendingRestart) {
        pendingRestart = false;
        listen();
      }
    }
  };
}

/** The browser's own speech output, or null where there is none. Reads the window only when called. */
export function createSpeechOutput(): SpeechOutput | null {
  const synth = typeof window !== "undefined" && "speechSynthesis" in window ? window.speechSynthesis : null;
  if (!synth || typeof SpeechSynthesisUtterance === "undefined") return null;
  return {
    speak(text, onDone) {
      synth.cancel();
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        onDone();
      };
      if (text.trim().length === 0) {
        finish();
        return;
      }
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = navigator.language || "en-US";
      utterance.onend = finish;
      utterance.onerror = finish;
      synth.speak(utterance);
      // Some browsers drop the end event for long utterances - never leave the mic closed because of it.
      setTimeout(finish, 2000 + text.length * 90);
    },
    cancel() {
      synth.cancel();
    }
  };
}
