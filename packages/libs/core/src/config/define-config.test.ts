/**
 * Tests for the composition config helper. `defineMercuryConfig` is a pure
 * identity+typing helper — it must hand back exactly what it was given, adding
 * no runtime behavior. Which plugins an app declares is that app's business,
 * tested there if anywhere: the core is agnostic to what any app composes.
 */
import { describe, expect, test } from "bun:test";
import { defineMercuryConfig } from "./define-config.ts";
import { ollamaModel } from "../model/models.ts";
import { z } from "zod";
import type { ChannelPlugin, OutputMode } from "@mercury-fw/channel-types";
import { toolOf } from "../session/turn-output.ts";

const models = { turn: ollamaModel("m") };

describe("defineMercuryConfig", () => {
  test("returns its input unchanged (same reference)", () => {
    const input = { plugins: [], models };
    expect(defineMercuryConfig(input)).toBe(input);
  });

  test("carries the declared plugins through verbatim", () => {
    const a = { apiVersion: 1, name: "a", description: "A.", cliConfig: {} };
    const b = { apiVersion: 1, name: "b", description: "B.", cliConfig: {} };
    const config = defineMercuryConfig({ plugins: [a, b], models });
    expect(config.plugins).toEqual([a, b]);
  });

  test("carries the persona through verbatim", () => {
    const persona = { identity: "You are Hermes.", tone: "Be terse." };
    expect(defineMercuryConfig({ plugins: [], models, persona }).persona).toBe(persona);
  });
});

describe("defineMercuryConfig: context (#387)", () => {
  const wiki = { apiVersion: 6, name: "wiki", description: "Keeps notes." };
  const profile = { layers: [wiki], budget: { maxChars: 4000 } };

  test("takes profiles with a default and an assign naming them", () => {
    const config = defineMercuryConfig({
      plugins: [wiki],
      models,
      context: { profiles: { default: profile, premium: profile }, assign: { premium: ["paid"] } },
    });
    expect(config.context?.assign).toEqual({ premium: ["paid"] });
  });

  test("a context without a default profile, or assigning one that doesn't exist, doesn't type", () => {
    defineMercuryConfig({
      plugins: [wiki],
      models,
      // @ts-expect-error: every context has a default profile
      context: { profiles: { premium: profile } },
    });
    defineMercuryConfig({
      plugins: [wiki],
      models,
      context: {
        profiles: { default: profile, premium: profile },
        // @ts-expect-error: assign names only the profiles there are
        assign: { premum: ["paid"] },
      },
    });
  });
});

describe("defineMercuryConfig: output and the channels' outputs (#403)", () => {
  const catalog = { apiVersion: 7, name: "catalog", description: "Builds queries." };
  const build = toolOf(catalog, "catalog_build");
  const schema = z.object({ query: z.string() });
  const chat: ChannelPlugin = { apiVersion: 7, name: "chat", build: () => undefined };
  const http: ChannelPlugin<OutputMode> = { apiVersion: 7, name: "http", build: () => undefined, outputs: ["text", "tool", "schema"] };
  const forms: ChannelPlugin<"schema"> = { apiVersion: 7, name: "forms", build: () => undefined, outputs: ["schema"] };

  test("an output every channel takes types, and comes back as given", () => {
    const output = { tool: build };
    expect(defineMercuryConfig({ plugins: [catalog], models, channels: [http], output }).output).toBe(output);
    defineMercuryConfig({ plugins: [], models, channels: [http, forms], output: { schema } });
    defineMercuryConfig({ plugins: [], models, channels: [chat, http], output: "text" });
    defineMercuryConfig({ plugins: [], models, channels: [chat] });
    defineMercuryConfig({ plugins: [catalog], models, output: { tool: build } });
  });

  test("an output a channel doesn't take doesn't type", () => {
    defineMercuryConfig({
      plugins: [catalog],
      models,
      channels: [chat],
      // @ts-expect-error: a channel declared without outputs takes text only
      output: { tool: build },
    });
    defineMercuryConfig({
      plugins: [catalog],
      models,
      channels: [http, chat],
      // @ts-expect-error: every channel must take it, not just one
      output: { tool: build, retries: 1 },
    });
    defineMercuryConfig({
      plugins: [catalog],
      models,
      channels: [forms],
      // @ts-expect-error: forms takes schema outputs, not tool ones
      output: { tool: build },
    });
  });

  test("a channel typed as plain ChannelPlugin can't declare outputs besides text", () => {
    // @ts-expect-error: a channel taking a tool output says so in its type, ChannelPlugin<"tool">
    const wrong: ChannelPlugin = { apiVersion: 7, name: "w", build: () => undefined, outputs: ["tool"] };
    expect(wrong.name).toBe("w");
  });
});
