/**
 * The HTTP session `mfw e2e` drives for a case on the HTTP surface: one
 * conversation (a `conversationId` of its own), each turn a `POST /turn` with
 * the user's token, read off the event stream into the calls and the answer
 * a check looks at. The app's service must be running (`mfw start`); the
 * surface's URL comes from `commands.ts`.
 *
 * The stream carries no tool results, so a call has its tool's name, the
 * detail line the surface shows as input, and an output only when it was
 * staged for confirmation (the `pending` event's token), shaped like the one
 * a REPL dump has, so a confirmation turn reads the token the same way.
 */
import type { Call, TurnData, TurnOutputData, TurnOutputErrorData } from "./dump.ts";
import type { HttpReply, Session } from "./runner.ts";

export type HttpSessionOptions = {
  /** The surface's base URL, e.g. `http://localhost:4100`. */
  baseUrl: string;
  /** How long one turn may take. */
  timeoutMs: number;
};

/** Every `event:`/`data:` pair in an SSE body, in order. */
function events(body: string): Array<{ name: string; data: Record<string, unknown> }> {
  return body
    .split("\n\n")
    .map((block) => {
      const name = /^event: (.*)$/m.exec(block)?.[1];
      const data = /^data: (.*)$/m.exec(block)?.[1];
      return name === undefined || data === undefined ? undefined : { name, data: JSON.parse(data) as Record<string, unknown> };
    })
    .filter((e) => e !== undefined);
}

/** The calls and the answer in the body of a `/turn` stream, with the
 * `final` event's output when it has one; a `TurnOutputError` (an `error`
 * event with an `output-*` code) is the turn's `outputError`. Throws on any
 * other `error` event, or when the stream has no `final` one. */
export function turnFromSse(body: string): TurnData {
  const calls: Array<Call & { id: unknown }> = [];
  // A pending event's output, waiting for its call's tool_finish when it came first.
  const unclaimed: unknown[] = [];
  let answer: string | undefined;
  let output: TurnOutputData | undefined;
  for (const { name, data } of events(body)) {
    if (name === "tool" && typeof data.name === "string") {
      // A tool event with no name is Mercury saving to memory, not a call.
      calls.push({ id: data.toolCallId, tool: data.name, input: data.detail, output: undefined, ok: false, pending: false });
    } else if (name === "tool_finish") {
      const call = calls.find((c) => c.id === data.toolCallId);
      if (call === undefined) continue;
      call.pending = data.outcome === "pending";
      call.ok = data.outcome === "success" || call.pending;
      if (call.pending && unclaimed.length > 0) call.output = unclaimed.shift();
    } else if (name === "pending") {
      const output = { pendingConfirmation: true, token: data.token, summary: data.command };
      const call = calls.findLast((c) => c.pending && c.output === undefined);
      if (call !== undefined) call.output = output;
      else unclaimed.push(output);
    } else if (name === "final") {
      answer = String(data.text ?? "");
      const out = data.output as { mode?: unknown; value?: unknown } | undefined;
      if (typeof out?.mode === "string") output = { mode: out.mode, value: out.value };
    } else if (name === "error") {
      // A turn whose output never came is a result a case checks, not a broken run.
      if (typeof data.code === "string" && data.code.startsWith("output-")) {
        const outputError: TurnOutputErrorData = { code: data.code, attempts: Number(data.attempts ?? 0) };
        if (typeof data.lastError === "string") outputError.lastError = data.lastError;
        return { calls: calls.map(({ id: _, ...call }) => call), answer: "", outputError };
      }
      throw new Error(`the turn failed in the app: ${String(data.message)}`);
    }
  }
  if (answer === undefined) throw new Error("the stream ended without a final event");
  return { calls: calls.map(({ id: _, ...call }) => call), answer, ...(output === undefined ? {} : { output }) };
}

/** Opens a session on the surface at `opts.baseUrl`: nothing is sent until the first turn. */
export async function openHttpSession(opts: HttpSessionOptions): Promise<Session<HttpReply>> {
  const conversationId = `e2e-${crypto.randomUUID()}`;
  const url = `${opts.baseUrl.replace(/\/+$/, "")}/turn`;
  return {
    turn: async (text, token) => {
      const signal = AbortSignal.timeout(opts.timeoutMs);
      let res: Response;
      let body: string;
      try {
        res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json", ...(token !== undefined ? { authorization: `Bearer ${token}` } : {}) },
          body: JSON.stringify({ text, conversationId }),
          signal,
        });
        body = await res.text();
      } catch (err) {
        if (signal.aborted) throw new Error(`no reply within ${opts.timeoutMs / 1000} s`);
        throw new Error(`can't reach the HTTP surface at ${opts.baseUrl}: is the app running (mfw start)? (${err instanceof Error ? err.message : String(err)})`);
      }
      if (res.status !== 200) {
        let error = body;
        try {
          error = String((JSON.parse(body) as { error?: unknown }).error ?? body);
        } catch {
          /* not JSON: the body as it is */
        }
        return { turn: { calls: [], answer: error }, status: res.status };
      }
      return { turn: turnFromSse(body), status: res.status };
    },
    close: async () => {},
  };
}

/** The surface's URL on this host, from `docker compose ps --format json`
 * (one object per line, or an array on older compose; any line that isn't
 * JSON, like a warning on stderr, skipped): the first TCP port `service`
 * publishes, on localhost. Undefined when it isn't running or publishes nothing. */
export function surfaceUrlFromPs(output: string, service: string): string | undefined {
  type Row = { Service?: unknown; Publishers?: Array<{ PublishedPort?: unknown; Protocol?: unknown }> };
  const rows = output.split("\n").flatMap((line): Row[] => {
    try {
      const parsed = JSON.parse(line) as Row | Row[];
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      return [];
    }
  });
  const port = rows
    .filter((r) => r.Service === service)
    .flatMap((r) => r.Publishers ?? [])
    .find((p) => typeof p.PublishedPort === "number" && p.PublishedPort > 0 && (p.Protocol ?? "tcp") === "tcp")?.PublishedPort;
  return port === undefined ? undefined : `http://localhost:${port}`;
}
