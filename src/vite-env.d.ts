/// <reference types="vite/client" />

/**
 * Custom Vite client-side env vars for this app. Vite only ever inlines
 * `VITE_`-prefixed variables into the browser bundle (everything else
 * stays server/build-time only) - see .env.example and
 * src/engine/ai/README.md "Security boundary" for why that boundary
 * matters here specifically (it's what keeps OPENAI_API_KEY out of this
 * list, permanently).
 */
interface ImportMetaEnv {
  /**
   * Base URL of the AI proxy backend (see backend/README.md), e.g.
   * "http://localhost:8787". A URL, not a credential - safe to expose
   * client-side. Read exactly once, in src/main.ts - see that file and
   * src/engine/ai/providers/BackendAIProvider.ts, which never reads
   * this (or any) environment variable itself.
   */
  readonly VITE_AI_BACKEND_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
