/**
 * The __TITLE__ channel's requests: refused without credentials, refused when
 * the agent doesn't talk to the person, a confirmation token handled without
 * the model, a turn's answer and its staged action, and no start without an
 * auth provider.
 */
import { describe, expect, test } from "bun:test";
import type { ChannelRuntimeContext, HandleTurn, InboundTurn, Principal, StepInfo } from "@mercury-fw/kit";
import { __EXPORT__, handleMessage, type __PASCAL__Deps } from "./index.ts";
import { __CONSTANT___MESSAGES } from "./messages.ts";

const ada: Principal = { id: "ada", provider: "static" };

/** The core as the channel sees it: `ada` with a token, admitted, no confirmation pending unless `confirm` says. */
function deps(overrides: Partial<__PASCAL__Deps> = {}): __PASCAL__Deps {
  return {
    authenticate: async (req) => (req.headers.get("authorization") === "Bearer ada" ? ada : null),
    admit: async () => ({ ok: true }),
    confirm: async () => null,
    i18n: { forRequest: async () => ({ locale: "en", t: (key) => __CONSTANT___MESSAGES[key] ?? key }) },
    ...overrides,
  };
}

/** A request saying `body`, with `ada`'s token unless `token` is null. */
function message(body: unknown, token: string | null = "ada"): Request {
  return new Request("http://localhost/message", {
    method: "POST",
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

/** A turn answering `answer`, keeping what it was asked in `turns`; `step` is what its model did. */
function turn(turns: InboundTurn[], answer = "Hello!", step?: StepInfo): HandleTurn {
  return async (inbound, sink) => {
    turns.push(inbound);
    if (step) sink.onStep?.(step);
    await sink.finalize(answer);
  };
}

describe("handleMessage", () => {
  test("answers with the turn's answer, in the person's session", async () => {
    const turns: InboundTurn[] = [];
    const res = await handleMessage(message({ text: "hi", conversation: "c1" }), deps(), turn(turns));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: "Hello!" });
    expect(turns).toEqual([{ channel: "__NAME__", multiUser: false, text: "hi", sessionKey: "__NAME__:ada:c1", principal: ada, logPrefix: "[__NAME__:c1] " }]);
  });

  test("refuses someone who sent no credentials", async () => {
    const res = await handleMessage(message({ text: "hi" }, null), deps(), turn([]));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Who are you? Send your credentials with the message." });
  });

  test("refuses someone the agent doesn't talk to, saying why", async () => {
    const res = await handleMessage(message({ text: "hi" }), deps({ admit: async () => ({ ok: false, reason: "unknown", message: "Ask an admin." }) }), turn([]));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Ask an admin." });
  });

  test("refuses a message without text", async () => {
    const res = await handleMessage(message({ text: " " }), deps(), turn([]));
    expect(res.status).toBe(400);
  });

  test("runs a confirmation token without the model", async () => {
    const turns: InboundTurn[] = [];
    const res = await handleMessage(message({ text: "AB12-CD34" }), deps({ confirm: async () => ({ text: "Done: item 1 deleted." }) }), turn(turns));
    expect(await res.json()).toEqual({ text: "Done: item 1 deleted." });
    expect(turns).toEqual([]);
  });

  test("runs the turn again when a confirmed action goes back to the model", async () => {
    const turns: InboundTurn[] = [];
    await handleMessage(message({ text: "AB12-CD34" }), deps({ confirm: async () => ({ text: "", resume: true }) }), turn(turns));
    expect(turns.map((t) => [t.text, t.resumeAfterConfirm])).toEqual([["", true]]);
  });

  test("hands back the token of an action the turn staged", async () => {
    const step: StepInfo = {
      toolCalls: [{ toolCallId: "1", toolName: "x_delete", input: {} }],
      toolResults: [{ toolCallId: "1", toolName: "x_delete", output: { ok: false, pendingConfirmation: true, token: "AB12-CD34", summary: "Delete item 1" } }],
      content: [],
    };
    const res = await handleMessage(message({ text: "delete item 1" }), deps(), turn([], "It's staged.", step));
    expect(await res.json()).toEqual({ text: "It's staged.", confirm: { summary: "Delete item 1", token: "AB12-CD34" } });
  });

  test("says the message failed when the turn does", async () => {
    const failing: HandleTurn = async () => {
      throw new Error("model down");
    };
    const res = await handleMessage(message({ text: "hi" }), deps(), failing);
    expect(res.status).toBe(500);
  });
});

describe("__EXPORT__", () => {
  test("doesn't start without an auth provider", () => {
    const ctx = { env: {}, log: () => {} } as unknown as ChannelRuntimeContext;
    expect(() => __EXPORT__().build(ctx)).toThrow("__NAME__ needs an auth provider (auth in mercury.config.ts)");
  });

  test("keeps its texts under its name", () => {
    expect(Object.keys(__EXPORT__().messages ?? {}).every((key) => key.startsWith("__NAME__."))).toBe(true);
  });
});
