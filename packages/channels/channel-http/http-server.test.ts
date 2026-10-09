import { describe, it, expect } from "bun:test";
import { handleTurnRequest, handleConfirmRequest, handleLinkRequest, handleLoginCallback, openApiResponse, readRoutes, startHttpServer } from "./http-server.ts";
import type { Admission, Authenticate, HandleTurn, InboundTurn, TurnSink, ChannelHostReads, Principal } from "@mercury-fw/channel-types";
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

const ALICE: Principal = { id: "alice", provider: "static", displayName: "Alice" };
/** An auth provider that vouches for Alice on every request. */
const asAlice: Authenticate = async () => ALICE;
/** An auth provider that refuses every request. */
const refuse: Authenticate = async () => null;
/** The core refusing whoever the auth provider vouched for: unknown to the directory, or the directory couldn't tell. */
const notAdmitted = (reason: "unknown" | "unavailable") => async (): Promise<Admission> => ({ ok: false, reason, message: `refused (${reason})` });

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
      authenticate: asAlice,
    });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const body = await res.text();
    expect(body).toContain("event: reasoning");
    expect(body).toContain("event: text");
    expect(body).toContain("event: final");
    expect(body).toContain("Hello world");
    expect(seen?.sessionKey).toBe("alice:conv-1");
    expect(seen?.channel).toBe("http");
    expect(seen?.multiUser).toBe(false);
    expect(seen?.principal).toEqual(ALICE);
    expect(seen?.logPrefix).toBe("[http:alice:conv-1] ");
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
      authenticate: asAlice,
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
      authenticate: asAlice,
    });
    const body = await res.text();
    expect(modelCalled).toBe(false);
    expect(body).toContain("event: final");
    expect(body).toContain("Confermato ed eseguito");
  });

  it("streams a tool event with the label, detail, call id and the tool's name", async () => {
    const res = await handleTurnRequest(turnReq({ text: "hi", conversationId: "c" }), {
      handleTurn: async (_turn, sink) => {
        sink.onToolStart("Sto leggendo Jira…", "jira issue list", "tc-1", "jiraCommand");
        sink.onToolFinish?.("tc-1", "success");
        await sink.finalize("done");
      },
      confirm: async () => null,
      authenticate: asAlice,
    });
    const body = await res.text();
    expect(body).toContain(
      `event: tool\ndata: ${JSON.stringify({ label: "Sto leggendo Jira…", detail: "jira issue list", toolCallId: "tc-1", name: "jiraCommand" })}\n\n`,
    );
    expect(body).toContain(`event: tool_finish\ndata: ${JSON.stringify({ toolCallId: "tc-1", outcome: "success" })}\n\n`);
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
      authenticate: asAlice,
    });
    const body = await res.text();
    expect(body).toContain("event: pending");
    expect(body).toContain("jira issue delete KAN-1");
    expect(body).toContain("TOK-123");
  });

  // #176: the link a person logs in with goes to the client, never through the model.
  it("surfaces a login a tool asked for as a login event with the service and the link", async () => {
    const loginStep: StepInfo = {
      toolCalls: [{ toolCallId: "1", toolName: "jiraCommand", input: { command: "jira issue search" } }],
      toolResults: [
        {
          toolCallId: "1",
          toolName: "jiraCommand",
          output: { ok: false, loginRequired: true, service: "jira", authorizeUrl: "https://auth.example/authorize?x=1", error: "log in" },
        },
      ],
      content: [],
    } as unknown as StepInfo;
    const handleTurn: HandleTurn = async (_turn, sink) => {
      sink.onStep?.(loginStep);
      await sink.finalize("You need to log in to Jira first.");
    };
    const res = await handleTurnRequest(turnReq({ text: "my issues", conversationId: "c" }), {
      handleTurn,
      confirm: async () => null,
      authenticate: asAlice,
    });
    const body = await res.text();
    expect(body).toContain('event: login\ndata: {"service":"jira","url":"https://auth.example/authorize?x=1"}\n\n');
    expect(body.indexOf("event: login")).toBeLessThan(body.indexOf("event: final"));
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
      authenticate: asAlice,
      newSessionKey: () => "ephemeral-123",
    });
    expect(seenKey).toBe("alice:ephemeral-123");
  });

  it("reports a mid-turn failure as an error event rather than throwing", async () => {
    const handleTurn: HandleTurn = async () => {
      throw new Error("model exploded");
    };
    const res = await handleTurnRequest(turnReq({ text: "hi", conversationId: "c" }), {
      handleTurn,
      confirm: async () => null,
      authenticate: asAlice,
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
      authenticate: asAlice,
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
      authenticate: asAlice,
    });
    const reader = res.body!.getReader();
    const first = await reader.read();
    const seen = first.value ? new TextDecoder().decode(first.value) : "";
    await reader.cancel();
    expect(seen).toContain("event: text");
    expect(seen).not.toContain("event: error");
  });

  // The conversation id is client input that becomes part of the session key
  // and the log prefix (and, before #37, the wiki id): ".." used to reach every user's notes,
  // a newline could forge log lines, a lone surrogate made encoding throw.
  it("returns 400 for a conversationId outside letters, digits, '-' and '_', without running a turn", async () => {
    let ran = false;
    const deps = {
      handleTurn: async () => {
        ran = true;
      },
      confirm: async () => null,
      authenticate: asAlice,
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
      authenticate: asAlice,
    };
    const res = await handleTurnRequest(turnReq({ text: "hi", conversationId: "  abc\n" }), deps);
    await res.text();
    expect(seen).toEqual(["alice:abc"]);
  });

  it("accepts a UUID and a 128-character conversationId", async () => {
    const seen: string[] = [];
    const deps = {
      handleTurn: async (turn: InboundTurn, sink: TurnSink) => {
        seen.push(turn.sessionKey);
        await sink.finalize("ok");
      },
      confirm: async () => null,
      authenticate: asAlice,
    };
    const uuid = "0b6f3c1e-8f2a-4c5d-9e7b-1a2b3c4d5e6f";
    for (const conversationId of [uuid, "x".repeat(128)]) {
      const res = await handleTurnRequest(turnReq({ text: "hi", conversationId }), deps);
      await res.text();
    }
    expect(seen).toEqual([`alice:${uuid}`, `alice:${"x".repeat(128)}`]);
  });

  it("returns 400 for a body with no text", async () => {
    const res = await handleTurnRequest(turnReq({ conversationId: "c" }), {
      handleTurn: async () => {},
      confirm: async () => null,
      authenticate: asAlice,
    });
    expect(res.status).toBe(400);
  });
});

// #37: every caller is authenticated before anything runs, and a conversation
// belongs to whoever opened it: the session key is `<principal.id>:<conversationId>`,
// so the same id from someone else is a session of their own, and a token
// staged in one person's session can't be confirmed from another's.
describe("authentication on /turn and /confirm", () => {
  const BOB: Principal = { id: "bob", provider: "static" };

  it("answers 401 with a Bearer challenge and CORS, before reading the body, running a turn or a confirmation", async () => {
    let ran = false;
    const res = await handleTurnRequest(new Request("http://x/turn", { method: "POST", body: "not json" }), {
      handleTurn: async () => {
        ran = true;
      },
      confirm: async () => {
        ran = true;
        return null;
      },
      authenticate: refuse,
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe("Bearer");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(await res.json()).toEqual({ ok: false, error: "unauthorized" });
    expect(ran).toBe(false);
  });

  it("hands the request itself to the auth provider", async () => {
    const req = turnReq({ text: "hi", conversationId: "c" });
    let seen: Request | undefined;
    const res = await handleTurnRequest(req, {
      handleTurn: async (_t, sink) => sink.finalize("x"),
      confirm: async () => null,
      authenticate: async (r) => {
        seen = r;
        return ALICE;
      },
    });
    await res.text();
    expect(seen).toBe(req);
  });

  it("gives two people sending the same conversationId two different sessions", async () => {
    const keys: string[] = [];
    for (const who of [ALICE, BOB]) {
      const res = await handleTurnRequest(turnReq({ text: "hi", conversationId: "shared" }), {
        handleTurn: async (turn, sink) => {
          keys.push(turn.sessionKey);
          expect(turn.principal).toEqual(who);
          await sink.finalize("x");
        },
        confirm: async () => null,
        authenticate: async () => who,
      });
      await res.text();
    }
    expect(keys).toEqual(["alice:shared", "bob:shared"]);
  });

  // Before #37 the client's conversationId was the whole session key, so
  // "terminal" landed in the terminal's own session and wiki area.
  it("keeps a conversationId that names another channel's session inside the caller's own", async () => {
    let key: string | undefined;
    const res = await handleTurnRequest(turnReq({ text: "hi", conversationId: "terminal" }), {
      handleTurn: async (turn, sink) => {
        key = turn.sessionKey;
        await sink.finalize("x");
      },
      confirm: async () => null,
      authenticate: asAlice,
    });
    await res.text();
    expect(key).toBe("alice:terminal");
  });

  // Cold review of #37: the caller's id comes from the auth provider, not from
  // the conversation id rule, so a line break in it could forge log lines.
  it("keeps control characters in the caller's id out of the log prefix, not out of the session", async () => {
    let turn: InboundTurn | undefined;
    const res = await handleTurnRequest(turnReq({ text: "hi", conversationId: "c" }), {
      handleTurn: async (t, sink) => {
        turn = t;
        await sink.finalize("x");
      },
      confirm: async () => null,
      authenticate: async () => ({ id: "ali\nce\u0007", provider: "oidc" }),
    });
    await res.text();
    expect(turn?.logPrefix).toBe("[http:ali?ce?:c] ");
    expect(turn?.sessionKey).toBe("ali\nce\u0007:c");
  });

  it("checks a bare token in /turn against the caller's own session, as the caller", async () => {
    let seen: unknown[] = [];
    const res = await handleTurnRequest(turnReq({ text: "k9m2-x7q4", conversationId: "c" }), {
      handleTurn: async () => {},
      confirm: async (token, sessionKey, principal) => {
        seen = [token, sessionKey, principal];
        return "Confermato";
      },
      authenticate: asAlice,
    });
    await res.text();
    expect(seen).toEqual(["k9m2-x7q4", "alice:c", ALICE]);
  });

  it("answers /confirm with 401 without resolving anything", async () => {
    let resolved = false;
    const res = await handleConfirmRequest(
      new Request("http://x/confirm", { method: "POST", body: JSON.stringify({ token: "k9m2-x7q4", conversationId: "c" }) }),
      {
        authenticate: refuse,
        resolveConfirmation: async () => {
          resolved = true;
          return { status: "ok", data: {} };
        },
      },
    );
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe("Bearer");
    expect(resolved).toBe(false);
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
      authenticate: asAlice,
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
      authenticate: asAlice,
      resolveConfirmation: async () => ({ status: "not-found" }),
    });
    expect(await res.json()).toEqual({ ok: true, resolved: false });
  });

  it("maps a failed outcome to resolved:true reporting the failure", async () => {
    const res = await handleConfirmRequest(confirmReq({ token: "k9m2-x7q4", conversationId: "c" }), {
      authenticate: asAlice,
      resolveConfirmation: async () => ({ status: "failed", error: "boom" }),
    });
    expect(await res.json()).toMatchObject({ ok: true, resolved: true, text: expect.stringContaining("l'esecuzione è fallita") });
  });

  it("passes the caller's own session key, and the caller", async () => {
    let seen: unknown[] = [];
    await handleConfirmRequest(confirmReq({ token: "k9m2-x7q4", conversationId: "conv-9" }), {
      authenticate: asAlice,
      resolveConfirmation: async (_token, sessionKey, principal) => {
        seen = [sessionKey, principal];
        return { status: "not-found" };
      },
    });
    expect(seen).toEqual(["alice:conv-9", ALICE]);
  });

  it("returns 400 for a conversationId outside the allowed characters, without resolving", async () => {
    let resolved = false;
    const stub = {
      authenticate: asAlice,
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
    const stub = { authenticate: asAlice, resolveConfirmation: async () => ({ status: "not-found" as const }) };
    const noToken = await handleConfirmRequest(confirmReq({ conversationId: "c" }), stub);
    expect(noToken.status).toBe(400);
    const noConv = await handleConfirmRequest(confirmReq({ token: "TOK" }), stub);
    expect(noConv.status).toBe(400);
  });
});

// #176: where the provider sends the person back after they log in. Public:
// the single-use state is what ties it to the person who started.
describe("handleLoginCallback", () => {
  const callback = (query: string) => new Request(`http://x/login/callback${query}`);

  it("finishes the login the state was issued for, and tells the person to go back", async () => {
    const calls: string[] = [];
    const res = await handleLoginCallback(callback("?code=c-1&state=st-1"), {
      complete: async (state, code) => {
        calls.push(`${state} ${code}`);
        return { ok: true, service: "jira" };
      },
    });
    expect(calls).toEqual(["st-1 c-1"]);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toStartWith("text/plain");
    expect(await res.text()).toBe("You're logged in to jira. Go back to the conversation and ask again.");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("keeps only a short, plain reason from the error the service sent back", async () => {
    const res = await handleLoginCallback(callback(`?error=${encodeURIComponent("access_denied <b>x</b>" + "y".repeat(100))}`), {
      complete: async () => ({ ok: true, service: "jira" }),
    });
    expect(await res.text()).toBe(`The login didn't happen (access_deniedbxb${"y".repeat(48)}). Ask Mercury again for a new link.`);
  });

  it("reports a login that didn't go through", async () => {
    const res = await handleLoginCallback(callback("?code=c&state=st"), {
      complete: async () => ({ ok: false, error: "This login link has expired or was already used: ask Mercury again for a new one." }),
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toBe("This login link has expired or was already used: ask Mercury again for a new one.");
  });

  it("a refused consent, or a request without code and state, completes nothing", async () => {
    for (const [query, text] of [
      ["?error=access_denied&state=st", "The login didn't happen (access_denied). Ask Mercury again for a new link."],
      ["?state=st", "The login link came back without a code or a state. Ask Mercury again for a new link."],
      ["?code=c", "The login link came back without a code or a state. Ask Mercury again for a new link."],
      ["", "The login link came back without a code or a state. Ask Mercury again for a new link."],
    ] as const) {
      let called = false;
      const res = await handleLoginCallback(callback(query), {
        complete: async () => {
          called = true;
          return { ok: true, service: "jira" };
        },
      });
      expect(called).toBe(false);
      expect(res.status).toBe(400);
      expect(await res.text()).toBe(text);
    }
  });

  it("is mounted, without authentication, only when the server can complete logins", async () => {
    const base = { handleTurn: async () => {}, confirm: async () => null, resolveConfirmation: async () => ({ status: "not-a-token" as const }), authenticate: refuse, port: 0 };
    const withLogins = startHttpServer({ ...base, completeLogin: async () => ({ ok: true, service: "jira" }) });
    const without = startHttpServer(base);
    try {
      const ok = await fetch(`http://localhost:${withLogins.port}/login/callback?code=c&state=s`);
      expect(ok.status).toBe(200);
      expect((await fetch(`http://localhost:${without.port}/login/callback?code=c&state=s`)).status).toBe(404);
    } finally {
      withLogins.stop(true);
      without.stop(true);
    }
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
    manifest: async () => ({ plugins: [] }),
    pendingConfirmations: async () => [],
    conversation: async () => ({ messages: [], nextOffset: null }),
    conversations: async () => ({ conversations: [] }),
    wikiList: async () => [],
    wikiRead: async () => "",
    wikiGrep: async () => [],
    memoryScroll: async () => ({ points: [] }),
    toolLog: async () => [],
    health: async () => ({}),
  };

  it("adds Access-Control-Allow-Origin to a read route response (default *)", async () => {
    const res = await readRoutes(reads, asAlice)["/manifest"]!.GET(new Request("http://x/manifest"));
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("answers an OPTIONS preflight with 204 and the allow headers", async () => {
    const res = readRoutes(reads, asAlice)["/manifest"]!.OPTIONS();
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-methods")).toContain("GET");
    expect(res.headers.get("access-control-allow-headers")).toContain("content-type");
    // A browser UI sends its bearer token, so the preflight must allow the header.
    expect(res.headers.get("access-control-allow-headers")).toContain("authorization");
  });

  it("honors a custom corsOrigin on read routes", async () => {
    const res = await readRoutes(reads, asAlice, "https://ui.example")["/manifest"]!.GET(
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
      authenticate: asAlice,
    });
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("adds Access-Control-Allow-Origin to a 400 response", async () => {
    const res = await handleTurnRequest(turnReq({ conversationId: "c" }), {
      handleTurn: async () => {},
      confirm: async () => null,
      authenticate: asAlice,
    });
    expect(res.status).toBe(400);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });
});

// #37: the reads expose conversations, the wiki and memory, so each one needs
// an authenticated caller; #38: and each per-person getter is told who is
// asking, so the core returns only what belongs to them.
describe("authentication on the read routes", () => {
  const calls: Array<[string, unknown]> = [];
  const spyReads: ChannelHostReads = {
    manifest: async (p) => (calls.push(["manifest", p]), {}),
    pendingConfirmations: async (p) => (calls.push(["pendingConfirmations", p]), []),
    conversation: async (p) => (calls.push(["conversation", p]), {}),
    conversations: async (p) => (calls.push(["conversations", p]), { conversations: [] }),
    wikiList: async (p) => (calls.push(["wikiList", p]), []),
    wikiRead: async (p) => (calls.push(["wikiRead", p]), ""),
    wikiGrep: async (p) => (calls.push(["wikiGrep", p]), []),
    memoryScroll: async (p) => (calls.push(["memoryScroll", p]), {}),
    toolLog: async (p) => (calls.push(["toolLog", p]), []),
    health: async () => (calls.push(["health", undefined]), {}),
  };
  /** A request every route accepts once authenticated (each required parameter present). */
  const get = (path: string) => new Request(`http://x${path}?id=c&path=a.md&pattern=x&collection=m`);

  it("answers 401 on every read route without calling its getter", async () => {
    calls.length = 0;
    const routes = readRoutes(spyReads, refuse);
    expect(Object.keys(routes).length).toBe(10);
    for (const [path, route] of Object.entries(routes)) {
      const res = await route.GET(get(path));
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toBe("Bearer");
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
    }
    expect(calls).toEqual([]);
  });

  it("serves every read route to an authenticated caller, telling each per-person getter who is asking", async () => {
    calls.length = 0;
    for (const [path, route] of Object.entries(readRoutes(spyReads, asAlice))) {
      expect((await route.GET(get(path))).status).toBe(200);
    }
    expect(calls.sort(([a], [b]) => a.localeCompare(b))).toEqual([
      ["conversation", ALICE],
      ["conversations", ALICE],
      ["health", undefined],
      ["manifest", ALICE],
      ["memoryScroll", ALICE],
      ["pendingConfirmations", ALICE],
      ["toolLog", ALICE],
      ["wikiGrep", ALICE],
      ["wikiList", ALICE],
      ["wikiRead", ALICE],
    ]);
  });

  it("answers a preflight without asking who is calling", () => {
    const routes = readRoutes(spyReads, refuse);
    expect(routes["/manifest"]!.OPTIONS().status).toBe(204);
  });
});

// #150: an authenticated caller the core won't talk to (unknown to the
// directory on a closed instance, or the directory couldn't tell) gets the
// core's refusal on every route, and nothing behind it runs.
describe("admission", () => {
  it("refuses a turn with 403 for someone unknown, 503 when the directory can't tell, without running it", async () => {
    for (const [reason, status] of [["unknown", 403], ["unavailable", 503]] as const) {
      let ran = false;
      const res = await handleTurnRequest(turnReq({ text: "hi", conversationId: "c" }), {
        handleTurn: async () => {
          ran = true;
        },
        confirm: async () => null,
        authenticate: asAlice,
        admit: notAdmitted(reason),
      });
      expect(res.status).toBe(status);
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
      expect(await res.json()).toEqual({ ok: false, error: `refused (${reason})`, reason });
      expect(ran).toBe(false);
    }
  });

  it("refuses a confirmation without resolving it", async () => {
    let resolved = false;
    const res = await handleConfirmRequest(
      new Request("http://x/confirm", { method: "POST", body: JSON.stringify({ token: "k9m2-x7q4", conversationId: "c" }) }),
      {
        authenticate: asAlice,
        admit: notAdmitted("unknown"),
        resolveConfirmation: async () => ((resolved = true), { status: "ok", data: {} }),
      },
    );
    expect(res.status).toBe(403);
    expect(resolved).toBe(false);
  });

  it("refuses every read route without calling its getter", async () => {
    const calls: string[] = [];
    const spy = (name: string) => async () => (calls.push(name), {});
    const reads = {
      manifest: spy("manifest"),
      pendingConfirmations: spy("pendingConfirmations"),
      conversation: spy("conversation"),
      conversations: spy("conversations"),
      wikiList: spy("wikiList"),
      wikiRead: spy("wikiRead"),
      wikiGrep: spy("wikiGrep"),
      memoryScroll: spy("memoryScroll"),
      toolLog: spy("toolLog"),
      health: spy("health"),
    } as ChannelHostReads;
    for (const [path, route] of Object.entries(readRoutes(reads, asAlice, "*", notAdmitted("unknown")))) {
      const res = await route.GET(new Request(`http://x${path}?id=c&path=a.md&pattern=x&collection=m`));
      expect(res.status).toBe(403);
    }
    expect(calls).toEqual([]);
  });

  it("lets an admitted caller through", async () => {
    const res = await handleTurnRequest(turnReq({ text: "hi", conversationId: "c" }), {
      handleTurn: async (_t, sink) => {
        await sink.finalize("ok");
      },
      confirm: async () => null,
      authenticate: asAlice,
      admit: async () => ({ ok: true }),
    });
    expect(res.status).toBe(200);
  });
});

// #190: the custom UI shows the person a code to link another account with,
// no model in between.
describe("POST /link", () => {
  const linkReq = () => new Request("http://x/link", { method: "POST" });

  it("hands the caller a code, as the core gives it", async () => {
    const asked: Principal[] = [];
    const res = await handleLinkRequest(linkReq(), {
      authenticate: asAlice,
      start: async (p) => (asked.push(p), { ok: true, code: "a1b2-c3d4-e5f6", expiresAt: "2026-10-09T10:10:00.000Z" }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ ok: true, code: "a1b2-c3d4-e5f6", expiresAt: "2026-10-09T10:10:00.000Z" });
    expect(asked).toEqual([ALICE]);
  });

  it("answers 400 with the core's reason when there's no code for the caller", async () => {
    const res = await handleLinkRequest(linkReq(), { authenticate: asAlice, start: async () => ({ ok: false, error: "no" }) });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: "no" });
  });

  it("refuses an unauthenticated or unadmitted caller without asking for a code", async () => {
    let asked = 0;
    const start = async () => (asked++, { ok: true as const, code: "x", expiresAt: "y" });
    expect((await handleLinkRequest(linkReq(), { authenticate: refuse, start })).status).toBe(401);
    expect((await handleLinkRequest(linkReq(), { authenticate: asAlice, admit: notAdmitted("unknown"), start })).status).toBe(403);
    expect(asked).toBe(0);
  });
});

describe("GET /wiki/read and /memory/scroll", () => {
  const reads: ChannelHostReads = {
    manifest: async () => ({}),
    pendingConfirmations: async () => [],
    conversation: async () => ({}),
    conversations: async () => ({ conversations: [] }),
    wikiList: async () => [],
    wikiRead: async () => null,
    wikiGrep: async () => [],
    memoryScroll: async () => null,
    toolLog: async () => [],
    health: async () => ({}),
  };

  it("answers 404 for a wiki path the caller can't see, as if it didn't exist", async () => {
    const res = await readRoutes(reads, asAlice)["/wiki/read"]!.GET(new Request("http://x/wiki/read?path=../etc/passwd"));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ ok: false, error: "not found" });
  });

  it("answers 400 for a collection that isn't kept per person", async () => {
    const res = await readRoutes(reads, asAlice)["/memory/scroll"]!.GET(new Request("http://x/memory/scroll?collection=tool_corrections"));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: "unknown collection: tool_corrections" });
  });
});

// The routes as Bun.serve mounts them, on a real socket.
describe("startHttpServer", () => {
  it("serves /openapi.yaml to anyone and refuses everything else without a caller", async () => {
    const server = startHttpServer({
      port: 0,
      handleTurn: async () => {},
      confirm: async () => null,
      resolveConfirmation: async () => ({ status: "not-a-token" }),
      authenticate: refuse,
      reads: {
        manifest: async () => ({}),
        pendingConfirmations: async () => [],
        conversation: async () => ({}),
        conversations: async () => ({}),
        wikiList: async () => [],
        wikiRead: async () => "",
        wikiGrep: async () => [],
        memoryScroll: async () => ({}),
        toolLog: async () => [],
        health: async () => ({}),
      },
    });
    try {
      const base = `http://localhost:${server.port}`;
      expect((await fetch(`${base}/openapi.yaml`)).status).toBe(200);
      expect((await fetch(`${base}/health`)).status).toBe(401);
      expect((await fetch(`${base}/turn`, { method: "POST", body: JSON.stringify({ text: "hi" }) })).status).toBe(401);
      expect((await fetch(`${base}/confirm`, { method: "POST", body: "{}" })).status).toBe(401);
      expect((await fetch(`${base}/turn`, { method: "OPTIONS" })).status).toBe(204);
    } finally {
      server.stop(true);
    }
  });
});

// A UI reloading a conversation reads its durable transcript back here.
describe("GET /conversation", () => {
  const baseReads: ChannelHostReads = {
    manifest: async () => ({}),
    pendingConfirmations: async () => [],
    conversation: async () => ({ messages: [], nextOffset: null }),
    conversations: async () => ({ conversations: [] }),
    wikiList: async () => [],
    wikiRead: async () => "",
    wikiGrep: async () => [],
    memoryScroll: async () => ({ points: [] }),
    toolLog: async () => [],
    health: async () => ({}),
  };

  it("returns 400 when ?id is missing", async () => {
    const res = await readRoutes(baseReads, asAlice)["/conversation"]!.GET(new Request("http://x/conversation"));
    expect(res.status).toBe(400);
  });

  it("opens the caller's own conversation: the getter gets the caller, their session key, limit and offset", async () => {
    let seen: unknown[] | undefined;
    const reads: ChannelHostReads = {
      ...baseReads,
      conversation: async (principal, sessionKey, limit, offset) => {
        seen = [principal, sessionKey, limit, offset];
        return {
          messages: [{ role: "user", content: "hi", timestamp: "2026-09-24T10:00:00.000Z" }],
          nextOffset: null,
        };
      },
    };
    const res = await readRoutes(reads, asAlice)["/conversation"]!.GET(
      new Request("http://x/conversation?id=conv-1&limit=10&offset=cur"),
    );
    const payload = (await res.json()) as { ok: boolean; messages: unknown[]; nextOffset: unknown };
    expect(seen).toEqual([ALICE, "alice:conv-1", 10, "cur"]);
    expect(payload.ok).toBe(true);
    expect(payload.messages).toHaveLength(1);
    expect(payload.nextOffset).toBeNull();
  });

  // Regression: ?id used to be any session key /conversations listed, every
  // channel's and every person's, so one caller could read another's
  // conversation. It's now a conversationId, the same as /turn takes, and
  // the session key is built from the caller.
  it("refuses an id that isn't a conversationId, without calling the getter", async () => {
    let called = false;
    const reads: ChannelHostReads = {
      ...baseReads,
      conversation: async () => {
        called = true;
        return {};
      },
    };
    for (const id of ["spaces/X:users/42", "bob:c", "terminal:x", "../c", "c d"]) {
      const res = await readRoutes(reads, asAlice)["/conversation"]!.GET(
        new Request(`http://x/conversation?id=${encodeURIComponent(id)}`),
      );
      expect(res.status).toBe(400);
    }
    expect(called).toBe(false);
  });

  it("GET /conversations lists the caller's conversations by conversationId, forwarding the limit", async () => {
    let seen: unknown[] | undefined;
    const reads: ChannelHostReads = {
      ...baseReads,
      conversations: async (principal, limit) => {
        seen = [principal, limit];
        return {
          conversations: [
            { sessionKey: "alice:conv-2", lastTimestamp: "t2", preview: "later" },
            { sessionKey: "alice:conv-1", lastTimestamp: "t1", preview: "hi" },
            // Not the caller's HTTP session key: never listed, whatever the core returned.
            { sessionKey: "spaces/X:users/42", lastTimestamp: "t0", preview: "chat" },
          ],
        };
      },
    };
    const res = await readRoutes(reads, asAlice)["/conversations"]!.GET(new Request("http://x/conversations?limit=5"));
    expect(seen).toEqual([ALICE, 5]);
    expect(await res.json()).toEqual({
      ok: true,
      conversations: [
        { conversationId: "conv-2", lastTimestamp: "t2", preview: "later" },
        { conversationId: "conv-1", lastTimestamp: "t1", preview: "hi" },
      ],
    });
  });
});
