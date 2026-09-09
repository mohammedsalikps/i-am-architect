import type { AIProviderRequest, AIProviderResponse } from "./types";

/**
 * Provider-independent contract for turning one natural-language
 * instruction into structured construction commands. No implementation
 * of this interface talks to OpenAI, Gemini, Claude, or any other
 * network API yet - see ai/README.md. AICommandPipeline is the only
 * consumer of this interface; it never assumes anything about *how* a
 * provider produces commands, only that it eventually returns an
 * AIProviderResponse.
 *
 * A conforming implementation must not access Three.js scene objects
 * or any *Store directly - it only ever sees the read-only
 * AIProjectSnapshot handed to it via AIProviderRequest.projectContext,
 * and only ever communicates back structured, plain data. All resulting
 * mutations are applied later, by AICommandPipeline, exclusively
 * through CommandExecutor.
 */
export interface AIProvider {
  /**
   * May return synchronously (MockAIProvider does - it needs nothing
   * async) or return a Promise (a real network-backed provider, e.g.
   * providers/OpenAIProvider.ts, always does - an HTTP call cannot
   * resolve synchronously). AICommandPipeline.run() always `await`s
   * this, which works identically either way, so no implementation is
   * forced to introduce async machinery it doesn't need.
   */
  interpret(request: AIProviderRequest): AIProviderResponse | Promise<AIProviderResponse>;
}
