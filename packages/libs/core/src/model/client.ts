/**
 * Constructs the Ollama provider Mercury uses for every LLM call (main
 * agent turns and the core's background work alike).
 *
 * Why it exists: the Ollama endpoint Mercury talks to varies by
 * deployment (a local GPU box in development, a different host in
 * production) and must always come from configuration, never be
 * hardcoded or silently defaulted to `localhost` — this is the single
 * place that reads that configuration, so the fail-fast behavior only
 * has to be correct once.
 *
 * Used by: `src/index.ts` (wiring), which passes the resulting
 * provider's model instance into `createSummarizer` (src/session/summarizer.ts)
 * and `runTurn` (src/session/agent-turn.ts).
 */
import { createOllama, type OllamaProvider } from "ai-sdk-ollama";

/**
 * Returns an Ollama provider bound to `OLLAMA_HOST`.
 *
 * Throws synchronously if `OLLAMA_HOST` is unset or empty — there is no
 * fallback to `localhost`, since which Ollama endpoint to use is a
 * deployment decision, not something Mercury's code should guess.
 */
export function getOllamaProvider(): OllamaProvider {
  const baseURL = process.env.OLLAMA_HOST;
  if (!baseURL) {
    throw new Error(
      "OLLAMA_HOST is not set — never default to localhost",
    );
  }
  return createOllama({ baseURL });
}
