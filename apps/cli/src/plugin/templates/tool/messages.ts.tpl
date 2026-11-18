/**
 * The plugin's texts a person sees, in English: the status line while a tool
 * runs. Every key starts with the plugin's name; the app's language files
 * translate them (`locales/<language>.json`).
 */
import type { Messages } from "@mercury-fw/kit";

export const __CONSTANT___MESSAGES: Messages = {
  "__NAME__.status.list": "Looking up the items",
  "__NAME__.status.delete": "Deleting an item",
};
