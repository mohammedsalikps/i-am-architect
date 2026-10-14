/**
 * The workspace chrome's own icons - the panel rails, the top bar's
 * undo/redo/save, the assistant button, menus and panel toggles. Same
 * conventions as constructionIcons.ts and assetIcons.ts: plain line art,
 * `fill="none"`, `stroke="currentColor"` so a button recolors them with
 * CSS. Drawn on a 24x24 grid at 1.75 stroke for the 16-20px sizes the
 * chrome uses. Every button that shows one also carries a visible label
 * or an aria-label and tooltip - an icon never explains itself alone.
 */

const svg = (body: string): string =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">${body}</svg>`;

export const SHELL_ICONS = {
  /** The project tree: a parent and two indented children. */
  tree: svg(`<rect x="3" y="3.5" width="7" height="5" rx="1"/><rect x="11" y="10" width="10" height="4.5" rx="1"/><rect x="11" y="16.5" width="10" height="4.5" rx="1"/><path d="M6.5 8.5v10h4.5M6.5 12.25h4.5"/>`),
  /** Assemblies: stacked layers. */
  layers: svg(`<path d="M12 3 3 7.5l9 4.5 9-4.5L12 3Z"/><path d="m3 12 9 4.5 9-4.5"/><path d="m3 16.5 9 4.5 9-4.5"/>`),
  /** Assets: an armchair. */
  chair: svg(`<path d="M6 11V7a3 3 0 0 1 3-3h6a3 3 0 0 1 3 3v4"/><path d="M4 11a2 2 0 0 1 2 2v2h12v-2a2 2 0 1 1 2 2v3H4v-3a2 2 0 0 1 0-4Z"/><path d="M6 18v2M18 18v2"/>`),
  /** The inspector: property sliders. */
  sliders: svg(`<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>`),
  /** Materials: a swatch fan. */
  swatch: svg(`<rect x="3" y="4" width="7" height="16" rx="1.5"/><path d="m10 8 4.5-3.2a1.5 1.5 0 0 1 2.1.4l3.2 4.6a1.5 1.5 0 0 1-.4 2.1L10 18"/><circle cx="6.5" cy="16" r="1"/>`),
  /** Undo / redo: a curved arrow back, and forward. */
  undo: svg(`<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>`),
  redo: svg(`<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>`),
  /** Save: a floppy disk. */
  save: svg(`<path d="M5 3h11l3 3v13a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z"/><path d="M7 3v5h8V3M7 21v-7h10v7"/>`),
  /** The AI assistant: a four-point spark. */
  spark: svg(`<path d="M12 3c.6 4.2 2.8 6.4 7 7-4.2.6-6.4 2.8-7 7-.6-4.2-2.8-6.4-7-7 4.2-.6 6.4-2.8 7-7Z"/><path d="M19 15.5c.25 1.6 1 2.3 2.5 2.5-1.5.25-2.25 1-2.5 2.5-.25-1.5-1-2.25-2.5-2.5 1.5-.2 2.25-.9 2.5-2.5Z"/>`),
  /** Close. */
  close: svg(`<path d="M6 6l12 12M18 6 6 18"/>`),
  /** Chevrons: collapse / expand a panel. */
  chevronLeft: svg(`<path d="m14.5 6-6 6 6 6"/>`),
  chevronRight: svg(`<path d="m9.5 6 6 6-6 6"/>`),
  chevronUp: svg(`<path d="m6 14.5 6-6 6 6"/>`),
  chevronDown: svg(`<path d="m6 9.5 6 6 6-6"/>`),
  /** A signed-out person. */
  person: svg(`<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>`),
  /** Search. */
  search: svg(`<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.4-4.4"/>`),
  /** The bottom dock: a window with its lower band filled. */
  dock: svg(`<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 14h18"/>`)
} as const;

export type ShellIcon = keyof typeof SHELL_ICONS;
