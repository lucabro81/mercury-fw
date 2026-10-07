import { describe, it, expect } from "bun:test";
import { httpChannel } from "./index.ts";
import type { ChannelRuntimeContext, ChannelHostReads } from "@mercury-fw/channel-types";

const reads: ChannelHostReads = {
  manifest: () => ({}),
  pendingConfirmations: () => [],
  conversation: async () => ({}),
  conversations: async () => ({}),
  wikiList: async () => [],
  wikiRead: async () => "",
  wikiGrep: async () => [],
  memoryScroll: async () => ({}),
  toolLog: () => [],
  health: async () => ({}),
};

const fullCtx = (over: Partial<ChannelRuntimeContext> = {}): ChannelRuntimeContext => ({
  env: {},
  log: () => {},
  confirm: async () => null,
  resolveConfirmation: async () => ({ status: "not-a-token" }),
  reads,
  authenticate: async () => null,
  ...over,
});

describe("httpChannel", () => {
  // A literal, not CHANNEL_API_VERSION: the import reports whatever contract
  // is installed, so an old channel next to a newer core would claim the new
  // version and be loaded. The literal is the contract this code was written for.
  it("declares the http name at channel api version 4", () => {
    expect(httpChannel.name).toBe("http");
    expect(httpChannel.apiVersion).toBe(4);
  });

  it("builds a provider when confirm, resolveConfirmation, reads and authenticate are all present", () => {
    const provider = httpChannel.build(fullCtx());
    expect(typeof provider?.start).toBe("function");
    expect(typeof provider?.notify).toBe("function");
    expect(typeof provider?.stop).toBe("function");
  });

  // #176: the provider can send a person back only to a URL it can reach.
  // Review of #176: offered once the server listens, so a surface that failed
  // to start never sends people to a callback nobody serves.
  it("offers its login callback when it has a public URL, once it's listening", async () => {
    for (const publicUrl of ["https://mercury.example", "https://mercury.example/"]) {
      const accepted: string[] = [];
      const provider = httpChannel.build(
        fullCtx({
          env: { HTTP_SURFACE_PUBLIC_URL: publicUrl, HTTP_SURFACE_PORT: "0" },
          logins: { accept: (url) => accepted.push(url), complete: async () => ({ ok: true, service: "x" }) },
        }),
      )!;
      expect(accepted).toEqual([]);
      await provider.start(async () => {});
      try {
        expect(accepted).toEqual(["https://mercury.example/login/callback"]);
      } finally {
        await provider.stop?.();
      }
    }
  });

  it("offers no login callback without a public URL", async () => {
    const accepted: string[] = [];
    const provider = httpChannel.build(
      fullCtx({ env: { HTTP_SURFACE_PORT: "0" }, logins: { accept: (url) => accepted.push(url), complete: async () => ({ ok: true, service: "x" }) } }),
    )!;
    await provider.start(async () => {});
    await provider.stop?.();
    expect(accepted).toEqual([]);
  });

  it("throws (loader isolates it) when resolveConfirmation is missing", () => {
    expect(() => httpChannel.build(fullCtx({ resolveConfirmation: undefined }))).toThrow(/resolveConfirmation/);
  });

  it("throws (loader isolates it) when reads is missing", () => {
    expect(() => httpChannel.build(fullCtx({ reads: undefined }))).toThrow(/reads/);
  });

  // #37: without an auth provider the surface would be open to anyone who
  // reaches the port, so it doesn't start at all.
  it("throws (loader isolates it) when no auth provider is declared", () => {
    expect(() => httpChannel.build(fullCtx({ authenticate: undefined }))).toThrow(
      "http channel requires an auth provider (auth in mercury.config.ts)",
    );
  });
});
