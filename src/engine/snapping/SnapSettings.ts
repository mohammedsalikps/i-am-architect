export type SnapSettingsListener = (enabled: boolean) => void;

/**
 * Whether mouse manipulation snaps (see snapping.ts). A UI preference, not
 * part of the construction model: it's never saved and never undoable.
 * On by default.
 */
export class SnapSettings {
  private enabled = true;
  /** The increment moves snap to, metres (workspace settings; 0.1 m by default). */
  private step = 0.1;
  private readonly listeners = new Set<SnapSettingsListener>();

  isEnabled(): boolean {
    return this.enabled;
  }

  getStep(): number {
    return this.step;
  }

  /** Listeners are told (with the current on/off) so a readout can show the new step. */
  setStep(step: number): void {
    if (!(step > 0) || step === this.step) {
      return;
    }
    this.step = step;
    for (const listener of this.listeners) {
      listener(this.enabled);
    }
  }

  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) {
      return;
    }
    this.enabled = enabled;
    for (const listener of this.listeners) {
      listener(enabled);
    }
  }

  toggle(): void {
    this.setEnabled(!this.enabled);
  }

  /** Returns an unsubscribe function. Calls the listener once immediately. */
  subscribe(listener: SnapSettingsListener): () => void {
    this.listeners.add(listener);
    listener(this.enabled);
    return () => this.listeners.delete(listener);
  }
}
