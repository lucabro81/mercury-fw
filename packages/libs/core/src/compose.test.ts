import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pkg from "../package.json";
import { composeMercury } from "./compose.ts";
import { fakeVectorIndex } from "./memory/__fixtures__/fake-vector-index.ts";
import type { MercuryConfig } from "./config/define-config.ts";

// Nothing listens on these: Qdrant and Ollama fail soft, and composing never
// asks the model anything.
const ENV = {
  OLLAMA_HOST: "http://127.0.0.1:9",
  OLLAMA_MODEL: "none",
  QDRANT_URL: "http://127.0.0.1:9",
};

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
      await expect(composeMercury({ plugins: [] })).rejects.toThrow("MERCURY_DATA_PATH is not set");
    } finally {
      process.env.MERCURY_DATA_PATH = before;
    }
  });

  // #379: the traces and their secret live in the data folder, not in the vault.
  it("gives the trace sink traces/ in the data folder, and keeps the secret there", async () => {
    await withFreshFolders({}, async ({ vault, data }) => {
      const { sink, dirs } = collectingSink();
      await composeMercury({ plugins: [], traces: { sink } });
      expect(dirs).toEqual([join(data, "traces")]);
      expect((await readFile(join(data, "trace-secret"), "utf8")).trim()).toMatch(/^[0-9a-f]{64}$/);
      expect(await Bun.file(join(vault, ".mercury", "trace-secret")).exists()).toBe(false);
    });
  });

  // #379: an instance from before the data folder keeps its state, copied from the vault's .mercury/ on the first start.
  it("copies the vault's .mercury/ into an empty data folder, and says so in the traces", async () => {
    await withFreshFolders({ "profiles.json": '{"x":{}}', "trace-secret": `${"ab".repeat(32)}\n` }, async ({ data }) => {
      const { sink, events } = collectingSink();
      const app = await composeMercury({ plugins: [], traces: { sink } });
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
      const app = await composeMercury({ plugins: [], traces: { sink } });
      await app.tracer.flush();
      expect(events.some((e) => e.kind === "system.migrated")).toBe(false);
    });
  });

  // #310: the HTTP surface's /version answers what the core puts here.
  it("gives channels the framework's version on their runtime context", async () => {
    const config: MercuryConfig = { plugins: [] };
    const app = await composeMercury(config);
    expect(app.channelRuntime.frameworkVersion).toBe(pkg.version);
  });

  // #358: the app's own version, next to the framework's, as its config declares it.
  it("gives channels the app's version when the config declares one, trimmed, as is", async () => {
    for (const [declared, given] of [
      ["1.2.0", "1.2.0"],
      [" 1.2.0-beta.1 ", "1.2.0-beta.1"],
    ]) {
      const app = await composeMercury({ plugins: [], version: declared });
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

  // #355: the main model's settings come from the config's `model` section, logged at startup.
  it("logs the main model with the settings the config gives it", async () => {
    const lines = await startupLines({ plugins: [], model: { think: false, temperature: 0.2, topK: 20 } });
    expect(lines).toContain("[model] none: think off, temperature 0.2, top_k 20");
  });

  it("logs the server's defaults when the config sets nothing", async () => {
    expect(await startupLines({ plugins: [] })).toContain("[model] none: think on, server defaults");
  });

  it("no longer reads OLLAMA_THINK itself: think follows the config", async () => {
    process.env.OLLAMA_THINK = "false";
    try {
      expect(await startupLines({ plugins: [] })).toContain("[model] none: think on, server defaults");
    } finally {
      delete process.env.OLLAMA_THINK;
    }
  });

  it("refuses to start on a setting out of its range", async () => {
    await expect(composeMercury({ plugins: [], model: { temperature: -1 } })).rejects.toThrow(
      "model.temperature must be a number from 0 up, got -1",
    );
  });

  // #23: the trace level is a config choice; a value it can't be stops startup instead of tracing something else.
  it("refuses to start on a trace level that isn't meta or args", async () => {
    const sink = { apiVersion: 1, name: "none", build: () => ({ write: () => {}, flush: async () => {} }) };
    await expect(composeMercury({ plugins: [], traces: { sink, level: "full" as "meta" } })).rejects.toThrow(
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
    const app = await composeMercury({ plugins: [old], model: { temperature: 0.2 }, version: "1.2.0", traces: { sink } });
    await app.tracer.flush();
    const start = events.find((e) => e.kind === "system.start");
    expect(start).toMatchObject({
      kind: "system.start",
      framework: pkg.version,
      app: "1.2.0",
      model: "none",
      modelSettings: { temperature: 0.2 },
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
      const app = await composeMercury({ plugins: [], traces: { sink }, ...(vectorIndex === undefined ? {} : { vectorIndex }) });
      await app.tracer.flush();
      expect(events.find((e) => e.kind === "system.start")?.vectorIndex).toEqual(expected);
    }
  });

  it("gives channels no app version when the config declares none, or an empty one", async () => {
    for (const config of [{ plugins: [] }, { plugins: [], version: "" }, { plugins: [], version: "  " }] satisfies MercuryConfig[]) {
      const app = await composeMercury(config);
      expect("appVersion" in app.channelRuntime).toBe(false);
    }
  });
});
