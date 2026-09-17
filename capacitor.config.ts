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
 */
const config: CapacitorConfig = {
  appId: "com.eavara.iamarchitect",
  appName: "i am Architect",
  webDir: "dist",
  // Capacitor's default on Android - the app's own origin is
  // https://localhost, never a real localhost dev server. Kept explicit
  // here (rather than relying on Capacitor's default) so the backend's
  // required CORS allow-list entry is unambiguous - see DEPLOYMENT.md.
  server: {
    androidScheme: "https"
  }
};

export default config;
