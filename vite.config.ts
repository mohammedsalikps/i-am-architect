import { defineConfig, loadEnv } from "vite";
import type { Plugin } from "vite";

/** Where the backend is when VITE_AI_BACKEND_URL isn't set - local development only (see src/main.ts). */
const DEFAULT_BACKEND_URL = "http://localhost:8787";

/**
 * Production builds get a Content-Security-Policy: scripts only from this
 * site, network requests only to this site and the backend. The browser
 * holds the signed-in user's session token, so limiting where code can come
 * from and where data can go is the main defence if markup is ever
 * injected. `style-src 'unsafe-inline'` is needed for index.html's inline
 * <style> and the UI's element styles. The dev server is left alone - Vite's
 * HMR needs inline scripts and a websocket.
 */
function contentSecurityPolicy(backendOrigin: string): Plugin {
  const policy = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src 'self' ${backendOrigin}`,
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'"
  ].join("; ");
  return {
    name: "iarchitect-content-security-policy",
    apply: "build",
    transformIndexHtml: () => [
      { tag: "meta", attrs: { "http-equiv": "Content-Security-Policy", content: policy }, injectTo: "head-prepend" }
    ]
  };
}

export default defineConfig(({ mode }) => {
  // Only VITE_-prefixed values are ever read here, and only they reach the
  // browser bundle. Secrets never have that prefix (see .env.example).
  const env = loadEnv(mode, process.cwd(), "VITE_");
  const backendUrl = env.VITE_AI_BACKEND_URL || DEFAULT_BACKEND_URL;
  let backendOrigin: string;
  try {
    backendOrigin = new URL(backendUrl).origin;
  } catch {
    throw new Error(`VITE_AI_BACKEND_URL is not a valid URL: "${backendUrl}".`);
  }

  // A hosted build (Vercel sets VERCEL=1) must name its backend, over HTTPS -
  // otherwise the deployed app would quietly try to reach localhost.
  if (process.env.VERCEL) {
    if (!env.VITE_AI_BACKEND_URL) {
      throw new Error("Set VITE_AI_BACKEND_URL (the deployed backend's https:// URL) in the hosting project's environment variables.");
    }
    if (!backendUrl.startsWith("https://")) {
      throw new Error("VITE_AI_BACKEND_URL must be an https:// URL for a hosted build.");
    }
  }

  return {
    server: {
      port: 5173
    },
    plugins: [contentSecurityPolicy(backendOrigin)]
  };
});
