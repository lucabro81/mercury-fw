import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pkg from "../package.json";
import { composeMercury } from "./compose.ts";
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

  beforeAll(async () => {
    vault = await mkdtemp(join(tmpdir(), "mercury-compose-"));
    for (const [key, value] of Object.entries({ ...ENV, WIKI_VAULT_PATH: vault })) {
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

  it("gives channels no app version when the config declares none, or an empty one", async () => {
    for (const config of [{ plugins: [] }, { plugins: [], version: "" }, { plugins: [], version: "  " }] satisfies MercuryConfig[]) {
      const app = await composeMercury(config);
      expect("appVersion" in app.channelRuntime).toBe(false);
    }
  });
});
