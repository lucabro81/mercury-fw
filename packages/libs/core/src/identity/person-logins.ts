/**
 * People's logins to the services the plugins act on as them. A tool whose
 * person isn't logged in asks for one (`require`): the plugin's `PersonLogin`
 * starts it with the callback a channel offered (`accept`), and the pending
 * login is kept by its `state`, which the provider sends back with the code
 * to that channel (`complete`). The state is single-use, expires with the
 * login, and was handed out for one person and one service only, so the
 * request carrying it needs no other credential. In memory: a restart loses
 * the pending logins, and the person just asks again.
 */
import type { LoginRequired, PersonLogin } from "@mercury-fw/plugin-types";
import type { LoginOutcome } from "@mercury-fw/channel-types";

type Pending = { service: string; login: PersonLogin; personKey: string; expiresAt: number };

export type PersonLogins = {
  /** The URL the provider sends the person back to, offered by a channel that can receive it. */
  accept(callbackUrl: string): void;
  /** Starts `personKey`'s login to `service` and returns what the tool hands back. */
  require(service: string, login: PersonLogin, personKey: string): Promise<LoginRequired>;
  /** Finishes the login `state` was issued for, with the provider's `code`. */
  complete(state: string, code: string): Promise<LoginOutcome>;
};

/** Builds the logins of one instance. `ttlMs` matches the CLIs' pending logins (10 minutes). */
export function createPersonLogins({ now = Date.now, ttlMs = 10 * 60_000 }: { now?: () => number; ttlMs?: number } = {}): PersonLogins {
  let callbackUrl: string | undefined;
  const pending = new Map<string, Pending>();

  /** Drops expired logins, and those `personKey` started earlier for `service`. */
  function prune(service?: string, personKey?: string): void {
    for (const [state, p] of pending) {
      if (p.expiresAt <= now() || (p.service === service && p.personKey === personKey)) pending.delete(state);
    }
  }

  return {
    accept(url) {
      callbackUrl = url;
    },
    async require(service, login, personKey) {
      if (callbackUrl === undefined) {
        return {
          ok: false,
          error: `The user isn't logged in to ${service}, and nothing on this Mercury instance can take a login (the HTTP channel does once HTTP_SURFACE_PUBLIC_URL is set). Tell the user.`,
        };
      }
      const started = await login.start(personKey, callbackUrl);
      if (!started.ok) {
        return { ok: false, error: `The user isn't logged in to ${service}, and their login couldn't start: ${started.error}` };
      }
      prune(service, personKey);
      pending.set(started.state, { service, login, personKey, expiresAt: now() + ttlMs });
      return {
        ok: false,
        loginRequired: true,
        service,
        authorizeUrl: started.authorizeUrl,
        error: `The user isn't logged in to ${service} yet: tell them to log in with the link shown to them and then ask again. Never write a link yourself.`,
      };
    },
    async complete(state, code) {
      const p = pending.get(state);
      pending.delete(state);
      if (p === undefined || p.expiresAt <= now()) {
        return { ok: false, error: "This login link has expired or was already used: ask Mercury again for a new one." };
      }
      const done = await p.login.complete(p.personKey, code, state);
      return done.ok
        ? { ok: true, service: p.service }
        : { ok: false, error: `The ${p.service} login didn't go through: ${done.error}. Ask Mercury again for a new link.` };
    },
  };
}
