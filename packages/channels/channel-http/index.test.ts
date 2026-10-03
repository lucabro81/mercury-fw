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
  ...over,
});

describe("httpChannel", () => {
  // A literal, not CHANNEL_API_VERSION: the import reports whatever contract
  // is installed, so an old channel next to a newer core would claim the new
  // version and be loaded. The literal is the contract this code was written for.
  it("declares the http name at channel api version 2", () => {
    expect(httpChannel.name).toBe("http");
    expect(httpChannel.apiVersion).toBe(2);
  });

  it("builds a provider when confirm, resolveConfirmation and reads are all present", () => {
    const provider = httpChannel.build(fullCtx());
    expect(typeof provider?.start).toBe("function");
    expect(typeof provider?.notify).toBe("function");
    expect(typeof provider?.stop).toBe("function");
  });

  it("throws (loader isolates it) when resolveConfirmation is missing", () => {
    expect(() => httpChannel.build(fullCtx({ resolveConfirmation: undefined }))).toThrow(/resolveConfirmation/);
  });

  it("throws (loader isolates it) when reads is missing", () => {
    expect(() => httpChannel.build(fullCtx({ reads: undefined }))).toThrow(/reads/);
  });
});
