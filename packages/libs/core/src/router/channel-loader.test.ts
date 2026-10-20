import { describe, expect, it, mock } from "bun:test";
import { CHANNEL_API_VERSION, type ChannelPlugin, type ChannelRuntimeContext, type Provider } from "@mercury-fw/channel-types";
import { channelMessages, loadChannels } from "./channel-loader.ts";

/** A throwaway provider — the loader never calls its methods, only carries it. */
function fakeProvider(): Provider {
  return {
    start: async () => {},
    notify: async () => ({ sessionKey: "s" }),
  };
}

/** Builds a runtime context with a capturing logger for assertions. */
function runtimeWith(logs: string[]): ChannelRuntimeContext {
  return {
    env: {},
    log: (msg) => logs.push(msg),
    confirm: async () => null,
    admit: async () => ({ ok: true }),
    i18n: { forRequest: async () => ({ locale: "en", t: (key) => key }) },
  };
}

function channel(name: string, build: ChannelPlugin["build"], apiVersion = CHANNEL_API_VERSION): ChannelPlugin {
  return { apiVersion, name, build };
}

describe("loadChannels", () => {
  it("builds and returns a declared channel, keyed by name", () => {
    const provider = fakeProvider();
    const loaded = loadChannels([channel("google-chat", () => provider)], {
      runtime: runtimeWith([]),
    });
    expect(loaded).toEqual([{ name: "google-chat", provider }]);
  });

  it("passes the runtime context to build", () => {
    const runtime = runtimeWith([]);
    const build = mock((ctx: ChannelRuntimeContext) => {
      expect(ctx).toBe(runtime);
      return fakeProvider();
    });
    loadChannels([channel("google-chat", build)], { runtime });
    expect(build).toHaveBeenCalledTimes(1);
  });

  it("treats a build that returns undefined as present-but-inert (not started, no error)", () => {
    const logs: string[] = [];
    const loaded = loadChannels([channel("google-chat", () => undefined)], {
      runtime: runtimeWith(logs),
    });
    expect(loaded).toEqual([]);
  });

  it("refuses an incompatible apiVersion fail-soft, without building it", () => {
    const logs: string[] = [];
    const build = mock(() => fakeProvider());
    const loaded = loadChannels([channel("google-chat", build, CHANNEL_API_VERSION + 1)], {
      runtime: runtimeWith(logs),
    });
    expect(loaded).toEqual([]);
    expect(build).not.toHaveBeenCalled();
    expect(logs.some((l) => l.includes("google-chat") && l.includes("apiVersion"))).toBe(true);
  });

  // Guards against a channel written for apiVersion 1 (opaque userId/wikiUserId,
  // no principal) being loaded by a core that reads the turn's principal.
  it("refuses a channel written for the previous contract, before the principal", () => {
    const logs: string[] = [];
    const build = mock(() => fakeProvider());
    const loaded = loadChannels([channel("google-chat", build, 1)], { runtime: runtimeWith(logs) });
    expect(loaded).toEqual([]);
    expect(build).not.toHaveBeenCalled();
    expect(logs.some((l) => l.includes("google-chat") && l.includes("apiVersion 1"))).toBe(true);
  });

  // Guards against a channel written for apiVersion 2 (confirm and the reads
  // without the caller's principal) being handed per-person getters it would
  // call with its arguments shifted.
  it("refuses a channel written for contract 2, before reads were per person", () => {
    const logs: string[] = [];
    const build = mock(() => fakeProvider());
    const loaded = loadChannels([channel("http", build, 2)], { runtime: runtimeWith(logs) });
    expect(loaded).toEqual([]);
    expect(build).not.toHaveBeenCalled();
    expect(logs.some((l) => l.includes("http") && l.includes("apiVersion 2"))).toBe(true);
  });

  // The first-party channels declare their version as a literal: one written
  // for a newer contract, next to an older core, must be refused, not loaded.
  it("refuses a channel written for a newer contract than this core's", () => {
    const logs: string[] = [];
    const build = mock(() => fakeProvider());
    const loaded = loadChannels([channel("google-chat", build, CHANNEL_API_VERSION + 1)], { runtime: runtimeWith(logs) });
    expect(loaded).toEqual([]);
    expect(build).not.toHaveBeenCalled();
    expect(logs.some((l) => l.includes("google-chat") && l.includes(`apiVersion ${CHANNEL_API_VERSION + 1}`))).toBe(true);
  });

  // #281: a channel's texts are its own, like a plugin's: a key outside its
  // name, or the core's or the app's name, would shadow someone else's.
  it("refuses a channel whose texts reach outside its name, or named core or app, without building it", () => {
    const logs: string[] = [];
    const build = mock(() => fakeProvider());
    const loaded = loadChannels(
      [
        { ...channel("http", build), messages: { "http.ok": "ok", "core.confirm.done": "x" } },
        { ...channel("app", build), messages: {} },
        { ...channel("google-chat", () => fakeProvider()), messages: { "google-chat.ok": "ok" } },
      ],
      { runtime: runtimeWith(logs) },
    );
    expect(loaded.map((l) => l.name)).toEqual(["google-chat"]);
    expect(build).not.toHaveBeenCalled();
    expect(logs).toEqual([
      'channel "http" not activated: key "core.confirm.done" is outside the "http." namespace',
      'channel "app" not activated: "app" is reserved for the app\'s own texts',
    ]);
  });

  it("isolates a build that throws and keeps the other channels", () => {
    const logs: string[] = [];
    const good = fakeProvider();
    const loaded = loadChannels(
      [
        channel("boom", () => {
          throw new Error("kaboom");
        }),
        channel("google-chat", () => good),
      ],
      { runtime: runtimeWith(logs) },
    );
    expect(loaded).toEqual([{ name: "google-chat", provider: good }]);
    expect(logs.some((l) => l.includes("boom") && l.includes("kaboom"))).toBe(true);
  });
});

// Review of #281: a channel the loader refuses (another contract, texts
// outside its name) fed its keys to the instance's languages anyway, so the
// startup report asked for translations of a channel that never ran.
describe("channelMessages", () => {
  it("merges the texts of the channels the loader would load, and only theirs", () => {
    const build = () => fakeProvider();
    expect(
      channelMessages([
        { ...channel("http", build), messages: { "http.a": "A" } },
        { ...channel("google-chat", build, CHANNEL_API_VERSION - 1), messages: { "google-chat.a": "B" } },
        { ...channel("slack", build), messages: { "core.x": "C" } },
        channel("terminal", build),
      ]),
    ).toEqual({ "http.a": "A" });
  });
});
