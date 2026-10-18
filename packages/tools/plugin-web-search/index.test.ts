import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLUGIN_API_VERSION, type PluginRuntimeContext, type SessionToolContext, type StageChoices } from "@mercury-fw/plugin-types";
import { webSearchPlugin, WEB_SEARCH_BACKEND_API_VERSION, type WebSearchBackend } from "./index.ts";

const backend: WebSearchBackend = {
  apiVersion: WEB_SEARCH_BACKEND_API_VERSION,
  name: "fake",
  search: async () => ({ ok: true, results: [] }),
};

function ctx(overrides: Partial<PluginRuntimeContext> = {}, logs: string[] = []): PluginRuntimeContext {
  return { model: {} as never, env: {}, log: (m) => logs.push(m), ...overrides };
}

function session(stageChoices?: StageChoices): SessionToolContext {
  return {
    sessionKey: "s",
    stageConfirmation: async () => "t",
    ...(stageChoices ? { stageChoices } : {}),
    stashDisplay: () => "d",
    person: { key: "people:alice" },
    requireLogin: async () => ({ ok: false, error: "x" }),
  };
}

/** Records the labels of what web_fetch stages. */
function recordingStage(labels: string[][]): StageChoices {
  return async (action) => {
    labels.push(action.choices.map((c) => c.label));
    return action.choices.map((c, i) => ({ label: c.label, token: `T${i}` }));
  };
}

/** Offline: every host resolves to a public address and every page is the same small one. */
const deps = {
  resolve: async () => ["93.184.216.34"],
  fetch: (async () => new Response("<html><head><title>T</title></head><body><p>x</p></body></html>", { headers: { "content-type": "text/html" } })) as unknown as typeof fetch,
};

describe("webSearchPlugin", () => {
  it("is a plugin acting as no one, with a prompt fragment", () => {
    const plugin = webSearchPlugin({ backend });
    expect(plugin.apiVersion).toBe(PLUGIN_API_VERSION);
    expect(plugin.name).toBe("web-search");
    expect(plugin.actsAs).toBe("anyone");
    expect(plugin.systemPromptFragment).toContain("web_search");
    expect(plugin.systemPromptFragment).toContain("{{assistant}}");
  });

  it("builds both tools, their status labels and the sources guard", () => {
    const built = webSearchPlugin({ backend }).build!(ctx({ dataDir: mkdtempSync(join(tmpdir(), "ws-")) }));
    expect(Object.keys(built.sessionTools!(session()))).toEqual(["web_search", "web_fetch"]);
    expect(built.toolStatusDescribers!.web_search!({ query: "bun 2" })).toBe('Cerco sul web: "bun 2"');
    expect(built.toolStatusDescribers!.web_fetch!({ url: "https://docs.bun.sh/x" })).toBe("Leggo docs.bun.sh");
    expect(built.toolStatusDescribers!.web_fetch!({ url: "nonsense" })).toBe("Leggo una pagina");
    expect(built.postTurnGuards!.map((g) => g.statusId)).toEqual(["web-search-sources"]);
  });

  it("refuses a backend written for another version of the interface, contributing nothing", () => {
    const logs: string[] = [];
    const built = webSearchPlugin({ backend: { ...backend, apiVersion: 99 } }).build!(ctx({}, logs));
    expect(built).toEqual({});
    expect(logs).toEqual([`web-search: backend "fake" is for version 99 of the backend interface, this plugin speaks ${WEB_SEARCH_BACKEND_API_VERSION}: no tools`]);
  });

  it("drops an allowlist entry that can't be one, saying why, and keeps the rest", async () => {
    const logs: string[] = [];
    const labels: string[][] = [];
    const built = webSearchPlugin({ backend, allowedHosts: ["bun.sh", "github.io", "https://x.org"] }, deps).build!(
      ctx({ dataDir: mkdtempSync(join(tmpdir(), "ws-")) }, logs),
    );

    expect(logs).toEqual([
      "web-search: allowedHosts entry dropped: github.io is a public suffix: it would allow every site under it",
      'web-search: allowedHosts entry dropped: "https://x.org" is not a host name',
    ]);
    const tools = built.sessionTools!(session(recordingStage(labels)));
    // bun.sh is kept: read with no confirmation asked
    expect(await tools.web_fetch!.execute!({ url: "https://bun.sh/" } as never, {} as never)).toMatchObject({ ok: true, title: "T" });
    expect(labels).toEqual([]);
  });

  it("without a data folder, offers only this time and says why once", async () => {
    const logs: string[] = [];
    const labels: string[][] = [];
    const built = webSearchPlugin({ backend }, deps).build!(ctx({}, logs));

    await built.sessionTools!(session(recordingStage(labels))).web_fetch!.execute!({ url: "https://example.org/" } as never, {} as never);

    expect(labels).toEqual([["Solo questa volta"]]);
    expect(logs).toEqual(["web-search: no data folder from the core: nobody can allow a host for good, only one page at a time"]);
  });

  it("asks about a host nobody allowed without looking it up in DNS first", async () => {
    const looked: string[] = [];
    const labels: string[][] = [];
    const built = webSearchPlugin({ backend }, { ...deps, resolve: async (host) => (looked.push(host), ["93.184.216.34"]) }).build!(
      ctx({ dataDir: mkdtempSync(join(tmpdir(), "ws-")) }),
    );

    await built.sessionTools!(session(recordingStage(labels))).web_fetch!.execute!({ url: "https://secret.attacker.example/" } as never, {} as never);

    expect(labels).toHaveLength(1);
    expect(looked).toEqual([]);
  });

  it("with a data folder, offers both choices", async () => {
    const labels: string[][] = [];
    const built = webSearchPlugin({ backend }, deps).build!(ctx({ dataDir: mkdtempSync(join(tmpdir(), "ws-")) }));

    await built.sessionTools!(session(recordingStage(labels))).web_fetch!.execute!({ url: "https://example.org/" } as never, {} as never);

    expect(labels).toEqual([["Solo questa volta", "Sempre per example.org"]]);
  });
});
