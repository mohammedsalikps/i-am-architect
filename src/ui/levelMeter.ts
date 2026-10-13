/**
 * A real microphone level for the copilot's waveform while it listens:
 * the Web Audio API's analyser on the same microphone speech recognition
 * uses. Where that isn't available (no getUserMedia, permission refused,
 * no AudioContext) it reports `null` and the panel shows no waveform at
 * all - never an animation pretending to be a signal.
 */

/** RMS of a block of samples (-1..1), scaled so ordinary speech reads around 0.3-0.8; clamped to 0..1. */
export function rmsLevel(samples: ArrayLike<number>): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) sum += samples[i] * samples[i];
  return Math.min(1, Math.sqrt(sum / samples.length) * 4);
}

export interface LevelMeter {
  start(): void;
  stop(): void;
}

export function createLevelMeter(onLevel: (level: number | null) => void): LevelMeter {
  let stream: MediaStream | null = null;
  let context: AudioContext | null = null;
  let frame = 0;
  let generation = 0;

  const stop = (): void => {
    generation += 1;
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    stream?.getTracks().forEach((track) => track.stop());
    stream = null;
    void context?.close().catch(() => undefined);
    context = null;
    onLevel(null);
  };

  const start = (): void => {
    stop();
    const mine = generation;
    const Context = typeof window !== "undefined" ? window.AudioContext : undefined;
    if (!navigator.mediaDevices?.getUserMedia || !Context) {
      onLevel(null);
      return;
    }
    navigator.mediaDevices
      .getUserMedia({ audio: true })
      .then((media) => {
        if (mine !== generation) {
          media.getTracks().forEach((track) => track.stop());
          return;
        }
        stream = media;
        context = new Context();
        const analyser = context.createAnalyser();
        analyser.fftSize = 512;
        context.createMediaStreamSource(media).connect(analyser);
        const samples = new Float32Array(analyser.fftSize);
        const tick = (): void => {
          if (mine !== generation) return;
          analyser.getFloatTimeDomainData(samples);
          onLevel(rmsLevel(samples));
          frame = requestAnimationFrame(tick);
        };
        tick();
      })
      .catch(() => {
        if (mine === generation) onLevel(null);
      });
  };

  return { start, stop };
}
