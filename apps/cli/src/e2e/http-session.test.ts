/**
 * The HTTP session `mfw e2e` drives for a case on the HTTP surface: reading a
 * turn off the `/turn` event stream, and the requests it sends, against a fake
 * surface on a real socket.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { openHttpSession, surfaceUrlFromPs, turnFromSse } from "./http-session.ts";

/** One SSE event as the surface writes it. */
const event = (name: string, data: unknown) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;

describe("turnFromSse", () => {
  test("a call per tool the model ran, by its name, settled by tool_finish; the answer from final", () => {
    const body = [
      event("reasoning", { chunk: "hm", id: "r" }),
      event("tool", { label: "Sto leggendo Jira…", detail: "jira issue list", toolCallId: "1", name: "jiraCommand" }),
      event("tool_finish", { toolCallId: "1", outcome: "success" }),
      event("tool", { label: "Sto leggendo il wiki…", detail: "notes.md", toolCallId: "2", name: "read_file" }),
      event("tool_finish", { toolCallId: "2", outcome: "failed" }),
      event("text", { chunk: "Two " }),
      event("text", { chunk: "issues." }),
      event("final", { text: "Two issues." }),
    ].join("");
    expect(turnFromSse(body)).toEqual({
      calls: [
        { tool: "jiraCommand", input: "jira issue list", output: undefined, ok: true, pending: false },
        { tool: "read_file", input: "notes.md", output: undefined, ok: false, pending: false },
      ],
      answer: "Two issues.",
    });
  });

  test("a call staged for confirmation carries the token from the pending event, as a REPL dump would", () => {
    const body = [
      event("tool", { label: "x", detail: "jira issue delete SUP-1", toolCallId: "1", name: "jiraCommand" }),
      event("tool_finish", { toolCallId: "1", outcome: "pending" }),
      event("pending", { command: "jira issue delete SUP-1", token: "AB12-CD34" }),
      event("final", { text: "" }),
    ].join("");
    expect(turnFromSse(body).calls).toEqual([
      {
        tool: "jiraCommand",
        input: "jira issue delete SUP-1",
        output: { pendingConfirmation: true, token: "AB12-CD34", summary: "jira issue delete SUP-1" },
        ok: true,
        pending: true,
      },
    ]);
  });

  test("leaves out Mercury's own memory notes, which have no tool name, and a call that never settled is not ok", () => {
    const body = [
      event("tool", { label: "Mi sto segnando…", detail: "…", toolCallId: "c1" }),
      event("tool_finish", { toolCallId: "c1", outcome: "success" }),
      event("tool", { label: "x", detail: "y", toolCallId: "2", name: "grep" }),
      event("final", { text: "ok" }),
    ].join("");
    expect(turnFromSse(body).calls).toEqual([{ tool: "grep", input: "y", output: undefined, ok: false, pending: false }]);
  });

  test("a confirmation reply, with no model turn, is its final text", () => {
    expect(turnFromSse(event("final", { text: "Confermato ed eseguito: {}" }))).toEqual({ calls: [], answer: "Confermato ed eseguito: {}" });
  });

  test("an error event fails the turn with its message", () => {
    expect(() => turnFromSse(event("error", { message: "model exploded" }))).toThrow("the turn failed in the app: model exploded");
  });

  test("a stream that ends without a final event fails the turn", () => {
    expect(() => turnFromSse(event("text", { chunk: "half" }))).toThrow("the stream ended without a final event");
  });
});

describe("openHttpSession", () => {
  let server: ReturnType<typeof Bun.serve> | undefined;
  afterEach(() => server?.stop(true));

  /** A fake surface: records each request's auth header and body, answers with `respond`. */
  function surface(respond: (body: { text: string; conversationId: string }) => Response) {
    const seen: Array<{ authorization: string | null; body: { text: string; conversationId: string } }> = [];
    server = Bun.serve({
      port: 0,
      routes: {
        "/turn": {
          POST: async (req) => {
            const body = (await req.json()) as { text: string; conversationId: string };
            seen.push({ authorization: req.headers.get("authorization"), body });
            return respond(body);
          },
        },
      },
    });
    return { seen, url: `http://localhost:${server.port}` };
  }

  const sse = (text: string) => new Response(event("final", { text }), { headers: { "content-type": "text/event-stream" } });

  test("posts each turn with its token, in one conversation per session, and reads the stream", async () => {
    const s = surface((b) => sse(`echo ${b.text}`));
    const one = await openHttpSession({ baseUrl: s.url, timeoutMs: 5000 });
    expect(await one.turn("hi", "alice-token")).toEqual({ turn: { calls: [], answer: "echo hi" }, status: 200 });
    await one.turn("again", "bob-token");
    const two = await openHttpSession({ baseUrl: s.url, timeoutMs: 5000 });
    await two.turn("other", "alice-token");

    expect(s.seen.map((r) => [r.authorization, r.body.text])).toEqual([
      ["Bearer alice-token", "hi"],
      ["Bearer bob-token", "again"],
      ["Bearer alice-token", "other"],
    ]);
    const [a, b, c] = s.seen.map((r) => r.body.conversationId);
    expect(a).toMatch(/^e2e-[A-Za-z0-9_-]+$/);
    expect(b).toBe(a);
    expect(c).not.toBe(a);
  });

  test("a refused request is a turn with its status and the surface's error as the answer", async () => {
    const s = surface(() => Response.json({ ok: false, error: "unauthorized" }, { status: 401 }));
    const session = await openHttpSession({ baseUrl: s.url, timeoutMs: 5000 });
    expect(await session.turn("hi", "wrong")).toEqual({ turn: { calls: [], answer: "unauthorized" }, status: 401 });
  });

  test("a surface that doesn't answer in time fails the turn", async () => {
    const s = surface(() => new Response(new ReadableStream({ start() {} }), { headers: { "content-type": "text/event-stream" } }));
    const session = await openHttpSession({ baseUrl: s.url, timeoutMs: 100 });
    await expect(session.turn("hi", "t")).rejects.toThrow("no reply within 0.1 s");
  });

  test("a surface nobody listens on fails the turn, saying the app must be running", async () => {
    const s = surface(() => sse("x"));
    server?.stop(true);
    server = undefined;
    const session = await openHttpSession({ baseUrl: s.url, timeoutMs: 5000 });
    await expect(session.turn("hi", "t")).rejects.toThrow(`can't reach the HTTP surface at ${s.url}: is the app running (mfw start)?`);
  });
});

describe("surfaceUrlFromPs", () => {
  const mercury = {
    Service: "mercury",
    Publishers: [
      { URL: "0.0.0.0", TargetPort: 4200, PublishedPort: 4200, Protocol: "tcp" },
      { URL: "::", TargetPort: 4200, PublishedPort: 4200, Protocol: "tcp" },
    ],
  };
  const qdrant = { Service: "qdrant", Publishers: [{ URL: "", TargetPort: 6333, PublishedPort: 0, Protocol: "tcp" }] };

  test("the port the service publishes, on localhost, from compose's one-object-per-line output", () => {
    expect(surfaceUrlFromPs(`${JSON.stringify(qdrant)}\n${JSON.stringify(mercury)}\n`, "mercury")).toBe("http://localhost:4200");
  });

  test("skips what isn't JSON, like a warning compose prints on stderr", () => {
    const output = `time="x" level=warning msg="The \\"FOO\\" variable is not set."\n${JSON.stringify(mercury)}\n`;
    expect(surfaceUrlFromPs(output, "mercury")).toBe("http://localhost:4200");
  });

  test("the same from the array older compose versions print", () => {
    expect(surfaceUrlFromPs(JSON.stringify([qdrant, mercury]), "mercury")).toBe("http://localhost:4200");
  });

  test("nothing when the service isn't running or publishes no port", () => {
    expect(surfaceUrlFromPs("", "mercury")).toBeUndefined();
    expect(surfaceUrlFromPs(JSON.stringify(qdrant), "mercury")).toBeUndefined();
    expect(surfaceUrlFromPs(JSON.stringify({ Service: "mercury", Publishers: [{ TargetPort: 4100, PublishedPort: 0 }] }), "mercury")).toBeUndefined();
  });
});
