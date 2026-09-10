export type SnapSettingsListener = (enabled: boolean) => void;

/**
 * Whether mouse manipulation snaps (see snapping.ts). A UI preference, not
 * part of the construction model: it's never saved and never undoable.
 * On by default.
 */
export class SnapSettings {
  private enabled = true;
  private readonly listeners = new Set<SnapSettingsListener>();

  isEnabled(): boolean {
    return this.enabled;
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
