/**
 * The real conversation the harness opens: Mercury composed with only the
 * plugin under training, on the vault it's given, each turn sent as the
 * operator on the terminal's channel (no person to identify, no session
 * captured to memory), its steps collected as `/dump` writes them. The model,
 * its settings (the config's `model` section, read as an app's config reads
 * it) and everything else come from the environment, as for any app.
 */
import { randomUUID } from "node:crypto";
import { composeMercury, defineMercuryConfig, OPERATOR_PRINCIPAL } from "@mercury-fw/core";
import type { Plugin } from "@mercury-fw/plugin-types";
import { watchBuild } from "./build-watch.ts";
import { modelSettingsFromEnv } from "./model-settings.ts";
import type { Conversation } from "./harness.ts";

/** Opens a conversation with Mercury running only `plugin`; throws when the
 * plugin didn't load. The core reads the vault's path from the environment
 * when it's composed, so this sets it first: conversations are opened one at
 * a time. */
export async function openMercuryConversation(plugin: Plugin, vaultPath: string): Promise<Conversation> {
  process.env.WIKI_VAULT_PATH = vaultPath;
  const watched = watchBuild(plugin);
  const app = await composeMercury(defineMercuryConfig({ plugins: [watched.plugin], model: modelSettingsFromEnv(process.env) }));
  const failure = watched.failure();
  if (failure !== undefined) throw new Error(failure);
  const sessionKey = `skill-trainer:${randomUUID()}`;
  return {
    send: async (text) => {
      const steps: unknown[] = [];
      let reply = "";
      await app.handleTurn(
        { channel: "terminal", multiUser: false, text, sessionKey, principal: OPERATOR_PRINCIPAL, logPrefix: "[skill-trainer] " },
        {
          onToolStart: () => {},
          // Taking the stream (and dropping it) is what turns on the core's
          // stall watchdog: a model that stops sending fails the turn instead
          // of holding the batch forever.
          onTextChunk: () => {},
          onReasoningChunk: () => {},
          onStep: (step) => void steps.push(step),
          finalize: async (finalText) => {
            reply = finalText;
          },
          dispose: () => {},
        },
      );
      return { steps, text: reply };
    },
    close: async () => {},
  };
}
