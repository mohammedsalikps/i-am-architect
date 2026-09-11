/**
 * The Eavara startup screen - "EAVARA · THE SCHOOL OF ARCHITECTURE" -
 * shown while the i am Architect workspace starts.
 *
 * Its markup and styles live in index.html, so it is painted on the very
 * first frame: before any script runs, and before the workspace exists -
 * the workspace can never flash first. Its animation is pure CSS (the
 * production Content-Security-Policy allows no inline script). This module
 * only decides when it leaves:
 *
 * - once it has been up for SPLASH_HOLD_MS, counted from page load - so a
 *   slow script never adds waiting on top of the animation - and the
 *   workspace underneath has painted;
 * - at once, on any key, click or tap - nobody has to wait for it;
 * - with prefers-reduced-motion, index.html turns every animation off, and
 *   it leaves after a short static moment, without a fade.
 *
 * It imports nothing from the app and holds no state: if the markup is
 * missing, releaseSplash() does nothing; if the app fails before calling
 * it, a CSS failsafe in index.html hides the screen after 8 s.
 */

export const SPLASH_ID = "eavara-splash";
/** How long the animated screen stays - the animation finishes at about 1.7 s. */
export const SPLASH_HOLD_MS = 1800;
/** How long the static (reduced-motion) screen stays. */
export const SPLASH_REDUCED_HOLD_MS = 400;
/** The fade into the workspace (matches the transition in index.html). */
export const SPLASH_EXIT_MS = 450;
/** If no frame is drawn this soon after the hold (a hidden tab), leave anyway. */
const SPLASH_FRAME_FALLBACK_MS = 250;

const LEAVING_CLASS = "eavara-splash--leaving";

/** How much longer the screen should stay, given how long the page has been up (ms since navigation start). */
export function splashRemainingMs(elapsedMs: number, reducedMotion: boolean): number {
  const hold = reducedMotion ? SPLASH_REDUCED_HOLD_MS : SPLASH_HOLD_MS;
  return Math.max(0, hold - Math.max(0, elapsedMs));
}

/**
 * Hands the page over to the workspace: call once the workspace is
 * mounted and running (main.ts). Safe to call when there is no startup
 * screen, and safe to call more than once.
 */
export function releaseSplash(): void {
  const splash = document.getElementById(SPLASH_ID);
  if (!splash || splash.dataset.released === "true") {
    return;
  }
  splash.dataset.released = "true";

  const reducedMotion = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  let holdTimer = 0;
  let left = false;

  const remove = (): void => {
    splash.remove();
  };

  const leave = (): void => {
    if (left) {
      return;
    }
    left = true;
    window.clearTimeout(holdTimer);
    window.removeEventListener("keydown", leave, true);
    splash.removeEventListener("pointerdown", leave);
    if (reducedMotion) {
      remove();
      return;
    }
    splash.classList.add(LEAVING_CLASS);
    splash.addEventListener("transitionend", (event) => {
      if (event.target === splash) {
        remove();
      }
    });
    // In case transitionend never arrives (a hidden tab, say).
    window.setTimeout(remove, SPLASH_EXIT_MS + 150);
  };

  // Leave once the hold is over - two frames later, so the workspace
  // underneath has painted and the fade reveals it, not an empty page. A
  // page that isn't visible (a background tab) draws no frames at all, so a
  // timer leaves anyway: switching to that tab later shows the workspace,
  // never a stale startup screen.
  holdTimer = window.setTimeout(() => {
    window.requestAnimationFrame(() => window.requestAnimationFrame(leave));
    window.setTimeout(leave, SPLASH_FRAME_FALLBACK_MS);
  }, splashRemainingMs(performance.now(), reducedMotion));

  // Never make anyone wait: a key, click or tap skips straight to the workspace.
  window.addEventListener("keydown", leave, true);
  splash.addEventListener("pointerdown", leave);
}
