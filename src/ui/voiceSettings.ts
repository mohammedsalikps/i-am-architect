/**
 * The Architect's voice settings - what language it listens and speaks in,
 * which of the browser's voices reads replies, how long a pause ends your
 * turn, whether speaking over it interrupts, and how much of a reply it
 * reads aloud. Saved per browser (VOICE_SETTINGS_KEY); DOM-free, so the
 * choices are testable.
 *
 * Voices come from the browser's own speech engine (speechSynthesis), so
 * what's available differs by browser and OS. An English (India) voice is
 * preferred when one exists; when none does, the note says which voice is
 * used instead - it never claims an Indian voice the engine doesn't have.
 */

export type ReplyLength = "short" | "full";

export interface VoiceSettings {
  /** BCP 47 language for listening and speaking, e.g. "en-IN". */
  lang: string;
  /** A specific voice (SpeechSynthesisVoice.voiceURI), or null to pick the best one for `lang`. */
  voiceURI: string | null;
  /** Silence after speech that ends your turn, ms - short pauses mid-sentence don't. */
  pauseMs: number;
  /**
   * Speaking while a reply is read out interrupts it. Off by default: it
   * needs headphones - with speakers, the reply's own sound reaches the
   * microphone. 🎤 Speak and Stop always interrupt, either way.
   */
  bargeIn: boolean;
  /** Read the whole reply, or just its gist and the question. */
  replyLength: ReplyLength;
}

export const VOICE_SETTINGS_KEY = "iarchitect.voice";

export const LANGUAGE_CHOICES: readonly { code: string; label: string }[] = [
  { code: "en-IN", label: "English (India)" },
  { code: "en-GB", label: "English (UK)" },
  { code: "en-US", label: "English (US)" },
  { code: "en-AU", label: "English (Australia)" }
];

export const PAUSE_CHOICES: readonly { ms: number; label: string }[] = [
  { ms: 800, label: "0.8 s - quick" },
  { ms: 1200, label: "1.2 s" },
  { ms: 1600, label: "1.6 s - default" },
  { ms: 2500, label: "2.5 s - for long pauses" }
];

export const DEFAULT_VOICE_SETTINGS: VoiceSettings = { lang: "en-IN", voiceURI: null, pauseMs: 1600, bargeIn: false, replyLength: "short" };

export interface SettingsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Saved settings, each field checked - anything missing or odd is the default. */
export function readVoiceSettings(storage: SettingsStorage | null): VoiceSettings {
  let saved: Record<string, unknown> = {};
  try {
    const raw = storage?.getItem(VOICE_SETTINGS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) saved = parsed as Record<string, unknown>;
  } catch {
    saved = {};
  }
  const d = DEFAULT_VOICE_SETTINGS;
  return {
    lang: typeof saved.lang === "string" && /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(saved.lang) ? saved.lang : d.lang,
    voiceURI: typeof saved.voiceURI === "string" && saved.voiceURI.length > 0 ? saved.voiceURI : null,
    pauseMs: typeof saved.pauseMs === "number" && saved.pauseMs >= 400 && saved.pauseMs <= 5000 ? saved.pauseMs : d.pauseMs,
    bargeIn: typeof saved.bargeIn === "boolean" ? saved.bargeIn : d.bargeIn,
    replyLength: saved.replyLength === "full" || saved.replyLength === "short" ? saved.replyLength : d.replyLength
  };
}

export function saveVoiceSettings(storage: SettingsStorage | null, settings: VoiceSettings): void {
  try {
    storage?.setItem(VOICE_SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Not remembered - the settings still apply now.
  }
}

/** The fields of SpeechSynthesisVoice this file reads. */
export interface VoiceLike {
  name: string;
  lang: string;
  voiceURI: string;
  default?: boolean;
}

const normaliseLang = (lang: string): string => lang.replace(/_/g, "-").toLowerCase();

/**
 * The voice to read replies with, and a plain note saying what it is.
 * The chosen voice if it still exists; else one whose language is exactly
 * `lang`; else another voice of the same language family (with a note that
 * the exact one is missing); else the engine's default (null).
 */
export function chooseVoice<V extends VoiceLike>(voices: readonly V[], settings: Pick<VoiceSettings, "lang" | "voiceURI">): { voice: V | null; note: string } {
  const label = LANGUAGE_CHOICES.find((choice) => choice.code === settings.lang)?.label ?? settings.lang;
  if (settings.voiceURI) {
    const picked = voices.find((voice) => voice.voiceURI === settings.voiceURI);
    if (picked) return { voice: picked, note: `Voice: ${picked.name} (${picked.lang}).` };
  }
  const want = normaliseLang(settings.lang);
  const exact = voices.filter((voice) => normaliseLang(voice.lang) === want);
  if (exact.length > 0) {
    const voice = exact.find((candidate) => candidate.default) ?? exact[0];
    return { voice, note: `Voice: ${voice.name} (${voice.lang}).` };
  }
  const family = want.split("-")[0];
  const near = voices.filter((voice) => normaliseLang(voice.lang).split("-")[0] === family);
  if (near.length > 0) {
    const voice = near.find((candidate) => candidate.default) ?? near[0];
    return { voice, note: `This browser has no ${label} voice, so replies use ${voice.name} (${voice.lang}).` };
  }
  return { voice: null, note: voices.length === 0 ? "This browser offers no voices to choose from; replies use its default voice, if any." : `This browser has no ${label} voice; replies use its default voice.` };
}
