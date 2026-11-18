/**
 * The __TITLE__ tools and the client they call. `__SNAKE___list` only reads,
 * so it runs at once; `__SNAKE___delete` can't be undone, so it stages the
 * deletion behind a confirmation the person gives on their channel, and the
 * core runs it only then. A tool fails by returning `ok: false` with an
 * `error` the model reads, never by throwing.
 */
import type { ExecutableTool, SessionToolContext } from "@mercury-fw/kit";
import { tool } from "ai";
import { z } from "zod";

/** One item of the service. */
export type Item = { id: string; title: string };

/** What the tools need of the service. */
export type Client = {
  list: () => Promise<Item[]>;
  remove: (id: string) => Promise<void>;
};

/** A client over the service's HTTP API at `baseUrl`: `GET /items`, `DELETE /items/<id>`. Rejects on a status that isn't a success. */
export function httpClient(baseUrl: string, fetchFn: typeof fetch = fetch): Client {
  const root = baseUrl.replace(/\/+$/, "");
  const call = async (path: string, method: "GET" | "DELETE"): Promise<Response> => {
    const res = await fetchFn(`${root}${path}`, { method });
    if (!res.ok) throw new Error(`${method} ${path}: HTTP ${res.status}`);
    return res;
  };
  return {
    list: async () => (await (await call("/items", "GET")).json()) as Item[],
    remove: async (id) => {
      await call(`/items/${encodeURIComponent(id)}`, "DELETE");
    },
  };
}

/** What `err` says. */
function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The tools of one session: `ctx` stages a confirmation for the session's person. */
export function createTools(client: Client, ctx: Pick<SessionToolContext, "stageConfirmation">): Record<string, ExecutableTool> {
  const __SNAKE___list = tool({
    description: "Lists the items of __TITLE__, each with its id and title.",
    inputSchema: z.object({}),
    execute: async () => {
      try {
        return { ok: true, items: await client.list() };
      } catch (err) {
        return { ok: false, error: messageOf(err) };
      }
    },
  }) as ExecutableTool;

  const __SNAKE___delete = tool({
    description: "Deletes an item of __TITLE__ by its id. It can't be undone, so the person confirms it first.",
    inputSchema: z.object({ id: z.string().min(1).describe("The item's id, as __SNAKE___list gives it") }),
    execute: async ({ id }) => {
      const token = await ctx.stageConfirmation({
        describe: `delete __NAME__ item ${id}`,
        run: async () => {
          try {
            await client.remove(id);
            return { ok: true, data: { deleted: id } };
          } catch (err) {
            return { ok: false, error: messageOf(err) };
          }
        },
      });
      // `pendingConfirmation` and `token` are what the core and the channel
      // read to ask the person; the model reads only `error`.
      return {
        ok: false,
        pendingConfirmation: true,
        token,
        summary: `Delete item ${id}`,
        error: "Deleting is irreversible and waits for the person's confirmation. Tell them it's staged; never mention the token, their channel handles it.",
      };
    },
  }) as ExecutableTool;

  return { __SNAKE___list, __SNAKE___delete };
}
