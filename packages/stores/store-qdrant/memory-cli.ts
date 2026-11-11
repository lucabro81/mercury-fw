#!/usr/bin/env bun
/**
 * Read-only CLI for Layer-3 memory on Qdrant — runs INSIDE the Mercury
 * container (where `QDRANT_URL` reaches Qdrant): `mfw memory` runs it in a
 * one-off container, by this path.
 * `list` shows the collections and their sizes, `read` a collection's points:
 * newest first where the collection has a `timestamp` payload index (episodic
 * memory, the verbatim archive), in Qdrant's own order otherwise, and it says
 * which. Nothing here writes.
 */
import { parseArgs } from "node:util";
import { QdrantClient } from "@qdrant/js-client-rest";
import { scrollCollection } from "./qdrant-scroll.ts";

type ScrollOffset = string | number | Record<string, unknown> | null;

/** The slice of the Qdrant client this CLI uses. */
export type MemoryCliClient = {
  getCollections(): Promise<{ collections: Array<{ name: string }> }>;
  count(collection: string, params: { exact: boolean }): Promise<{ count: number }>;
  scroll(
    collection: string,
    params: {
      limit: number;
      offset?: ScrollOffset;
      with_payload: boolean;
      order_by?: { key: string; direction: "asc" | "desc" };
    },
  ): Promise<{
    points: Array<{ id: string | number; payload?: Record<string, unknown> | null }>;
    next_page_offset?: ScrollOffset;
  }>;
};

type Io = { client: MemoryCliClient; out: (line: string) => void; err: (line: string) => void };

const USAGE = [
  "Usage: mfw memory <command> [args]",
  "",
  "Commands:",
  "  list                              the collections and their points",
  "  read <collection> [--limit N]     a collection's points, newest first where it can (default 20)",
];

/** A point as the lines `read` prints: its id, then one indented line per payload field. */
function pointLines(point: { id: string | number; payload?: Record<string, unknown> | null }): string[] {
  const fields = Object.entries(point.payload ?? {}).map(
    ([key, value]) => `  ${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`,
  );
  return [String(point.id), ...fields, ""];
}

/** Whether `err` is Qdrant refusing to order by a field it has no index on
 * (HTTP 400, "No range index for `order_by` key"). */
function isMissingOrderIndex(err: unknown): boolean {
  const e = err as { status?: number; message?: string; data?: unknown };
  const text = `${e?.message ?? ""} ${JSON.stringify(e?.data ?? "")}`;
  return (e?.status === 400 || /\b400\b/.test(text)) && /index/i.test(text);
}

/** Runs the CLI on `argv` against `io.client`; returns the exit code. */
export async function runMemoryCli(argv: string[], { client, out, err }: Io): Promise<number> {
  const usage = () => {
    USAGE.forEach((line) => err(line));
    return 1;
  };
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: { limit: { type: "string" } }, allowPositionals: true });
  } catch {
    return usage();
  }
  const [command, collection, ...extra] = parsed.positionals;
  if (extra.length > 0 || (command === "list" && (collection !== undefined || parsed.values.limit !== undefined))) {
    return usage();
  }
  if (command !== "list" && !(command === "read" && collection !== undefined)) return usage();

  const limitText = parsed.values.limit ?? "20";
  const limit = Number(limitText);
  if (!/^\d+$/.test(limitText) || limit < 1) {
    err(`--limit takes a positive whole number (got "${limitText}").`);
    return 1;
  }

  let names: string[];
  try {
    names = (await client.getCollections()).collections.map((c) => c.name).sort();
  } catch (e) {
    err(`Can't reach Qdrant: ${String(e)}`);
    return 1;
  }

  try {
    if (command === "list") {
      if (names.length === 0) {
        out("No collections yet.");
        return 0;
      }
      for (const name of names) {
        out(`${name}  ${(await client.count(name, { exact: true })).count} points`);
      }
      return 0;
    }

    if (!names.includes(collection as string)) {
      err(`No collection "${collection}". There are: ${names.join(", ") || "none"}.`);
      return 1;
    }
    let points: Array<{ id: string | number; payload?: Record<string, unknown> | null }>;
    try {
      // Qdrant orders by a payload field only when it has an index on it.
      ({ points } = await client.scroll(collection as string, {
        limit,
        with_payload: true,
        order_by: { key: "timestamp", direction: "desc" },
      }));
    } catch (e) {
      if (!isMissingOrderIndex(e)) throw e;
      err(`${collection} has no timestamp index: points in Qdrant's own order.`);
      ({ points } = await scrollCollection(client, collection as string, { limit }));
    }
    points.flatMap(pointLines).forEach((line) => out(line));
    return 0;
  } catch (e) {
    err(`Qdrant error: ${String(e)}`);
    return 1;
  }
}

if (import.meta.main) {
  const client = new QdrantClient({ url: process.env.QDRANT_URL ?? "http://qdrant:6333" });
  process.exit(
    await runMemoryCli(process.argv.slice(2), {
      client,
      out: (line) => console.log(line),
      err: (line) => console.error(line),
    }),
  );
}
