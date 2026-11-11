import { describe, expect, it } from "bun:test";
import { VECTOR_INDEX_API_VERSION, type VectorIndexPlugin } from "@mercury-fw/channel-types";
import { fakeVectorIndex } from "../memory/__fixtures__/fake-vector-index.ts";
import { loadVectorIndex } from "./vector-index-loader.ts";

function plugin(overrides: Partial<VectorIndexPlugin> = {}): VectorIndexPlugin {
  return { apiVersion: VECTOR_INDEX_API_VERSION, name: "fake", build: () => fakeVectorIndex(), ...overrides };
}

describe("loadVectorIndex", () => {
  it("is no index, and says nothing, when the config declares none", () => {
    const logs: string[] = [];
    expect(loadVectorIndex(undefined, { env: {}, log: (m) => logs.push(m) })).toBeUndefined();
    expect(logs).toEqual([]);
  });

  it("builds the declared index with the env and the logger", () => {
    const index = fakeVectorIndex();
    const seen: Array<{ env: unknown }> = [];
    const env = { QDRANT_URL: "http://q:6333" };
    const built = loadVectorIndex(plugin({ build: (ctx) => (seen.push({ env: ctx.env }), index) }), { env, log: () => {} });
    expect(built).toBe(index);
    expect(seen).toEqual([{ env }]);
  });

  it("leaves out an index written for another contract, saying why", () => {
    const logs: string[] = [];
    expect(loadVectorIndex(plugin({ apiVersion: 99 }), { env: {}, log: (m) => logs.push(m) })).toBeUndefined();
    expect(logs).toEqual([
      `vector index "fake" not activated: apiVersion 99 incompatible with this core (supports ${VECTOR_INDEX_API_VERSION}); memory and recall are off`,
    ]);
  });

  it("leaves out an index whose build throws, saying why, and the instance starts", () => {
    const logs: string[] = [];
    const failing = plugin({
      build: () => {
        throw new Error("bad URL");
      },
    });
    expect(loadVectorIndex(failing, { env: {}, log: (m) => logs.push(m) })).toBeUndefined();
    expect(logs).toEqual(['vector index "fake" failed to load: bad URL; memory and recall are off']);
  });
});
