/**
 * Light / dark theme for the whole workspace. The choice is one attribute,
 * `data-theme` on <html>, which every design token in styles.css follows;
 * the 3D viewport follows it too (scene/sceneTheme.ts, wired in main.ts).
 *
 * The choice is saved under THEME_STORAGE_KEY and applied before the first
 * paint by index.html's inline script (which must read the same key), so a
 * reload never flashes the other theme. Light is the default.
 *
 * Storage is injected: a browser that refuses localStorage (some privacy
 * modes) still switches themes - it just doesn't remember the choice.
 */

export type Theme = "light" | "dark";

/** Also read by index.html's inline script - keep the two in step. */
export const THEME_STORAGE_KEY = "iarchitect.theme";

export interface ThemeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface ThemeStore {
  get(): Theme;
  set(theme: Theme): void;
  toggle(): Theme;
  /** Called now with the current theme, then on every change; returns an unsubscribe. */
  subscribe(listener: (theme: Theme) => void): () => void;
}

export function isTheme(value: unknown): value is Theme {
  return value === "light" || value === "dark";
}

/** The saved theme, or light. */
export function readSavedTheme(storage: ThemeStorage | null): Theme {
  try {
    const saved = storage?.getItem(THEME_STORAGE_KEY) ?? null;
    return isTheme(saved) ? saved : "light";
  } catch {
    return "light";
  }
}

export function createThemeStore(options: { storage: ThemeStorage | null; root: { dataset: Record<string, string | undefined> } | null; initial?: Theme }): ThemeStore {
  const { storage, root } = options;
  const fromPage = root?.dataset.theme;
  let theme: Theme = options.initial ?? (isTheme(fromPage) ? fromPage : readSavedTheme(storage));
  const listeners = new Set<(theme: Theme) => void>();
  if (root) root.dataset.theme = theme;

  const set = (next: Theme): void => {
    if (!isTheme(next)) return;
    theme = next;
    if (root) root.dataset.theme = theme;
    try {
      storage?.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // Not remembered across reloads - the switch itself still works.
    }
    for (const listener of [...listeners]) listener(theme);
  };

  return {
    get: () => theme,
    set,
    toggle() {
      set(theme === "light" ? "dark" : "light");
      return theme;
    },
    subscribe(listener) {
      listeners.add(listener);
      listener(theme);
      return () => {
        listeners.delete(listener);
      };
    }
  };
}

/** The toggle's face for `theme`: what pressing it switches TO. */
export function themeToggleLabel(theme: Theme): { icon: string; text: string; title: string } {
  return theme === "light"
    ? { icon: "☾", text: "Dark", title: "Switch to the dark theme (saved for next time)" }
    : { icon: "☀", text: "Light", title: "Switch to the light theme (saved for next time)" };
}
