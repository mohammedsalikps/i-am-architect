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
   * Synchronous by design for now - MockAIProvider needs nothing async.
   * A real network-backed provider would need this to become
   * `Promise<AIProviderResponse>`; that's a deliberate, out-of-scope
   * change for a future milestone (see ai/README.md "Limitations") -
   * introducing it now, before any real provider exists to justify it,
   * would just make AICommandPipeline and every test harder to read.
   */
  interpret(request: AIProviderRequest): AIProviderResponse;
}
