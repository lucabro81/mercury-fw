/**
 * The channel's texts a person sees, in English, every key under the
 * channel's name; the app's language files translate them
 * (`locales/<language>.json`).
 */
import type { Messages } from "@mercury-fw/kit";

export const __CONSTANT___MESSAGES: Messages = {
  "__NAME__.unauthorized": "Who are you? Send your credentials with the message.",
  "__NAME__.no-text": "The message has no text.",
  "__NAME__.failed": "Something went wrong with that message. Try again in a moment.",
};
