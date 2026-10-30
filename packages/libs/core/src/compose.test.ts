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

  it("gives channels no app version when the config declares none, or an empty one", async () => {
    for (const config of [{ plugins: [] }, { plugins: [], version: "" }, { plugins: [], version: "  " }] satisfies MercuryConfig[]) {
      const app = await composeMercury(config);
      expect("appVersion" in app.channelRuntime).toBe(false);
    }
  });
});
