/**
 * The __TITLE__ plugin as the core builds it: one tool running the program
 * through its allowlist, which stages a confirmed command instead of running
 * it, and a status line naming the command.
 */
import { describe, expect, test } from "bun:test";
import type { CliResult } from "@mercury-fw/cli-engine";
import type { PluginRuntimeContext, SessionToolContext } from "@mercury-fw/kit";
import { __EXPORT__ } from "./index.ts";

/** The context the core builds a plugin with: this one reads only `log`. */
const ctx: PluginRuntimeContext = { model: {} as never, env: {}, log: () => {} };

/** A session whose confirmations are kept in `staged`. */
function session(staged: string[]): SessionToolContext {
  return {
    sessionKey: "s",
    t: (key) => key,
    stageConfirmation: async (action) => {
      staged.push(action.describe);
      return "tok-1";
    },
    stashDisplay: () => "d1",
    person: null,
    requireLogin: async () => ({ ok: false as const, error: "no login" }),
  };
}

describe("__NAME__", () => {
  test("acts as the instance, and logs nobody in", async () => {
    const plugin = __EXPORT__();
    expect(plugin.actsAs).toBe("mercury");
    expect((await plugin.build!(ctx)).login).toBeUndefined();
  });

  test("runs an allowed command with the program", async () => {
    const ran: string[][] = [];
    const runCliFn = async (binary: string, args: string[]): Promise<CliResult> => {
      ran.push([binary, ...args]);
      return { ok: true, data: [] };
    };
    const built = await __EXPORT__({ runCliFn }).build!(ctx);
    const tools = built.sessionTools!(session([]));
    await tools.__CAMEL__Command!.execute!({ command: "__BINARY__ items list" }, {} as never);
    expect(ran).toEqual([["__BINARY__", "items", "list"]]);
  });

  test("stages a confirmed command instead of running it", async () => {
    const ran: string[][] = [];
    const staged: string[] = [];
    const runCliFn = async (binary: string, args: string[]): Promise<CliResult> => {
      ran.push([binary, ...args]);
      return { ok: true, data: null };
    };
    const built = await __EXPORT__({ runCliFn }).build!(ctx);
    const result = await built.sessionTools!(session(staged)).__CAMEL__Command!.execute!({ command: "__BINARY__ items delete 1" }, {} as never);
    expect(result).toMatchObject({ ok: false, pendingConfirmation: true, token: "tok-1" });
    expect(staged).toHaveLength(1);
    expect(ran).toEqual([]);
  });

  test("names the command in its status line", async () => {
    const built = await __EXPORT__().build!(ctx);
    const t = (key: string, params?: Record<string, unknown>) => `${key} ${JSON.stringify(params ?? {})}`;
    expect(built.toolStatusDescribers?.__CAMEL__Command?.({ command: "__BINARY__ items list" }, t)).toContain("__BINARY__");
    expect(built.toolStatusDescribers?.__CAMEL__Command?.({}, t)).toBe("core.status.command-unknown {}");
  });
});
