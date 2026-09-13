/**
 * The EAVARA mark: the same pine glyph drawn inside the startup splash's
 * wordmark (index.html's `#eavara-pine` path - one grows in the E's
 * lower counter, another between the last A's legs) reused here as a
 * small, standalone logomark for the header - not a second, unrelated
 * symbol invented for this one spot. `fill="currentColor"` so it takes
 * whatever text color the badge around it already uses (see
 * topBar.ts/styles.css's `.app-header__brand-mark`), exactly like the
 * plain "iA" text it replaces.
 */
export function eavaraMarkSvg(): string {
  return `<svg viewBox="-9 -24 18 26" fill="currentColor" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="EAVARA"><path d="M0 -22L4 -15H2L6 -9H3L7 -3H1V0H-1V-3H-7L-3 -9H-6L-2 -15H-4Z"/></svg>`;
}
