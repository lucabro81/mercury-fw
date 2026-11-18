/**
 * The __TITLE__ tools: listing answers with the items or the error; deleting
 * stages the deletion and runs it only when the core runs the staged action;
 * the HTTP client calls the service's routes and rejects on a failed status.
 */
import { describe, expect, test } from "bun:test";
import type { ActionResult, ExecutableTool } from "@mercury-fw/kit";
import { createTools, httpClient, type Client, type Item } from "./tools.ts";

/** A client over `items`, recording what it deleted; `fail` makes every call reject. */
function fakeClient(items: Item[], fail = false) {
  const deleted: string[] = [];
  const client: Client = {
    list: async () => {
      if (fail) throw new Error("service down");
      return items;
    },
    remove: async (id) => {
      if (fail) throw new Error("service down");
      deleted.push(id);
    },
  };
  return { client, deleted };
}

/** Stages like the core: keeps the action and hands back a token. */
function stager() {
  const staged: Array<{ describe: string; run: () => Promise<ActionResult> }> = [];
  return {
    staged,
    stageConfirmation: async (action: { describe: string; run: () => Promise<ActionResult> }) => {
      staged.push(action);
      return "tok-1";
    },
  };
}

/** Calls `tool` with `input`, as the model would. */
const call = (tool: ExecutableTool | undefined, input: unknown) => tool!.execute(input, {} as never);

describe("__SNAKE___list", () => {
  test("answers with the items", async () => {
    const tools = createTools(fakeClient([{ id: "1", title: "Printer" }]).client, stager());
    expect(await call(tools.__SNAKE___list, {})).toEqual({ ok: true, items: [{ id: "1", title: "Printer" }] });
  });

  test("answers with the error when the service fails", async () => {
    const tools = createTools(fakeClient([], true).client, stager());
    expect(await call(tools.__SNAKE___list, {})).toEqual({ ok: false, error: "service down" });
  });
});

describe("__SNAKE___delete", () => {
  test("stages the deletion and deletes nothing yet", async () => {
    const { client, deleted } = fakeClient([]);
    const stage = stager();
    const result = await call(createTools(client, stage).__SNAKE___delete, { id: "1" });
    expect(result).toMatchObject({ ok: false, pendingConfirmation: true, token: "tok-1", summary: "Delete item 1" });
    expect(stage.staged.map((s) => s.describe)).toEqual(["delete __NAME__ item 1"]);
    expect(deleted).toEqual([]);
  });

  test("deletes once the staged action runs", async () => {
    const { client, deleted } = fakeClient([]);
    const stage = stager();
    await call(createTools(client, stage).__SNAKE___delete, { id: "1" });
    expect(await stage.staged[0]!.run()).toEqual({ ok: true, data: { deleted: "1" } });
    expect(deleted).toEqual(["1"]);
  });

  test("the staged action says why it failed", async () => {
    const stage = stager();
    await call(createTools(fakeClient([], true).client, stage).__SNAKE___delete, { id: "1" });
    expect(await stage.staged[0]!.run()).toEqual({ ok: false, error: "service down" });
  });
});

describe("httpClient", () => {
  /** A fetch answering `status` with `body`, recording what it was asked. */
  function fakeFetch(status: number, body: unknown = []) {
    const asked: string[] = [];
    const fetchFn = (async (url: string, init?: RequestInit) => {
      asked.push(`${init?.method} ${url}`);
      return new Response(JSON.stringify(body), { status });
    }) as unknown as typeof fetch;
    return { asked, fetchFn };
  }

  test("lists with GET /items", async () => {
    const { asked, fetchFn } = fakeFetch(200, [{ id: "1", title: "Printer" }]);
    expect(await httpClient("https://example.test/", fetchFn).list()).toEqual([{ id: "1", title: "Printer" }]);
    expect(asked).toEqual(["GET https://example.test/items"]);
  });

  test("deletes with DELETE /items/<id>, the id encoded", async () => {
    const { asked, fetchFn } = fakeFetch(204, null);
    await httpClient("https://example.test", fetchFn).remove("a/b");
    expect(asked).toEqual(["DELETE https://example.test/items/a%2Fb"]);
  });

  test("rejects on a failed status", async () => {
    const { fetchFn } = fakeFetch(500);
    expect(httpClient("https://example.test", fetchFn).list()).rejects.toThrow("GET /items: HTTP 500");
  });
});
