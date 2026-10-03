import { describe, it, expect } from "bun:test";
import { handleTurnRequest, handleConfirmRequest, openApiResponse, readRoutes } from "./http-server.ts";
import type { HandleTurn, InboundTurn, TurnSink, ChannelHostReads } from "@mercury-fw/channel-types";
import type { StepInfo } from "@mercury-fw/plugin-types";

/**
 * The conversational endpoint's streaming behaviour, exercised without a socket:
 * a normal turn streams reasoning/text/final SSE events and hands the model an
 * http InboundTurn; a bare token is resolved via the injected `confirm` without
 * ever calling the model; a staged confirm-required action surfaces as a
 * `pending` event with its token. Confirm is injected — the fakes stand in for
 * the core's `confirm`/`resolveConfirmation` closures.
 */
const turnReq = (body: unknown): Request =>
  new Request("http://x/turn", { method: "POST", body: JSON.stringify(body) });

describe("handleTurnRequest", () => {
  it("streams reasoning, text and final events and passes an http InboundTurn keyed by conversationId", async () => {
    let seen: InboundTurn | undefined;
    const handleTurn: HandleTurn = async (turn, sink) => {
      seen = turn;
      sink.onReasoningChunk?.("thinking", "r1");
      sink.onReasoningEnd?.("r1", false);
      sink.onTextChunk?.("Hello");
      await sink.finalize("Hello world");
    };
    const res = await handleTurnRequest(turnReq({ text: "hi", conversationId: "conv-1" }), {
      handleTurn,
      confirm: async () => null,
    });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const body = await res.text();
    expect(body).toContain("event: reasoning");
    expect(body).toContain("event: text");
    expect(body).toContain("event: final");
    expect(body).toContain("Hello world");
    expect(seen?.sessionKey).toBe("conv-1");
    expect(seen?.channel).toBe("http");
    expect(seen?.multiUser).toBe(false);
    // Nobody vouches for an HTTP caller until the channel authenticates (#37).
    expect(seen?.principal).toEqual({ id: "conv-1", provider: "none" });
  });

  it("streams multiple text/reasoning deltas incrementally, all before the final event (never one block)", async () => {
    const handleTurn: HandleTurn = async (_turn, sink) => {
      sink.onReasoningChunk?.("th", "r1");
      sink.onReasoningChunk?.("inking", "r1");
      sink.onTextChunk?.("Hel");
      sink.onTextChunk?.("lo ");
      sink.onTextChunk?.("world");
      await sink.finalize("Hello world");
    };
    const res = await handleTurnRequest(turnReq({ text: "hi", conversationId: "c" }), {
      handleTurn,
      confirm: async () => null,
    });
    const body = await res.text();
    // At least two incremental text deltas arrived...
    const textEvents = body.match(/event: text/g) ?? [];
    expect(textEvents.length).toBeGreaterThanOrEqual(2);
    expect((body.match(/event: reasoning/g) ?? []).length).toBeGreaterThanOrEqual(2);
    // ...and every delta was emitted before the final event, not batched after it.
    expect(body.lastIndexOf("event: text")).toBeLessThan(body.indexOf("event: final"));
    expect(body.lastIndexOf("event: reasoning")).toBeLessThan(body.indexOf("event: final"));
  });

  it("resolves a confirmation token via the injected confirm without ever calling the model", async () => {
    let modelCalled = false;
    const handleTurn: HandleTurn = async () => {
      modelCalled = true;
    };
    const res = await handleTurnRequest(turnReq({ text: "SOME-TOKEN", conversationId: "c" }), {
      handleTurn,
      confirm: async () => "Confermato ed eseguito: {}",
    });
    const body = await res.text();
    expect(modelCalled).toBe(false);
    expect(body).toContain("event: final");
    expect(body).toContain("Confermato ed eseguito");
  });

  it("surfaces a staged confirm-required action as a pending event with its command and token", async () => {
    const pendingStep: StepInfo = {
      toolCalls: [{ toolCallId: "1", toolName: "runCommand", input: { command: "jira issue delete KAN-1" } }],
      toolResults: [
        { toolCallId: "1", toolName: "runCommand", output: { ok: false, pendingConfirmation: true, token: "TOK-123", summary: "jira issue delete KAN-1" } },
      ],
      content: [],
    } as unknown as StepInfo;
    const handleTurn: HandleTurn = async (_turn, sink) => {
      sink.onStep?.(pendingStep);
      await sink.finalize("staged");
    };
    const res = await handleTurnRequest(turnReq({ text: "delete KAN-1", conversationId: "c" }), {
      handleTurn,
      confirm: async () => null,
    });
    const body = await res.text();
    expect(body).toContain("event: pending");
    expect(body).toContain("jira issue delete KAN-1");
    expect(body).toContain("TOK-123");
  });

  it("uses a fresh ephemeral session key when the client supplies no conversationId", async () => {
    let seenKey: string | undefined;
    const handleTurn: HandleTurn = async (turn, sink) => {
      seenKey = turn.sessionKey;
      await sink.finalize("x");
    };
    await handleTurnRequest(turnReq({ text: "hi" }), {
      handleTurn,
      confirm: async () => null,
      newSessionKey: () => "ephemeral-123",
    });
    expect(seenKey).toBe("ephemeral-123");
  });

  it("reports a mid-turn failure as an error event rather than throwing", async () => {
    const handleTurn: HandleTurn = async () => {
      throw new Error("model exploded");
    };
    const res = await handleTurnRequest(turnReq({ text: "hi", conversationId: "c" }), {
      handleTurn,
      confirm: async () => null,
    });
    const body = await res.text();
    expect(body).toContain("event: error");
    expect(body).toContain("model exploded");
  });

  it("aborts the in-flight turn's signal when the client cancels the stream (stop button)", async () => {
    let captured: AbortSignal | undefined;
    const handleTurn: HandleTurn = async (turn) => {
      captured = turn.abortSignal;
      // A long turn that only unblocks when the client cancels.
      await new Promise<void>((resolve) => {
        turn.abortSignal?.addEventListener("abort", () => resolve());
      });
    };
    const res = await handleTurnRequest(turnReq({ text: "hi", conversationId: "c" }), {
      handleTurn,
      confirm: async () => null,
    });
    // Let start() reach handleTurn (signal captured, listener registered)...
    await new Promise((r) => setTimeout(r, 5));
    // ...then disconnect as a browser stop button would.
    await res.body!.cancel();
    expect(captured?.aborted).toBe(true);
  });

  it("delivers no error event to a client that canceled mid-turn, even when the turn then throws", async () => {
    const handleTurn: HandleTurn = async (turn, sink) => {
      sink.onTextChunk?.("partial");
      // On cancel the turn's generation throws (an aborted model call) — this
      // must not surface as an `error` event: cancellation is a clean stop.
      await new Promise<void>((_resolve, reject) => {
        turn.abortSignal?.addEventListener("abort", () => reject(new Error("aborted mid-flight")));
      });
    };
    const res = await handleTurnRequest(turnReq({ text: "hi", conversationId: "c" }), {
      handleTurn,
      confirm: async () => null,
    });
    const reader = res.body!.getReader();
    const first = await reader.read();
    const seen = first.value ? new TextDecoder().decode(first.value) : "";
    await reader.cancel();
    expect(seen).toContain("event: text");
    expect(seen).not.toContain("event: error");
  });

  // The conversation id is client input that becomes the session key, a log
  // prefix and (until #37) the wiki id: ".." used to reach every user's notes,
  // a newline could forge log lines, a lone surrogate made encoding throw.
  it("returns 400 for a conversationId outside letters, digits, '-' and '_', without running a turn", async () => {
    let ran = false;
    const deps = {
      handleTurn: async () => {
        ran = true;
      },
      confirm: async () => null,
    };
    for (const conversationId of ["..", ".", "a/b", "a b", "a\nb", "\ud800", "x".repeat(129)]) {
      const res = await handleTurnRequest(turnReq({ text: "hi", conversationId }), deps);
      expect(res.status).toBe(400);
    }
    expect(ran).toBe(false);
  });

  it("trims surrounding whitespace before checking the conversationId", async () => {
    const seen: string[] = [];
    const deps = {
      handleTurn: async (turn: InboundTurn, sink: TurnSink) => {
        seen.push(turn.sessionKey);
        await sink.finalize("ok");
      },
      confirm: async () => null,
    };
    const res = await handleTurnRequest(turnReq({ text: "hi", conversationId: "  abc\n" }), deps);
    await res.text();
    expect(seen).toEqual(["abc"]);
  });

  it("accepts a UUID and a 128-character conversationId", async () => {
    const seen: string[] = [];
    const deps = {
      handleTurn: async (turn: InboundTurn, sink: TurnSink) => {
        seen.push(turn.sessionKey);
        await sink.finalize("ok");
      },
      confirm: async () => null,
    };
    const uuid = "0b6f3c1e-8f2a-4c5d-9e7b-1a2b3c4d5e6f";
    for (const conversationId of [uuid, "x".repeat(128)]) {
      const res = await handleTurnRequest(turnReq({ text: "hi", conversationId }), deps);
      await res.text();
    }
    expect(seen).toEqual([uuid, "x".repeat(128)]);
  });

  it("returns 400 for a body with no text", async () => {
    const res = await handleTurnRequest(turnReq({ conversationId: "c" }), {
      handleTurn: async () => {},
      confirm: async () => null,
    });
    expect(res.status).toBe(400);
  });
});

// An explicit confirmation endpoint: a nicer contract than re-POSTing the bare
// token as `text` to /turn. It maps the injected resolveConfirmation's structured
// ConfirmOutcome onto the response — the store-backed end-to-end behaviour lives
// in @mercury-fw/confirm-engine's own tests.
describe("handleConfirmRequest", () => {
  const confirmReq = (body: unknown): Request =>
    new Request("http://x/confirm", { method: "POST", body: JSON.stringify(body) });

  it("maps an ok outcome to resolved:true with CORS", async () => {
    const res = await handleConfirmRequest(confirmReq({ token: "k9m2-x7q4", conversationId: "c" }), {
      resolveConfirmation: async () => ({ status: "ok", data: { deleted: "KAN-1" } }),
    });
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(await res.json()).toMatchObject({ ok: true, resolved: true, text: expect.stringContaining("Confermato ed eseguito") });
  });

  // Regression for the #35 cold review: a well-shaped token that isn't pending
  // must report resolved:false, so a UI branching on `resolved` never treats an
  // expired/unknown token as confirmed.
  it("maps a not-found outcome to resolved:false", async () => {
    const res = await handleConfirmRequest(confirmReq({ token: "k9m2-x7q4", conversationId: "c" }), {
      resolveConfirmation: async () => ({ status: "not-found" }),
    });
    expect(await res.json()).toEqual({ ok: true, resolved: false });
  });

  it("maps a failed outcome to resolved:true reporting the failure", async () => {
    const res = await handleConfirmRequest(confirmReq({ token: "k9m2-x7q4", conversationId: "c" }), {
      resolveConfirmation: async () => ({ status: "failed", error: "boom" }),
    });
    expect(await res.json()).toMatchObject({ ok: true, resolved: true, text: expect.stringContaining("l'esecuzione è fallita") });
  });

  it("passes the conversationId as the session key", async () => {
    let seenKey: string | undefined;
    await handleConfirmRequest(confirmReq({ token: "k9m2-x7q4", conversationId: "conv-9" }), {
      resolveConfirmation: async (_token, sessionKey) => {
        seenKey = sessionKey;
        return { status: "not-found" };
      },
    });
    expect(seenKey).toBe("conv-9");
  });

  it("returns 400 for a conversationId outside the allowed characters, without resolving", async () => {
    let resolved = false;
    const stub = {
      resolveConfirmation: async () => {
        resolved = true;
        return { status: "not-found" as const };
      },
    };
    const res = await handleConfirmRequest(confirmReq({ token: "TOK", conversationId: ".." }), stub);
    expect(res.status).toBe(400);
    expect(resolved).toBe(false);
  });

  it("returns 400 when token or conversationId is missing", async () => {
    const stub = { resolveConfirmation: async () => ({ status: "not-found" as const }) };
    const noToken = await handleConfirmRequest(confirmReq({ conversationId: "c" }), stub);
    expect(noToken.status).toBe(400);
    const noConv = await handleConfirmRequest(confirmReq({ token: "TOK" }), stub);
    expect(noConv.status).toBe(400);
  });
});

describe("openApiResponse", () => {
  it("serves the OpenAPI document as text/yaml with CORS", async () => {
    const res = openApiResponse();
    expect(res.headers.get("content-type")).toContain("text/yaml");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const body = await res.text();
    expect(body).toContain("openapi:");
    expect(body).toContain("Mercury HTTP surface");
  });
});

// A browser UI on another origin (the separate custom-UI project) can only call
// this surface if it answers CORS preflight and echoes an allow-origin header.
describe("CORS", () => {
  const reads: ChannelHostReads = {
    manifest: () => ({ plugins: [] }),
    pendingConfirmations: () => [],
    conversation: async () => ({ messages: [], nextOffset: null }),
    conversations: async () => ({ conversations: [] }),
    wikiList: async () => [],
    wikiRead: async () => "",
    wikiGrep: async () => [],
    memoryScroll: async () => ({ points: [] }),
    toolLog: () => [],
    health: async () => ({}),
  };

  it("adds Access-Control-Allow-Origin to a read route response (default *)", async () => {
    const res = await readRoutes(reads)["/manifest"]!.GET(new Request("http://x/manifest"));
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("answers an OPTIONS preflight with 204 and the allow headers", async () => {
    const res = readRoutes(reads)["/manifest"]!.OPTIONS();
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-methods")).toContain("GET");
    expect(res.headers.get("access-control-allow-headers")).toContain("content-type");
  });

  it("honors a custom corsOrigin on read routes", async () => {
    const res = await readRoutes(reads, "https://ui.example")["/manifest"]!.GET(
      new Request("http://x/manifest"),
    );
    expect(res.headers.get("access-control-allow-origin")).toBe("https://ui.example");
  });

  it("adds Access-Control-Allow-Origin to the /turn SSE response", async () => {
    const res = await handleTurnRequest(turnReq({ text: "hi", conversationId: "c" }), {
      handleTurn: async (_t, sink) => {
        await sink.finalize("x");
      },
      confirm: async () => null,
    });
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("adds Access-Control-Allow-Origin to a 400 response", async () => {
    const res = await handleTurnRequest(turnReq({ conversationId: "c" }), {
      handleTurn: async () => {},
      confirm: async () => null,
    });
    expect(res.status).toBe(400);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });
});

// A UI reloading a conversation reads its durable transcript back here.
describe("GET /conversation", () => {
  const baseReads: ChannelHostReads = {
    manifest: () => ({}),
    pendingConfirmations: () => [],
    conversation: async () => ({ messages: [], nextOffset: null }),
    conversations: async () => ({ conversations: [] }),
    wikiList: async () => [],
    wikiRead: async () => "",
    wikiGrep: async () => [],
    memoryScroll: async () => ({ points: [] }),
    toolLog: () => [],
    health: async () => ({}),
  };

  // /conversations lists every channel's archived session keys (Google Chat's
  // "spaces/X:users/42", the terminal's "terminal"): the read route must open
  // each of them. The /turn id rule doesn't apply here; the id is only a filter.
  it("opens a session key /conversations lists, whatever channel it came from", async () => {
    const seen: string[] = [];
    const reads: ChannelHostReads = {
      ...baseReads,
      conversations: async () => ({ conversations: [{ id: "spaces/X:users/42" }, { id: "terminal" }] }),
      conversation: async (id) => {
        seen.push(id);
        return { messages: [], nextOffset: null };
      },
    };
    const routes = readRoutes(reads);
    const listed = (await (await routes["/conversations"]!.GET(new Request("http://x/conversations"))).json()) as {
      conversations: Array<{ id: string }>;
    };
    for (const { id } of listed.conversations) {
      const res = await routes["/conversation"]!.GET(new Request(`http://x/conversation?id=${encodeURIComponent(id)}`));
      expect(res.status).toBe(200);
    }
    expect(seen).toEqual(["spaces/X:users/42", "terminal"]);
  });

  it("returns 400 when ?id is missing", async () => {
    const res = await readRoutes(baseReads)["/conversation"]!.GET(new Request("http://x/conversation"));
    expect(res.status).toBe(400);
  });

  it("returns the conversation's messages and forwards id/limit/offset to the getter", async () => {
    let seen: { id: string; limit: number; offset?: string } | undefined;
    const reads: ChannelHostReads = {
      ...baseReads,
      conversation: async (id, limit, offset) => {
        seen = { id, limit, offset };
        return {
          messages: [{ role: "user", content: "hi", timestamp: "2026-09-24T10:00:00.000Z" }],
          nextOffset: null,
        };
      },
    };
    const res = await readRoutes(reads)["/conversation"]!.GET(
      new Request("http://x/conversation?id=conv-1&limit=10&offset=cur"),
    );
    const payload = (await res.json()) as { ok: boolean; messages: unknown[]; nextOffset: unknown };
    expect(seen).toEqual({ id: "conv-1", limit: 10, offset: "cur" });
    expect(payload.ok).toBe(true);
    expect(payload.messages).toHaveLength(1);
    expect(payload.nextOffset).toBeNull();
  });

  it("GET /conversations lists conversations and forwards the limit", async () => {
    let seenLimit: number | undefined;
    const reads: ChannelHostReads = {
      ...baseReads,
      conversations: async (limit) => {
        seenLimit = limit;
        return { conversations: [{ sessionKey: "conv-1", lastTimestamp: "t", preview: "hi" }] };
      },
    };
    const res = await readRoutes(reads)["/conversations"]!.GET(
      new Request("http://x/conversations?limit=5"),
    );
    const payload = (await res.json()) as { ok: boolean; conversations: unknown[] };
    expect(seenLimit).toBe(5);
    expect(payload.ok).toBe(true);
    expect(payload.conversations).toHaveLength(1);
  });
});
