/**
 * The web search plugin's texts a person sees, in English: the base every
 * instance's language files translate (`Plugin.messages`). What the model
 * reads (tool descriptions, the notes around a page) isn't here: it isn't
 * translated.
 */
import type { Messages } from "@mercury-fw/plugin-types";

export const WEB_SEARCH_MESSAGES: Messages = {
  // What a tool call is doing, on the channel's status.
  "web-search.status.search": 'Searching the web: "{query}"',
  "web-search.status.read": "Reading {host}",
  "web-search.status.read-page": "Reading a page",
  // The two ways to let the agent read a page on a host nobody allowed yet.
  "web-search.choice.once": "Only this time",
  "web-search.choice.always": "Always for {host}",
  // The list of the pages an answer drew on, under the answer.
  "web-search.sources.status": "Adding the sources…",
  "web-search.sources.heading": "Sources",
};
