/**
 * The real conversation the harness opens: Mercury composed with only the
 * plugin under training, on the vault it's given, each turn sent as the
 * operator on the terminal's channel (no person to identify, no session
 * captured to memory), its steps collected as `/dump` writes them. The model
 * and everything else come from the environment, as for any app.
 */
import { randomUUID } from "node:crypto";
import { composeMercury, defineMercuryConfig, OPERATOR_PRINCIPAL } from "@mercury-fw/core";
import type { Plugin } from "@mercury-fw/plugin-types";
import type { Conversation } from "./harness.ts";

/** Opens a conversation with Mercury running only `plugin`. The core reads
 * the vault's path from the environment when it's composed, so this sets it
 * first: conversations are opened one at a time. */
export async function openMercuryConversation(plugin: Plugin, vaultPath: string): Promise<Conversation> {
  process.env.WIKI_VAULT_PATH = vaultPath;
  const app = await composeMercury(defineMercuryConfig({ plugins: [plugin] }));
  const sessionKey = `skill-trainer:${randomUUID()}`;
  return {
    send: async (text) => {
      const steps: unknown[] = [];
      let reply = "";
      await app.handleTurn(
        { channel: "terminal", multiUser: false, text, sessionKey, principal: OPERATOR_PRINCIPAL, logPrefix: "[skill-trainer] " },
        {
          onToolStart: () => {},
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
