/**
 * Claude's provider settings as plain data, with NO import of the Anthropic
 * SDK - so backend/src/config.ts can validate ANTHROPIC_MODEL and
 * ANTHROPIC_EFFORT, and server.ts can describe the provider, without
 * loading the SDK. Only AnthropicProvider.ts imports the SDK, and the
 * backend loads that file only when AI_PROVIDER=anthropic: a Gemini or
 * OpenAI deployment never needs the package installed.
 */

/**
 * Claude Sonnet 5.5 - a current model (Anthropic's models overview: "the
 * best combination of speed and intelligence", rated Fast, $2 / $10 per
 * million input / output tokens - half Claude Opus 5.5's price). Each AI
 * request must finish inside the browser's 30 s, so speed matters more here
 * than Opus's extra depth. Override with ANTHROPIC_MODEL, e.g.
 * "claude-opus-5-5".
 */
export const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-5-5";

export type AnthropicEffort = "low" | "medium" | "high" | "xhigh" | "max";
export const ANTHROPIC_EFFORTS: readonly AnthropicEffort[] = ["low", "medium", "high", "xhigh", "max"];

/**
 * Set explicitly: Sonnet 5.5's API default is "high", and Anthropic's effort
 * guide suggests "medium" or "low" for latency-sensitive work and "medium"
 * for well-specified tool use. Override with ANTHROPIC_EFFORT - "low"
 * answers faster.
 */
export const DEFAULT_ANTHROPIC_EFFORT: AnthropicEffort = "medium";
