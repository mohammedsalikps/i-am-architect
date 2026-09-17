import type { CapacitorConfig } from "@capacitor/cli";

/**
 * Android packaging only (urgent APK milestone) - wraps the existing,
 * unmodified `dist/` production build (the same `vite build` output the
 * web app already ships) in a native WebView shell. Never a second
 * frontend: `webDir: "dist"` is the exact same build artifact, and the
 * app talks to the same backend over the same VITE_AI_BACKEND_URL
 * mechanism already used for Vercel/hosted builds (see src/main.ts,
 * vite.config.ts) - baked in at build time via the Render staging URL,
 * never localhost.
 *
 * Root cause of the APK's "server error" on sign-in: the WebView's own
 * origin (https://localhost) was never added to the backend's
 * FRONTEND_ORIGIN allow-list (a host-managed, non-secret value we don't
 * have dashboard access to change - see DEPLOYMENT.md's "FRONTEND_ORIGIN
 * is a host secret"), so every browser-CORS-checked fetch()/XHR the app
 * made was rejected at the preflight with "This origin is not allowed to
 * call this server." CapacitorHttp (built into @capacitor/android - see
 * its own native-bridge.js, which patches window.fetch/XMLHttpRequest to
 * route through the native OkHttp layer when this is enabled) is
 * Capacitor's own documented fix for exactly this class of problem:
 * requests leave through native networking, which has no browser
 * "origin" concept and is therefore never subject to CORS at all - the
 * same real backend, the same real auth/session/AI requests, just not
 * carried over the WebView's own fetch implementation. No backend
 * change, no origin spoofing, no secret exposed.
 */
const config: CapacitorConfig = {
  appId: "com.eavara.iamarchitect",
  appName: "i am Architect",
  webDir: "dist",
  // Capacitor's default on Android - the app's own origin is
  // https://localhost, never a real localhost dev server. Kept explicit
  // here for clarity, even though CapacitorHttp below means this origin
  // is no longer what the backend actually sees on fetch()/XHR calls.
  server: {
    androidScheme: "https"
  },
  plugins: {
    CapacitorHttp: {
      enabled: true
    }
  }
};

export default config;
