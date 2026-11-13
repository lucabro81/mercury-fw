/**
 * An in-memory `VectorIndex` for the plugin's tests: spaces of points, equality
 * filters, cosine nearness, ordering on a payload field and numeric cursors.
 * `calls` records what the core asked, `fail` makes every call reject (an
 * index that's away).
 */
import type { VectorIndex, VectorPoint, VectorSpaceSpec, VectorWhere } from "@mercury-fw/plugin-types";

export type FakeVectorIndex = VectorIndex & {
  spaces: Map<string, VectorPoint[]>;
  specs: Map<string, VectorSpaceSpec>;
  calls: Array<[string, string, unknown?]>;
  fail: Error | undefined;
  /** The payloads of `space`, in insertion order. */
  payloads: (space: string) => Array<Record<string, unknown>>;
};

function matches(point: VectorPoint, where: VectorWhere | undefined): boolean {
  return Object.entries(where ?? {}).every(([key, value]) => point.payload[key] === value);
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

/** A fresh fake index, its spaces holding `seed`'s points. */
export function fakeVectorIndex(seed: Record<string, VectorPoint[]> = {}): FakeVectorIndex {
  const spaces = new Map<string, VectorPoint[]>(Object.entries(seed).map(([s, p]) => [s, [...p]]));
  const specs = new Map<string, VectorSpaceSpec>();
  const calls: Array<[string, string, unknown?]> = [];
  const space = (name: string) => {
    if (!spaces.has(name)) spaces.set(name, []);
    return spaces.get(name)!;
  };
  const index: FakeVectorIndex = {
    spaces,
    specs,
    calls,
    fail: undefined,
    payloads: (name) => space(name).map((p) => p.payload),
    ensure: async (name, spec) => {
      calls.push(["ensure", name, spec]);
      if (index.fail) throw index.fail;
      specs.set(name, spec);
      space(name);
    },
    upsert: async (name, points) => {
      calls.push(["upsert", name, points]);
      if (index.fail) throw index.fail;
      const list = space(name);
      for (const point of points) {
        const at = list.findIndex((p) => p.id === point.id);
        if (at === -1) list.push(point);
        else list[at] = point;
      }
    },
    query: async (name, q) => {
      calls.push(["query", name, q]);
      if (index.fail) throw index.fail;
      return space(name)
        .filter((p) => matches(p, q.where))
        .map((p) => ({ id: p.id, score: cosine(p.vector, q.vector), payload: p.payload }))
        .sort((a, b) => b.score - a.score)
        .slice(0, q.limit);
    },
    scroll: async (name, q) => {
      calls.push(["scroll", name, q]);
      if (index.fail) throw index.fail;
      let list = space(name).filter((p) => matches(p, q.where));
      if (q.orderBy !== undefined) {
        const { key, direction } = q.orderBy;
        list = [...list].sort((a, b) => {
          const order = String(a.payload[key]).localeCompare(String(b.payload[key]));
          return direction === "asc" ? order : -order;
        });
      }
      const start = q.cursor === undefined ? 0 : Number(q.cursor);
      const page = list.slice(start, start + q.limit).map((p) => ({ id: p.id, payload: p.payload }));
      const next = start + q.limit < list.length ? String(start + q.limit) : undefined;
      return next === undefined ? { points: page } : { points: page, next };
    },
    setPayload: async (name, q) => {
      calls.push(["setPayload", name, q]);
      if (index.fail) throw index.fail;
      for (const point of space(name)) if (matches(point, q.where)) point.payload = { ...point.payload, ...q.payload };
    },
    health: async () => (index.fail ? { ok: false, detail: index.fail.message } : { ok: true }),
  };
  return index;
}
