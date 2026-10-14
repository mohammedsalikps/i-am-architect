import type { ArchitectChoice } from "../engine/architect/ArchitectSession";
import type { ReplyLength } from "./voiceSettings";

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
  /** Keep listening through silence (while a reply is read out and may be interrupted by speaking). */
  holdOpen?(on: boolean): void;
  /** What the open session has heard so far (empty when none is open). */
  pendingWords?(): string;
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
    // "(…). Next" became ", …,. Next": keep the full stop, so the sentence still ends there.
    .replace(/,\s*([.!?])/g, "$1")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/([,.])[,.]+/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** The longest a short spoken reply runs, in characters - about ten seconds of speech. */
const SHORT_REPLY_CHARS = 220;

/**
 * The gist of a reply for reading aloud: its first sentence and, when it
 * asks something, the question - not every detail on screen (the full
 * text stays in the conversation). Long, it's cut at a word.
 */
export function shortSpoken(text: string): string {
  const sentences = text.split(/(?<=[.!?])\s+/).map((sentence) => sentence.trim()).filter((sentence) => sentence.length > 0);
  if (sentences.length === 0) return "";
  const question = [...sentences].reverse().find((sentence) => sentence.endsWith("?"));
  const parts = question && question !== sentences[0] ? [sentences[0], question] : [sentences[0]];
  const joined = parts.join(" ");
  if (joined.length <= SHORT_REPLY_CHARS) return joined;
  const cut = joined.slice(0, SHORT_REPLY_CHARS);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), 1)).replace(/[,;:]$/, "")}.`;
}

/** A reply as it is spoken: the text (or its gist), then the choices ("You can say: brick, concrete block, or cancel."). */
export function spokenReply(reply: { text: string; choices: readonly ArchitectChoice[] }, length: ReplyLength = "full"): string {
  const all = reply.choices.map((choice) => speakable(choice.label).replace(/[,.]+$/, "")).filter((label) => label.length > 0);
  const labels = length === "short" ? all.slice(0, 3) : all;
  const options = labels.length === 0 ? "" : labels.length === 1 ? ` You can say: ${labels[0]}.` : ` You can say: ${labels.slice(0, -1).join(", ")}, or ${labels[labels.length - 1]}.`;
  // Shortened from the text as written (its sentences intact), then made speakable.
  return `${speakable(length === "short" ? shortSpoken(reply.text) : reply.text)}${options}`;
}

/**
 * Whether words the microphone picked up while a reply was being read are
 * just that reply coming back through the speakers: they all appear, in
 * order, in what was said - or nearly every word does. The user's own
 * words ("make it 4.5 metres wide") aren't.
 */
const SPELLINGS: readonly [RegExp, string][] = [
  [/\b(centi|milli)?meters?\b/g, "$1metres"],
  [/\bcenter(ed|s)?\b/g, "centre$1"],
  [/\bcenterlines?\b/g, "centrelines"],
  [/\bcolor(ed|s)?\b/g, "colour$1"]
];

/**
 * Words as compared for echoes, the same however the recogniser writes them:
 * no punctuation (a full stop only inside a number, "4.5"), numbers as
 * digits ("four" = "4"), UK spellings ("meters" = "metres").
 */
function echoWords(text: string): string {
  let words = normalize(spokenNumbers(text)).replace(/\.(?!\d)/g, " ");
  for (const [pattern, replacement] of SPELLINGS) words = words.replace(pattern, replacement);
  return words.replace(/\s+/g, " ").trim();
}

/**
 * The user's words without a lead-in that just continues the reply's echo -
 * the words the reply was saying next, after the echo already heard
 * (`prefix`), which the recogniser delivered with the user's first words.
 * Two or more in order; one shared word may well be the user's.
 */
export function stripContinuation(user: string, spoken: string, prefix: string): string {
  const reply = echoWords(spoken).split(" ").filter((word) => word.length > 0);
  const heard = echoWords(prefix).split(" ").filter((word) => word.length > 0);
  let from = 0;
  if (heard.length > 0) {
    const tail = heard.slice(-3);
    const at = reply.findIndex((_, index) => tail.every((word, offset) => reply[index + offset] === word));
    if (at < 0) return user.trim();
    from = at + tail.length;
  }
  const tokens = user.trim().split(/\s+/).filter((word) => word.length > 0);
  let same = 0;
  while (same < tokens.length && from + same < reply.length && echoWords(tokens[same]) === reply[from + same]) same += 1;
  return (same >= 2 ? tokens.slice(same) : tokens).join(" ");
}

export function isEchoOf(heard: string, spoken: string): boolean {
  const words = echoWords(heard).split(" ").filter((word) => word.length > 0);
  if (words.length === 0) return true;
  const said = ` ${echoWords(spoken)} `;
  if (said.includes(` ${words.join(" ")} `)) return true;
  const saidWords = new Set(said.trim().split(" "));
  return words.filter((word) => saidWords.has(word)).length / words.length >= 0.8;
}

/**
 * The words of `text` after `prefix` - what was said after the moment the
 * transcript was last all echo. Finalised words don't change, so the
 * prefix's words normally lead `text` exactly; where the recogniser revised
 * a few of them, the same number of words is dropped.
 */
export function wordsAfter(text: string, prefix: string): string {
  const said = text.trim().split(/\s+/).filter((word) => word.length > 0);
  const before = echoWords(prefix).split(" ").filter((word) => word.length > 0);
  if (before.length === 0) return text.trim();
  let same = 0;
  while (same < before.length && same < said.length && echoWords(said[same]) === before[same]) same += 1;
  const matching = said.slice(0, before.length).filter((word, index) => echoWords(word) === before[index]).length;
  const drop = same === before.length || matching / before.length >= 0.6 ? before.length : same;
  return said.slice(drop).join(" ");
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
  /**
   * Words heard while a reply is being read (voice barge-in on): when they
   * are the user's own - two words or more, not the reply echoing back -
   * the speech stops at once and this turn is the user's. Returns whether
   * it interrupted.
   */
  heardWhileSpeaking(text: string): boolean;
  /** A final transcript: what to send - null when it was only the reply echoing back (dropped). */
  acceptFinal(text: string): string | null;
  /** A live transcript as the user should see it: without the echo heard before they interrupted. */
  userWords(text: string): string;
  /** A recognition session has just opened - one opened while nothing is being read has no echo in it. */
  sessionStarted(): void;
  /** The explicit Stop: silence speech and the microphone at once, and turn hands-free off. */
  interrupt(): void;
}

export function createHandsFree(options: {
  speech: SpeechOutput | null;
  listener: Listener;
  onStatus: (status: HandsFreeStatus) => void;
  /** Listen while speaking, so the user can interrupt by talking (off: only the mic button or Stop interrupts). */
  bargeIn?: () => boolean;
  /** How much of each reply is read aloud. */
  replyLength?: () => ReplyLength;
}): HandsFree {
  const { speech, listener, onStatus } = options;
  const bargeInOn = (): boolean => options.bargeIn?.() ?? false;
  const length = (): ReplyLength => options.replyLength?.() ?? "full";
  let enabled = false;
  let awaiting = false;
  let silentTurns = 0;
  /** Listen again once the current recognition session has ended (after a silent turn). */
  let pendingRestart = false;
  /** Bumped whenever speaking or listening is superseded, so a stale "speech finished" can't reopen the mic. */
  let turn = 0;
  let speaking = false;
  /** What was last read aloud - what an echo is checked against. */
  let lastSpoken = "";
  /**
   * This recognition session was opened while a reply was read (voice
   * barge-in), so its transcript may start with that reply's echo. Lasts
   * for the one session: an uninterrupted reply's session is discarded when
   * the reply ends, and an interrupted one is consumed by its final.
   */
  let overlapped = false;
  /** The session's transcript up to the last point it was all echo. */
  let echoSoFar = "";
  /** Set by an interruption: exactly the echo heard before the user's words - removed from what is sent. */
  let echoPrefix: string | null = null;

  const forgetEcho = (): void => {
    overlapped = false;
    echoSoFar = "";
    echoPrefix = null;
  };

  const stop = (message?: string): void => {
    enabled = false;
    awaiting = false;
    pendingRestart = false;
    speaking = false;
    turn += 1;
    forgetEcho();
    speech?.cancel();
    listener.holdOpen?.(false);
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

  /** The reply has been read and not interrupted: the session that heard it holds only its echo - drop it, and listen afresh for the answer. */
  const listenAfresh = (): void => {
    forgetEcho();
    listener.holdOpen?.(false);
    listener.cancel();
    listen();
  };

  const say = (text: string): void => {
    // The user is in the middle of saying something (a correction while the last turn was thinking): don't talk over them - the reply is on screen.
    // (While a reply is still read with the mic held open, what it has heard is that reply's echo, not the user: the new reply replaces it.)
    if (enabled && !speaking && (listener.pendingWords?.() ?? "").trim().length > 0) return;
    const mine = (turn += 1);
    awaiting = false;
    pendingRestart = false;
    lastSpoken = text;
    if (!speech) {
      forgetEcho();
      listener.stop();
      listen();
      return;
    }
    // Voice barge-in: the microphone stays open (held through silence) while this is read, so talking over it interrupts.
    const hold = enabled && bargeInOn() && listener.supported;
    const replacing = speaking && overlapped;
    forgetEcho();
    overlapped = hold;
    speaking = true;
    if (hold) {
      // A fresh session for this reply: an earlier reply's echo (still arriving) is never judged against this one.
      if (replacing) listener.cancel();
      listener.holdOpen?.(true);
      listener.start();
    } else {
      listener.stop();
    }
    onStatus({ kind: "speaking" });
    speech.speak(text, () => {
      if (turn !== mine) return;
      speaking = false;
      if (!enabled) return;
      if (overlapped) listenAfresh();
      else listen();
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
      // The mic was held open while the reply was read: drop that session (its echo, and the echo still arriving from
      // before the press) and listen afresh - only what is said after the press is the user's.
      const fresh = overlapped && speaking;
      turn += 1;
      speaking = false;
      speech?.cancel();
      listener.holdOpen?.(false);
      if (fresh) {
        forgetEcho();
        listener.cancel();
      }
      silentTurns = 0;
      listen();
    },
    heardWhileSpeaking(text) {
      if (!enabled || !speaking || !overlapped) return false;
      // Judged on the words since the transcript was last all echo - not the whole session, which fills with echo.
      const fresh = wordsAfter(text, echoSoFar);
      const words = echoWords(fresh).split(" ").filter((word) => word.length > 0);
      if (words.length === 0) return false;
      if (isEchoOf(fresh, lastSpoken)) {
        echoSoFar = text;
        return false;
      }
      // Two words or more that the reply never says: the user is talking. (One misheard echo word isn't enough.)
      const replyWords = new Set(echoWords(lastSpoken).split(" "));
      if (words.filter((word) => !replyWords.has(word)).length < 2) return false;
      echoPrefix = echoSoFar;
      turn += 1;
      speaking = false;
      speech?.cancel();
      listener.holdOpen?.(false);
      silentTurns = 0;
      awaiting = true;
      onStatus({ kind: "listening" });
      return true;
    },
    acceptFinal(text) {
      if (!overlapped) return text;
      // The session ended while the reply was still read, never interrupted: it heard only the reply.
      if (speaking) return null;
      const prefix = echoPrefix;
      forgetEcho(); // the session is over: its echo can't touch the next one
      if (prefix === null) return text;
      const user = stripContinuation(wordsAfter(text, prefix), lastSpoken, prefix).trim();
      return user.length > 0 ? user : null;
    },
    userWords(text) {
      return overlapped && echoPrefix !== null ? stripContinuation(wordsAfter(text, echoPrefix), lastSpoken, echoPrefix).trim() : text;
    },
    sessionStarted() {
      // A session opened while nothing is being read has no echo in it.
      if (!speaking) forgetEcho();
      else echoSoFar = "";
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
      say(`${intro}${current ? ` ${spokenReply(current, length())}` : ""}`.trim());
      return true;
    },
    replied(reply) {
      if (enabled) say(spokenReply(reply, length()));
    },
    heard() {
      awaiting = false;
      silentTurns = 0;
      pendingRestart = false;
    },
    listenerError(code, message) {
      if (!enabled || code === "aborted") return; // "aborted": our own stop()
      // The browser's own no-speech timeout while the mic is only held open during a reply: not the user's silence - the session is reopened when it ends.
      if (code === "no-speech" && speaking && overlapped) return;
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
      // The browser ended the session while a reply is still being read with the mic open: keep listening for an interruption.
      if (speaking && overlapped) {
        echoSoFar = "";
        listener.start();
        return;
      }
      // Ended with neither a result nor an error: a silent turn too.
      if (awaiting) {
        awaiting = false;
        silentTurn();
      }
      if (pendingRestart) {
        pendingRestart = false;
        forgetEcho();
        listen();
      }
    }
  };
}

/** The browser's own speech output, or null where there is none. Reads the window only when called. `voice` picks the voice and language for each reply (voiceSettings.ts). */
export function createSpeechOutput(voice?: () => { voice: SpeechSynthesisVoice | null; lang: string }): SpeechOutput | null {
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
      const chosen = voice?.();
      if (chosen?.voice) utterance.voice = chosen.voice;
      utterance.lang = chosen?.voice?.lang ?? chosen?.lang ?? (navigator.language || "en-US");
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
