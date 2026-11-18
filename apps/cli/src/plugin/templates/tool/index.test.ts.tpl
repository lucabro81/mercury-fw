/**
 * The __TITLE__ plugin as the core builds it: no tools without its setting,
 * its two tools with it, a status line for each, and its skill and texts
 * under its name.
 */
import { describe, expect, test } from "bun:test";
import type { PluginRuntimeContext, SessionToolContext } from "@mercury-fw/kit";
import { __EXPORT__ } from "./index.ts";
import type { Client } from "./tools.ts";

const client: Client = { list: async () => [], remove: async () => {} };

/** The context the core builds a plugin with: this one reads only `env` and `log`. */
function ctx(env: Record<string, string> = {}, logs: string[] = []): PluginRuntimeContext {
  return { model: {} as never, env, log: (line) => logs.push(line) };
}

describe("__NAME__", () => {
  test("without __CONSTANT___URL it contributes no tool, and logs why", async () => {
    const logs: string[] = [];
    expect(await __EXPORT__().build!(ctx({}, logs))).toEqual({});
    expect(logs).toEqual(["__NAME__: __CONSTANT___URL is not set: no tools"]);
  });

  test("with __CONSTANT___URL it contributes its two tools", async () => {
    const built = await __EXPORT__().build!(ctx({ __CONSTANT___URL: "https://example.test" }));
    const tools = built.sessionTools!({ stageConfirmation: async () => "token" } as unknown as SessionToolContext);
    expect(Object.keys(tools)).toEqual(["__SNAKE___list", "__SNAKE___delete"]);
  });

  test("each tool's status line is one of its texts", async () => {
    const plugin = __EXPORT__({ client });
    const built = await plugin.build!(ctx());
    const t = (key: string) => plugin.messages?.[key] ?? `missing ${key}`;
    expect(built.toolStatusDescribers?.__SNAKE___list?.({}, t)).toBe("Looking up the items");
    expect(built.toolStatusDescribers?.__SNAKE___delete?.({ id: "1" }, t)).toBe("Deleting an item");
  });

  test("its skill and its texts carry its name", () => {
    const plugin = __EXPORT__();
    expect(plugin.skills?.map((s) => s.name)).toEqual(["__NAME__"]);
    expect(Object.keys(plugin.messages ?? {}).every((key) => key.startsWith("__NAME__."))).toBe(true);
  });
});
