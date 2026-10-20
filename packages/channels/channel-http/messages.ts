/**
 * The HTTP channel's texts a person sees, in English: the base every
 * instance's language files translate (`ChannelPlugin.messages`). Only the
 * login page: everything else the surface sends is the core's, or the
 * developer-facing errors of its API, which aren't translated.
 */
import type { Messages, Translate } from "@mercury-fw/channel-types";

export const HTTP_MESSAGES: Messages = {
  // The page a person lands on after logging in to a service (`GET /login/callback`).
  "http.login.denied": "The login didn't happen ({reason}). Ask {assistant} again for a new link.",
  "http.login.incomplete": "The login link came back without a code or a state. Ask {assistant} again for a new link.",
  "http.login.done": "You're logged in to {service}. Go back to the conversation and ask again.",
};

/** These texts in English, for a server built without the core's (`ChannelI18n`), as tests build it. */
export const englishHttp: Translate = (key, params) =>
  (HTTP_MESSAGES[key] ?? key).replace(/\{(\w+)\}/g, (whole, name: string) =>
    params !== undefined && Object.hasOwn(params, name) ? String(params[name]) : whole,
  );
