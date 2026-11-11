/**
 * Builds the vector index an app declares as `vectorIndex` in
 * `mercury.config.ts` — the index's sibling of `../traces/trace-loader.ts`.
 * It knows no index: Qdrant or anything else lives in its own package.
 *
 * Fail-soft: an index written for another contract, or a `build()` that
 * throws, leaves the instance without an index, logged, and the instance
 * starts anyway. Without an index the episodic memory, the semantic facts,
 * the procedural corrections and `recall_verbatim` are off.
 */
import { VECTOR_INDEX_API_VERSION, type VectorIndex, type VectorIndexPlugin } from "@mercury-fw/channel-types";

/** The index `plugin` builds, or `undefined` when there's none or it can't be used (see the module comment). */
export function loadVectorIndex(
  plugin: VectorIndexPlugin | undefined,
  ctx: { env: Record<string, string | undefined>; log: (msg: string) => void },
): VectorIndex | undefined {
  if (plugin === undefined) return undefined;
  if (plugin.apiVersion !== VECTOR_INDEX_API_VERSION) {
    ctx.log(
      `vector index "${plugin.name}" not activated: apiVersion ${plugin.apiVersion} ` +
        `incompatible with this core (supports ${VECTOR_INDEX_API_VERSION}); memory and recall are off`,
    );
    return undefined;
  }
  try {
    return plugin.build({ env: ctx.env, log: ctx.log });
  } catch (err) {
    ctx.log(`vector index "${plugin.name}" failed to load: ${err instanceof Error ? err.message : String(err)}; memory and recall are off`);
    return undefined;
  }
}
