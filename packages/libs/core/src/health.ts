/**
 * Mercury's own health and its dependencies' reachability, for the HTTP
 * surface's `/health`: the process (uptime, memory), the declared
 * conversation store and vector index, and the Ollama endpoint. No Docker
 * socket access, so it's not `docker compose ps`.
 */
import type { ConversationStore, VectorIndex } from "@mercury-fw/channel-types";

type OllamaTagsResponse = { models?: Array<{ name: string }> };

/** Live model names Ollama actually has pulled, or `null` if the host isn't reachable. */
export async function getAvailableModels(host: string, fetchFn: typeof fetch = fetch): Promise<string[] | null> {
  try {
    const response = await fetchFn(`${host}/api/tags`);
    if (!response.ok) return null;
    const data = (await response.json()) as OllamaTagsResponse;
    return data.models?.map((m) => m.name) ?? [];
  } catch {
    return null;
  }
}

export type SelfHealth = {
  uptimeSeconds: number;
  memory: { rss: number; heapUsed: number; heapTotal: number };
  /** Whether the declared conversation store answers; `null` without one. */
  conversationStoreReachable: boolean | null;
  /** Whether the declared vector index answers; `null` without one. */
  vectorIndexReachable: boolean | null;
  ollamaReachable: boolean;
};

/** Whether `primitive` answers its health check: `null` when there's none, `false` when the check throws. */
async function reachable(primitive: { health: () => Promise<{ ok: boolean }> } | undefined): Promise<boolean | null> {
  if (primitive === undefined) return null;
  try {
    return (await primitive.health()).ok;
  } catch {
    return false;
  }
}

/** The process's uptime and memory, and whether the conversation store, the vector index and the Ollama endpoint answer. */
export async function getSelfHealth(deps: {
  store?: ConversationStore;
  index?: VectorIndex;
  ollamaHost: string;
  fetchFn?: typeof fetch;
}): Promise<SelfHealth> {
  const [conversationStoreReachable, vectorIndexReachable, availableModels] = await Promise.all([
    reachable(deps.store),
    reachable(deps.index),
    getAvailableModels(deps.ollamaHost, deps.fetchFn),
  ]);
  const memory = process.memoryUsage();
  return {
    uptimeSeconds: process.uptime(),
    memory: { rss: memory.rss, heapUsed: memory.heapUsed, heapTotal: memory.heapTotal },
    conversationStoreReachable,
    vectorIndexReachable,
    ollamaReachable: availableModels !== null,
  };
}
