/**
 * Mercury's own health and its two real dependencies' reachability, for the
 * HTTP surface's `/health`: the process (uptime, memory), Qdrant and the
 * Ollama endpoint. No Docker socket access, so it's not `docker compose ps`.
 */
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
  qdrantReachable: boolean;
  ollamaReachable: boolean;
};

/** The process's uptime and memory, and whether Qdrant and the Ollama endpoint answer. */
export async function getSelfHealth(deps: {
  qdrant: { getCollections(): Promise<unknown> };
  ollamaHost: string;
  fetchFn?: typeof fetch;
}): Promise<SelfHealth> {
  const [qdrantReachable, availableModels] = await Promise.all([
    deps.qdrant
      .getCollections()
      .then(() => true)
      .catch(() => false),
    getAvailableModels(deps.ollamaHost, deps.fetchFn),
  ]);
  const memory = process.memoryUsage();
  return {
    uptimeSeconds: process.uptime(),
    memory: { rss: memory.rss, heapUsed: memory.heapUsed, heapTotal: memory.heapTotal },
    qdrantReachable,
    ollamaReachable: availableModels !== null,
  };
}
