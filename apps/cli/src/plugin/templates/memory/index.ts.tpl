/**
 * The __TITLE__ plugin: a memory that keeps what each person asked about and
 * reads the latest back to the model at the start of their next session.
 * Written by `mfw plugin create` as a starting point for a memory of its own:
 * - `afterTurn` keeps the turn's topic, as background work (`ctx.job`): the
 *   person never waits on it;
 * - `onSessionClose` trims what the person's topics grew to;
 * - `context` is a session layer: what the model reads, when a context profile
 *   lists the plugin among its `layers`.
 * Everything lives in the plugin's data folder (`ctx.dataDir`), a file per
 * person. A memory is enrichment: when its store fails, it logs and the agent
 * goes on without it.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Plugin } from "@mercury-fw/kit";

/** One thing a person asked about, and when. */
export type Topic = { at: string; topic: string };

export type __PASCAL__Options = {
  /** How many topics each person keeps; the oldest go when a session closes. 20 unless given. */
  keep?: number;
};

/** How long a topic is kept, in characters: the first line of the message, cut. */
const TOPIC_CHARS = 120;

/** What the person asked about in `input`: its first line, cut. */
export function topicOf(input: string): string {
  const line = input.trim().split("\n")[0]!.trim();
  return line.length > TOPIC_CHARS ? `${line.slice(0, TOPIC_CHARS - 1)}…` : line;
}

/** The topics of each person, in a JSON file of theirs in `dir`. */
function topicFiles(dir: string) {
  const file = (person: string) => join(dir, `${encodeURIComponent(person)}.json`);
  const read = async (person: string): Promise<Topic[]> => {
    try {
      return JSON.parse(await readFile(file(person), "utf8")) as Topic[];
    } catch {
      return [];
    }
  };
  // A temporary file renamed over the old one: two sessions may write at once.
  const write = async (person: string, topics: Topic[]) => {
    await mkdir(dir, { recursive: true });
    const temp = `${file(person)}.${crypto.randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(topics));
    await rename(temp, file(person));
  };
  return { read, write };
}

/** The plugin. */
export function __EXPORT__(options: __PASCAL__Options = {}): Plugin {
  const keep = options.keep ?? 20;
  return {
    // The contract this plugin is written for, as a literal: importing
    // PLUGIN_API_VERSION would report whichever contract is installed.
    apiVersion: __API_VERSION__,
    name: "__NAME__",
    description: "Remembers what each person asked about, and recalls the latest when they come back.",
    actsAs: "anyone",
    build: (ctx) => {
      if (ctx.dataDir === undefined) {
        ctx.log("__NAME__: no data folder: it remembers nothing");
        return {};
      }
      const topics = topicFiles(ctx.dataDir);
      const job = ctx.job ?? (<T,>(_name: string, _urgency: string, fn: () => Promise<T>) => fn());
      const failed = (what: string) => (err: unknown) => ctx.log(`__NAME__: ${what} failed: ${err instanceof Error ? err.message : String(err)}`);
      return {
        afterTurn: async (turn) => {
          // The terminal's turns are the operator's: nothing of theirs is kept.
          const topic = topicOf(turn.input);
          if (turn.operator || topic === "") return;
          await job("keep-topic", "idle", async () => {
            const kept = await topics.read(turn.person.key);
            await topics.write(turn.person.key, [...kept, { at: new Date().toISOString(), topic }]);
          }).catch(failed("keeping a topic"));
        },
        onSessionClose: async (session) => {
          const kept = await topics.read(session.person.key);
          if (kept.length > keep) await topics.write(session.person.key, kept.slice(-keep)).catch(failed("trimming the topics"));
        },
        context: {
          scope: "session",
          knobs: { topics: { type: "integer", default: 5, min: 0, max: 20, description: "How many of the person's latest topics the model reads" } },
          build: async (req) => {
            if (req.operator) return [];
            const count = Number(req.knobs.topics ?? 5);
            const latest = count > 0 ? (await topics.read(req.person.key)).slice(-count) : [];
            return latest.length === 0 ? [] : [`Earlier, the person asked about:\n${latest.map((t) => `- ${t.topic}`).join("\n")}`];
          },
        },
      };
    },
  };
}
