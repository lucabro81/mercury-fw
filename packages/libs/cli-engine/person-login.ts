/**
 * A person's login through a CLI's two-step remote login, for a plugin acting
 * as the person (`PersonLogin`): `auth login --user <id> --remote` prints the
 * link the person opens and the `state` the provider sends back with the
 * code; `auth login --user <id> --code <code> --state <state>` finishes it.
 * The CLI keeps the pending login (verifier, state, expiry) itself, in the
 * person's own folder, so nothing secret passes through here but the code.
 */
import type { PersonLogin } from "@mercury-fw/plugin-types";
import { cliUserId } from "@mercury-fw/utils";
import type { runCli } from "./cli-executor.ts";

/**
 * Builds `binary`'s `PersonLogin`. `redirectUri`: whether the CLI takes the
 * callback as `--redirect-uri` (jira, confluence, zitadel), or the provider
 * always sends the person back to the one callback registered on the app
 * (bitbucket), in which case that has to be Mercury's.
 */
export function createCliPersonLogin(
  runCliFn: typeof runCli,
  binary: string,
  { redirectUri }: { redirectUri: boolean },
): PersonLogin {
  return {
    start: async (personKey, callbackUrl) => {
      const args = ["auth", "login", "--user", cliUserId(personKey), "--remote"];
      const result = await runCliFn(binary, redirectUri ? [...args, "--redirect-uri", callbackUrl] : args);
      if (!result.ok) return { ok: false, error: result.error };
      const { authorize_url: authorizeUrl, state } = (result.data ?? {}) as { authorize_url?: unknown; state?: unknown };
      if (typeof authorizeUrl !== "string" || typeof state !== "string") {
        return { ok: false, error: `${binary} auth login --remote didn't print an authorize_url and a state` };
      }
      return { ok: true, authorizeUrl, state };
    },
    complete: async (personKey, code, state) => {
      const result = await runCliFn(binary, ["auth", "login", "--user", cliUserId(personKey), "--code", code, "--state", state]);
      return result.ok ? { ok: true } : { ok: false, error: result.error };
    },
  };
}
