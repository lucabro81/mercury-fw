/**
 * The __TITLE__ plugin: the agent lists the items of a service and deletes
 * one, once the person confirms. Written by `mfw plugin create` as a starting
 * point: the service, its client and the tools (`tools.ts`) are examples to
 * replace with the plugin's own.
 */
import { readFileSync } from "node:fs";
import { parseSkill, type Plugin } from "@mercury-fw/kit";
import { __CONSTANT___MESSAGES } from "./messages.ts";
import { createTools, httpClient, type Client } from "./tools.ts";

/** How to use the tools, which the model reads when it needs them. */
const skill = parseSkill(readFileSync(new URL("./skills/__NAME__/SKILL.md", import.meta.url), "utf8"));

/** What the model reads about the plugin before every conversation; `{{assistant}}` becomes the assistant's name. */
const FRAGMENT = [
  "## __TITLE__",
  "{{assistant}} can list the items of __TITLE__ and delete one. Load the __NAME__ skill before using its tools.",
].join("\n");

export type __PASCAL__Options = {
  /** The service's client: one over HTTP at `__CONSTANT___URL` unless given (tests give their own). */
  client?: Client;
};

/** The plugin. */
export function __EXPORT__(options: __PASCAL__Options = {}): Plugin {
  return {
    // The contract this plugin is written for, as a literal: importing
    // PLUGIN_API_VERSION would report whichever contract is installed.
    apiVersion: __API_VERSION__,
    name: "__NAME__",
    description: "Lists the items of __TITLE__ and deletes one.",
    // Who the service sees: nobody in particular, so anyone may use it.
    // "person" when each person logs in to the service, "mercury" when it
    // runs with the instance's own account.
    actsAs: "anyone",
    systemPromptFragment: FRAGMENT,
    skills: [skill],
    messages: __CONSTANT___MESSAGES,
    build: (ctx) => {
      const url = ctx.env.__CONSTANT___URL;
      const client = options.client ?? (url ? httpClient(url) : undefined);
      // A setting missing is logged, and the plugin contributes nothing: the
      // agent starts anyway, without these tools.
      if (client === undefined) {
        ctx.log("__NAME__: __CONSTANT___URL is not set: no tools");
        return {};
      }
      return {
        sessionTools: (sctx) => createTools(client, sctx),
        toolStatusDescribers: {
          __SNAKE___list: (_input, t) => t("__NAME__.status.list"),
          __SNAKE___delete: (_input, t) => t("__NAME__.status.delete"),
        },
      };
    },
  };
}
