import { describe, expect, test } from "bun:test";
import { z } from "zod";
import type { ChannelPlugin } from "@mercury-fw/channel-types";
import type { Plugin } from "@mercury-fw/plugin-types";
import { acceptOutput, resolveOutput, toolOf } from "./turn-output.ts";

const plugin = (name: string): Plugin => ({ apiVersion: 7, name, description: "d", build: () => ({}) }) as Plugin;
const channel = (name: string, outputs?: ChannelPlugin["outputs"]): ChannelPlugin => ({
  apiVersion: 7,
  name,
  build: () => undefined,
  ...(outputs ? { outputs } : {}),
});

describe("toolOf", () => {
  test("names one of a plugin's tools by the plugin object", () => {
    const query = plugin("comperio-query");
    expect(toolOf(query, "comperio_query_build")).toEqual({ plugin: query, name: "comperio_query_build" });
  });
});

describe("resolveOutput", () => {
  const query = plugin("comperio-query");
  const http = channel("http", ["tool", "schema"]);

  test("no output, or text, is the default: nothing to resolve", () => {
    expect(resolveOutput(undefined, { plugins: [query], channels: [http] })).toBeUndefined();
    expect(resolveOutput("text", { plugins: [query], channels: [channel("google-chat")] })).toBeUndefined();
  });

  test("a tool output names its plugin and tool, with two retries by default", () => {
    expect(resolveOutput({ tool: toolOf(query, "comperio_query_build") }, { plugins: [query], channels: [http] })).toEqual({
      mode: "tool",
      plugin: "comperio-query",
      tool: "comperio_query_build",
      retries: 2,
    });
  });

  test("a schema output keeps its schema, validator and retries", () => {
    const schema = z.object({ query: z.string() });
    const validate = () => ({ ok: true as const });
    expect(resolveOutput({ schema, validate, retries: 0 }, { plugins: [], channels: [http] })).toEqual({
      mode: "schema",
      schema,
      validate,
      retries: 0,
    });
  });

  test("a tool whose plugin isn't declared stops the instance", () => {
    expect(() => resolveOutput({ tool: toolOf(plugin("other"), "x") }, { plugins: [query], channels: [http] })).toThrow(
      'output: the tool "x" belongs to the plugin "other", which isn\'t in plugins',
    );
  });

  test("retries must be a whole number from 0 up", () => {
    for (const retries of [-1, 1.5, Number.NaN]) {
      expect(() => resolveOutput({ schema: z.string(), retries }, { plugins: [], channels: [http] })).toThrow(
        `output: retries must be a whole number from 0 up, not ${retries}`,
      );
    }
  });

  test("a channel that doesn't handle the output stops the instance, named", () => {
    expect(() =>
      resolveOutput({ tool: toolOf(query, "comperio_query_build") }, { plugins: [query], channels: [http, channel("google-chat")] }),
    ).toThrow('channel "google-chat" doesn\'t handle the "tool" output');
  });

  test("with no channels, only the terminal: any output", () => {
    expect(resolveOutput({ schema: z.string() }, { plugins: [], channels: [] })?.mode).toBe("schema");
  });
});

describe("acceptOutput", () => {
  test("a value is accepted when there's no validator", async () => {
    expect(await acceptOutput({ query: "a" }, undefined)).toEqual({ ok: true });
  });

  test("the validator's verdict, sync or async", async () => {
    expect(await acceptOutput(1, () => ({ ok: false, error: "too small" }))).toEqual({ ok: false, error: "too small" });
    expect(await acceptOutput(1, async () => ({ ok: true }))).toEqual({ ok: true });
  });

  test("a validator that throws refuses the value with its message", async () => {
    expect(
      await acceptOutput(1, () => {
        throw new Error("boom");
      }),
    ).toEqual({ ok: false, error: "the validator failed: boom" });
  });

  test("a tool's own failure ({ ok: false }) is never accepted, the validator not even asked", async () => {
    let asked = false;
    const validate = () => {
      asked = true;
      return { ok: true as const };
    };
    expect(await acceptOutput({ ok: false, errors: [{ message: "unknown field" }] }, validate, { toolResult: true })).toEqual({
      ok: false,
      error: 'the tool failed: {"ok":false,"errors":[{"message":"unknown field"}]}',
    });
    expect(asked).toBe(false);
  });
});
