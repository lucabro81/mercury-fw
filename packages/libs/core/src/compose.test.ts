import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pkg from "../package.json";
import { composeMercury } from "./compose.ts";
import { fakeVectorIndex } from "./memory/__fixtures__/fake-vector-index.ts";
import { fakeConversationStore } from "./memory/__fixtures__/fake-conversation-store.ts";
import type { MercuryConfig } from "./config/define-config.ts";
import { ollamaEmbedding, ollamaModel } from "./model/models.ts";
import { PLUGIN_API_VERSION, type PluginRuntimeContext } from "@mercury-fw/plugin-types";

// Nothing listens on these: Qdrant and Ollama fail soft, and composing never
// asks the model anything.
const ENV = {
  OLLAMA_HOST: "http://127.0.0.1:9",
  OLLAMA_MODEL: "none",
  QDRANT_URL: "http://127.0.0.1:9",
};
// The models every composition below runs on: nothing answers on the host, and composing never asks them anything.
const MODELS = { turn: ollamaModel("none") };
const WITH_EMBEDDING = { ...MODELS, embedding: ollamaEmbedding("nomic") };

describe("composeMercury", () => {
  const saved: Record<string, string | undefined> = {};
  let vault: string;
  let data: string;

  beforeAll(async () => {
    vault = await mkdtemp(join(tmpdir(), "mercury-compose-"));
    data = await mkdtemp(join(tmpdir(), "mercury-compose-data-"));
    for (const [key, value] of Object.entries({ ...ENV, WIKI_VAULT_PATH: vault, MERCURY_DATA_PATH: data })) {
      saved[key] = process.env[key];
      process.env[key] = value;
    }
  });

  afterAll(async () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(vault, { recursive: true, force: true });
    await rm(data, { recursive: true, force: true });
  });

  /** Runs `fn` with MERCURY_DATA_PATH and WIKI_VAULT_PATH set to fresh folders of its own, `.mercury/` in the vault holding `legacy`. */
  async function withFreshFolders(legacy: Record<string, string>, fn: (dirs: { vault: string; data: string }) => Promise<void>): Promise<void> {
    const dirs = {
      vault: await mkdtemp(join(tmpdir(), "mercury-compose-")),
      data: join(await mkdtemp(join(tmpdir(), "mercury-compose-data-")), "data"),
    };
    for (const [path, content] of Object.entries(legacy)) {
      await mkdir(join(dirs.vault, ".mercury"), { recursive: true });
      await writeFile(join(dirs.vault, ".mercury", path), content);
    }
    const before = { vault: process.env.WIKI_VAULT_PATH, data: process.env.MERCURY_DATA_PATH };
    process.env.WIKI_VAULT_PATH = dirs.vault;
    process.env.MERCURY_DATA_PATH = dirs.data;
    try {
      await fn(dirs);
    } finally {
      process.env.WIKI_VAULT_PATH = before.vault;
      process.env.MERCURY_DATA_PATH = before.data;
      await rm(dirs.vault, { recursive: true, force: true });
      await rm(join(dirs.data, ".."), { recursive: true, force: true });
    }
  }

  /** A trace sink keeping what it's given: its build context and the events. */
  function collectingSink() {
    const events: Array<Record<string, unknown>> = [];
    const dirs: string[] = [];
    const sink = {
      apiVersion: 1,
      name: "collect",
      build: (ctx: { dir: string }) => {
        dirs.push(ctx.dir);
        return { write: (e: Record<string, unknown>) => void events.push(e), flush: async () => {} };
      },
    };
    return { sink, events, dirs };
  }

  // #379: Mercury's state needs a volume of its own; without one it would be lost at the next restart.
  it("refuses to start without MERCURY_DATA_PATH", async () => {
    const before = process.env.MERCURY_DATA_PATH;
    delete process.env.MERCURY_DATA_PATH;
    try {
      await expect(composeMercury({ plugins: [], models: MODELS })).rejects.toThrow("MERCURY_DATA_PATH is not set");
    } finally {
      process.env.MERCURY_DATA_PATH = before;
    }
  });

  // #379: the traces and their secret live in the data folder, not in the vault.
  it("gives the trace sink traces/ in the data folder, and keeps the secret there", async () => {
    await withFreshFolders({}, async ({ vault, data }) => {
      const { sink, dirs } = collectingSink();
      await composeMercury({ plugins: [], models: MODELS, traces: { sink } });
      expect(dirs).toEqual([join(data, "traces")]);
      expect((await readFile(join(data, "trace-secret"), "utf8")).trim()).toMatch(/^[0-9a-f]{64}$/);
      expect(await Bun.file(join(vault, ".mercury", "trace-secret")).exists()).toBe(false);
    });
  });

  // #379: an instance from before the data folder keeps its state, copied from the vault's .mercury/ on the first start.
  it("copies the vault's .mercury/ into an empty data folder, and says so in the traces", async () => {
    await withFreshFolders({ "profiles.json": '{"x":{}}', "trace-secret": `${"ab".repeat(32)}\n` }, async ({ data }) => {
      const { sink, events } = collectingSink();
      const app = await composeMercury({ plugins: [], models: MODELS, traces: { sink } });
      await app.tracer.flush();
      expect(await readFile(join(data, "profiles.json"), "utf8")).toBe('{"x":{}}');
      expect(events.find((e) => e.kind === "system.migrated")).toMatchObject({
        kind: "system.migrated",
        area: "data-folder",
        entries: ["profiles.json", "trace-secret"],
      });
    });
  });

  it("emits no system.migrated when there was nothing to copy", async () => {
    await withFreshFolders({}, async () => {
      const { sink, events } = collectingSink();
      const app = await composeMercury({ plugins: [], models: MODELS, traces: { sink } });
      await app.tracer.flush();
      expect(events.some((e) => e.kind === "system.migrated")).toBe(false);
    });
  });

  // #310: the HTTP surface's /version answers what the core puts here.
  it("gives channels the framework's version on their runtime context", async () => {
    const config: MercuryConfig = { plugins: [], models: MODELS };
    const app = await composeMercury(config);
    expect(app.channelRuntime.frameworkVersion).toBe(pkg.version);
  });

  // #358: the app's own version, next to the framework's, as its config declares it.
  it("gives channels the app's version when the config declares one, trimmed, as is", async () => {
    for (const [declared, given] of [
      ["1.2.0", "1.2.0"],
      [" 1.2.0-beta.1 ", "1.2.0-beta.1"],
    ]) {
      const app = await composeMercury({ plugins: [], models: MODELS, version: declared });
      expect(app.channelRuntime.appVersion).toBe(given);
    }
  });

  /** The lines `composeMercury(config)` writes to stderr. */
  async function startupLines(config: MercuryConfig): Promise<string[]> {
    const lines: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
    try {
      await composeMercury(config);
    } finally {
      console.error = original;
    }
    return lines;
  }

  // #383: the models come from the config's `models`, each role logged at startup with its settings.
  it("logs each role's model with the settings the config gives it", async () => {
    const lines = await startupLines({ plugins: [], models: { turn: ollamaModel("big", { think: false, temperature: 0.2, topK: 20, capacity: 8 }) } });
    expect(lines).toContain("[model] turn big: think off, temperature 0.2, top_k 20, capacity 8");
    expect(lines).toContain("[model] background: the turn's model");
  });

  it("logs a background model of its own and the embedding model", async () => {
    const lines = await startupLines({
      plugins: [],
      models: { turn: ollamaModel("big"), background: ollamaModel("small", { think: false }), embedding: ollamaEmbedding("nomic") },
    });
    expect(lines).toContain("[model] turn big: think on, server defaults, capacity 1");
    expect(lines).toContain("[model] background small: think off, server defaults, capacity 1");
    expect(lines).toContain("[model] embedding nomic: capacity 1");
  });

  it("no longer reads OLLAMA_MODEL or OLLAMA_THINK itself: the model is the config's", async () => {
    process.env.OLLAMA_THINK = "false";
    process.env.OLLAMA_MODEL = "from-env";
    try {
      const lines = await startupLines({ plugins: [], models: MODELS });
      expect(lines).toContain("[model] turn none: think on, server defaults, capacity 1");
      expect(lines.some((line) => line.includes("from-env"))).toBe(false);
    } finally {
      delete process.env.OLLAMA_THINK;
      process.env.OLLAMA_MODEL = ENV.OLLAMA_MODEL;
    }
  });

  // #383: memory found by meaning needs an embedding model; an index declared without one can't work.
  it("refuses to start with a vector index and no embedding model, naming what's missing", async () => {
    await expect(
      composeMercury({ plugins: [], models: MODELS, vectorIndex: { apiVersion: 1, name: "fake", build: () => fakeVectorIndex() } }),
    ).rejects.toThrow("vectorIndex is declared but models.embedding isn't");
  });

  it("starts without an embedding model when there's no vector index", async () => {
    await expect(composeMercury({ plugins: [], models: MODELS })).resolves.toBeDefined();
  });

  // #23: the trace level is a config choice; a value it can't be stops startup instead of tracing something else.
  it("refuses to start on a trace level that isn't meta or args", async () => {
    const sink = { apiVersion: 1, name: "none", build: () => ({ write: () => {}, flush: async () => {} }) };
    await expect(composeMercury({ plugins: [], models: MODELS, traces: { sink, level: "full" as "meta" } })).rejects.toThrow(
      'traces.level must be "meta" or "args"',
    );
  });

  // #23: the startup report reaches the traces, structured: what runs, what was left out and why.
  it("reports how the instance started as a system.start event", async () => {
    const events: Array<Record<string, unknown>> = [];
    const sink = {
      apiVersion: 1,
      name: "collect",
      build: () => ({ write: (e: Record<string, unknown>) => void events.push(e), flush: async () => {} }),
    };
    const old = { apiVersion: 0, name: "old", description: "an old plugin" };
    const app = await composeMercury({
      plugins: [old],
      models: { turn: ollamaModel("none", { temperature: 0.2 }), embedding: ollamaEmbedding("nomic", { capacity: 2 }) },
      version: "1.2.0",
      traces: { sink },
    });
    await app.tracer.flush();
    const start = events.find((e) => e.kind === "system.start");
    expect(start).toMatchObject({
      kind: "system.start",
      framework: pkg.version,
      app: "1.2.0",
      models: {
        turn: { name: "none", capacity: 1 },
        background: { name: "none", capacity: 1 },
        embedding: { name: "nomic", capacity: 2 },
      },
      plugins: { activated: [], left: [{ name: "old", reason: expect.stringContaining("apiVersion 0") }] },
      auth: { declared: [], active: false },
      directory: "none",
      credentials: expect.any(Array),
      traceLevel: "meta",
    });
  });

  // #379: the start says whether the instance has a vector index, the one its memory and recall need.
  it("reports the vector index in system.start: none declared, declared and active, declared and left out", async () => {
    const index = (apiVersion: number) => ({ apiVersion, name: "fake", build: () => fakeVectorIndex() });
    const cases: Array<[MercuryConfig["vectorIndex"], unknown]> = [
      [undefined, { declared: null, active: false }],
      [index(1), { declared: "fake", active: true }],
      [index(99), { declared: "fake", active: false }],
    ];
    for (const [vectorIndex, expected] of cases) {
      const { sink, events } = collectingSink();
      const app = await composeMercury({ plugins: [], models: WITH_EMBEDDING, traces: { sink }, ...(vectorIndex === undefined ? {} : { vectorIndex }) });
      await app.tracer.flush();
      expect(events.find((e) => e.kind === "system.start")?.vectorIndex).toEqual(expected);
    }
  });

  // #379: the conversations are read only from a declared store; without one a channel gets no conversation reads.
  it("reports the conversation store in system.start, and gives channels conversation reads only with one", async () => {
    const store = (apiVersion: number) => ({ apiVersion, name: "fake", build: () => fakeConversationStore() });
    const cases: Array<[MercuryConfig["conversationStore"], unknown, boolean]> = [
      [undefined, { declared: null, active: false }, false],
      [store(1), { declared: "fake", active: true }, true],
      [store(99), { declared: "fake", active: false }, false],
    ];
    for (const [conversationStore, expected, reads] of cases) {
      const { sink, events } = collectingSink();
      const app = await composeMercury({ plugins: [], models: MODELS, traces: { sink }, ...(conversationStore === undefined ? {} : { conversationStore }) });
      await app.tracer.flush();
      expect(events.find((e) => e.kind === "system.start")?.conversationStore).toEqual(expected);
      expect(app.channelRuntime.reads?.conversations !== undefined).toBe(reads);
      expect(app.channelRuntime.conversations !== undefined).toBe(reads);
    }
  });

  // #383: each role's model reaches the work it's for. A plugin gets the turn's
  // model as ctx.model and its own handle's through ctx.modelFor.
  it("hands a plugin the turn model and, through modelFor, the model of a handle it was given", async () => {
    const own = ollamaModel("query-writer");
    let seen: { model: unknown; first: unknown; again: unknown } | undefined;
    const plugin = {
      apiVersion: PLUGIN_API_VERSION,
      name: "own-model",
      description: "Answers with a model of its own.",
      build: (ctx: PluginRuntimeContext) => {
        const first = ctx.modelFor?.(own);
        seen = { model: ctx.model, first, again: ctx.modelFor?.(own) };
        return {};
      },
    };
    await composeMercury({ plugins: [plugin], models: { turn: ollamaModel("big"), background: ollamaModel("small") } });
    expect((seen?.model as { modelId: string }).modelId).toBe("big");
    expect((seen?.first as { modelId: string }).modelId).toBe("query-writer");
    expect(seen?.again).toBe(seen?.first);
  });

  // #383: the turn runs on `turn`, the conversation's title on `background`,
  // as a background job the traces report.
  it("runs the turn on the turn model and the conversation's title on the background model, as a job", async () => {
    const { sink, events } = collectingSink();
    const asked: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!url.endsWith("/api/chat")) return new Response("not here", { status: 404 });
      const body = JSON.parse(String(init?.body ?? "{}")) as { model: string };
      asked.push(body.model);
      return Response.json({
        model: body.model,
        created_at: new Date().toISOString(),
        message: { role: "assistant", content: "A short title" },
        done: true,
        done_reason: "stop",
        prompt_eval_count: 1,
        eval_count: 1,
      });
    }) as typeof fetch;
    try {
      const app = await composeMercury({
        plugins: [],
        models: { turn: ollamaModel("big"), background: ollamaModel("small") },
        conversationStore: { apiVersion: 1, name: "fake", build: () => fakeConversationStore() },
        access: { unknown: "allow" },
        traces: { sink },
      });
      await app.handleTurn(
        { channel: "http", multiUser: false, text: "hello", sessionKey: "http:alice:c1", principal: { provider: "static", id: "alice" }, logPrefix: "" },
        { onToolStart: () => {}, finalize: async () => {}, dispose: () => {} } as never,
      );
      for (let i = 0; i < 500 && asked.length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 10));
      expect(asked[0]).toBe("big");
      expect(asked.slice(1)).toEqual(["small"]);
      for (let i = 0; i < 500 && !events.some((e) => e.kind === "background.job"); i++) await new Promise((resolve) => setTimeout(resolve, 10));
      await app.tracer.flush();
      expect(events.filter((e) => e.kind === "background.job")).toEqual([
        expect.objectContaining({ kind: "background.job", job: "title", urgency: "soon", models: ["small"], steps: 1, outcome: "done" }),
      ]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  // A stale config (the old `model`, no `models`) is refused by tsc; without it, the start stops saying what's missing.
  it("refuses to start without models.turn, naming what to declare", async () => {
    await expect(composeMercury({ plugins: [] } as unknown as MercuryConfig)).rejects.toThrow(
      "models.turn is required: declare the model the turns run on with ollamaModel(...)",
    );
  });

  it("gives channels no app version when the config declares none, or an empty one", async () => {
    for (const config of [{ plugins: [], models: MODELS }, { plugins: [], models: MODELS, version: "" }, { plugins: [], models: MODELS, version: "  " }] satisfies MercuryConfig[]) {
      const app = await composeMercury(config);
      expect("appVersion" in app.channelRuntime).toBe(false);
    }
  });
});
