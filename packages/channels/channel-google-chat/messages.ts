/**
 * The Google Chat channel's texts a person sees, in English: the base every
 * instance's language files translate (`ChannelPlugin.messages`). The cards'
 * titles and status lines, the confirm button of a plain staging; the replies
 * and the tool labels are the core's and the plugins'.
 */
import type { Messages, Translate } from "@mercury-fw/channel-types";

export const GOOGLE_CHAT_MESSAGES: Messages = {
  // The confirmation card (`buildConfirmCard`, `buildChosenCard`).
  "google-chat.confirm.title": "Confirmation needed",
  "google-chat.confirm.button": "Confirm",
  "google-chat.confirm.chosen": "Chosen: {label}",
  "google-chat.confirm.taken": "Choice recorded.",
  // A tool call's or a reasoning burst's card (`buildToolCallCard`).
  "google-chat.status.loading": "In progress…",
  "google-chat.status.success": "Done.",
  "google-chat.status.failed": "Failed.",
  "google-chat.status.pending": "Waiting for confirmation.",
  "google-chat.status.stopped": "Stopped.",
  "google-chat.thinking": "Thinking…",
  // The card sent as soon as a message arrives (`buildReceivingCard`).
  "google-chat.receiving.title": "Status",
  "google-chat.receiving.text": "Message received…",
  // The Stop button on a card in progress (`stopSection`), and `/stop` with nothing running.
  "google-chat.stop.button": "Stop",
  "google-chat.stop.nothing": "Nothing to stop.",
};

/** These texts in English, for a provider built without the core's (`ChannelI18n`); any other key comes back as itself. */
export const englishChat: Translate = (key, params) =>
  (GOOGLE_CHAT_MESSAGES[key] ?? key).replace(/\{(\w+)\}/g, (whole, name: string) =>
    params !== undefined && Object.hasOwn(params, name) ? String(params[name]) : whole,
  );
