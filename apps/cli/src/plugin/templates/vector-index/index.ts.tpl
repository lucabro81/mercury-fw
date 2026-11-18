/**
 * The __TITLE__ vector index: the spaces of points memory searches by
 * meaning. Written by `mfw plugin create` as a starting point: this one keeps
 * them in memory, so they're gone on a restart; a real index goes behind the
 * same methods, talking to its database. Every method may reject when the
 * database can't be reached: the core takes that as the index being away for
 * now.
 */
import type { VectorIndex, VectorIndexPlugin, VectorPoint, VectorSpaceSpec, VectorWhere } from "@mercury-fw/kit";

/** Whether `payload` holds every field `where` asks for. */
function matches(payload: Record<string, unknown>, where: VectorWhere | undefined): boolean {
  return Object.entries(where ?? {}).every(([key, value]) => payload[key] === value);
}

/** How close two vectors point: their cosine, 1 for the same direction. */
function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  a.forEach((x, i) => {
    dot += x * (b[i] ?? 0);
    normA += x * x;
    normB += (b[i] ?? 0) ** 2;
  });
  return normA === 0 || normB === 0 ? 0 : dot / Math.sqrt(normA * normB);
}

/** An index kept in memory. */
export function createIndex(): VectorIndex {
  const spaces = new Map<string, { spec: VectorSpaceSpec; points: Map<string, VectorPoint> }>();
  const space = (name: string) => {
    const found = spaces.get(name);
    if (found === undefined) throw new Error(`no space "${name}": ensure it first`);
    return found;
  };
  return {
    ensure: async (name, spec) => {
      if (!spaces.has(name)) spaces.set(name, { spec, points: new Map() });
    },
    upsert: async (name, points) => {
      const s = space(name);
      for (const point of points) {
        if (point.vector.length !== s.spec.dimensions) throw new Error(`"${name}" takes vectors of ${s.spec.dimensions}, not ${point.vector.length}`);
        s.points.set(point.id, point);
      }
    },
    query: async (name, q) =>
      [...space(name).points.values()]
        .filter((p) => matches(p.payload, q.where))
        .map((p) => ({ id: p.id, score: cosine(q.vector, p.vector), payload: p.payload }))
        .sort((a, b) => b.score - a.score)
        .slice(0, q.limit),
    scroll: async (name, q) => {
      const all = [...space(name).points.values()].filter((p) => matches(p.payload, q.where));
      if (q.orderBy) {
        const { key, direction } = q.orderBy;
        all.sort((a, b) => String(a.payload[key]).localeCompare(String(b.payload[key])) * (direction === "asc" ? 1 : -1));
      }
      // The cursor is where the next page starts.
      const start = q.cursor === undefined ? 0 : Number(q.cursor);
      const page = all.slice(start, start + q.limit);
      const next = start + q.limit < all.length ? String(start + q.limit) : undefined;
      return { points: page.map((p) => ({ id: p.id, payload: p.payload })), ...(next === undefined ? {} : { next }) };
    },
    setPayload: async (name, q) => {
      for (const point of space(name).points.values()) {
        if (matches(point.payload, q.where)) point.payload = { ...point.payload, ...q.payload };
      }
    },
    health: async () => ({ ok: true }),
  };
}

/** The index. Declare it as `vectorIndex`. */
export function __EXPORT__(): VectorIndexPlugin {
  return {
    // The contract this index is written for, as a literal: importing
    // VECTOR_INDEX_API_VERSION would report whichever contract is installed.
    apiVersion: __API_VERSION__,
    name: "__NAME__",
    // An index that can't work throws here: the core runs without one.
    build: () => createIndex(),
  };
}
