/**
 * The plugins' hooks (#387): who hears about a turn that ended with an answer
 * (`afterTurn`) and about a session closed for being quiet (`onSessionClose`).
 *
 * A plugin hears about a turn only when it was offered in that turn: the same
 * roles and permissions that decide its tools decide what it learns, so a
 * hook is never a way around `access`. A session's close goes to the plugins
 * offered in its last finished turn, so a plugin hears the close of a session
 * only if it heard its turns.
 *
 * Nothing waits for a hook: the person already has the answer, and their next
 * turn must not wait either. Each hook's outcome becomes a `plugin.hook`
 * event; a hook that throws or rejects is logged, and the others go on.
 *
 * Used by: `compose.ts`, which hands `afterTurn` to the turn runner and
 * `sessionClosed` to the idle-session sweep.
 */
import type { HookMessage } from "@mercury-fw/plugin-types";
import type { TurnWho } from "../identity/people.ts";
import type { FinishedTurnInfo } from "../router/turn-runner.ts";
import { hookCall } from "../session/call-record.ts";
import type { Message } from "../session/history.ts";
import type { TraceInput } from "../traces/tracer.ts";
import type { LoadedPlugin } from "./plugin-loader.ts";

/** A plugin offered in a turn, and how (see `OfferedPlugin` in `offering.ts`). */
export type OfferedEntry = { plugin: LoadedPlugin; as: "person" | "mercury" | "anyone" };

/** What the hooks need: what a person is offered, where the log and the events go, the clock. */
export type PluginHooksDeps = {
  offered: (who: TurnWho) => OfferedEntry[];
  log: (message: string) => void;
  emit?: (event: TraceInput) => void;
  now?: () => number;
};

/** A closed session as the idle sweep hands it over: its key, whose it was, its messages. */
export type ClosedSessionInfo = { key: string; userId: string; messages: Message[] };

export type PluginHooks = {
  /** Hands a finished turn to the `afterTurn` of each plugin offered in it, and remembers who the session's last turn was for (not the terminal's, which is never closed for being quiet). Returns at once. */
  afterTurn: (who: TurnWho, turn: FinishedTurnInfo) => void;
  /** Hands a closed session to the `onSessionClose` of each plugin offered in its last finished turn; nothing for a session with none. Returns at once. */
  sessionClosed: (session: ClosedSessionInfo) => void;
};

/** One entry per plugin, as it was first offered: a plugin offered as the person and as itself (its `AsSelf` variant) hears a turn once. */
function oncePerPlugin(entries: OfferedEntry[]): OfferedEntry[] {
  const seen = new Set<string>();
  return entries.filter(({ plugin }) => (seen.has(plugin.name) ? false : (seen.add(plugin.name), true)));
}

/** A session's message as `onSessionClose` sees it. */
function hookMessage(message: Message): HookMessage {
  return {
    role: message.role,
    content: message.content,
    ...(message.calls === undefined ? {} : { calls: message.calls.map(hookCall) }),
  };
}

/** Builds the plugins' hooks; see the module comment. */
export function createPluginHooks(deps: PluginHooksDeps): PluginHooks {
  const now = deps.now ?? Date.now;
  /** Whom each open session's last finished turn was for: its close goes to what they were offered. */
  const lastWho = new Map<string, TurnWho>();

  /** Runs one plugin's hook without waiting for it, and reports how it went once it settles. */
  function run(plugin: string, hook: "afterTurn" | "onSessionClose", session: string, person: string, call: () => void | Promise<void>): void {
    const started = now();
    const report = (error?: unknown) => {
      const message = error === undefined ? undefined : error instanceof Error ? error.message : String(error);
      if (message !== undefined) deps.log(`[hooks] plugin "${plugin}" ${hook} failed: ${message}`);
      deps.emit?.({
        kind: "plugin.hook",
        plugin,
        hook,
        session,
        person,
        ms: now() - started,
        outcome: message === undefined ? "done" : "failed",
        ...(message === undefined ? {} : { args: { error: message } }),
      });
    };
    let result: void | Promise<void>;
    try {
      result = call();
    } catch (err) {
      report(err);
      return;
    }
    Promise.resolve(result).then(
      () => report(),
      (err: unknown) => report(err ?? "rejected"),
    );
  }

  return {
    afterTurn(who, turn) {
      // The terminal's sessions are never closed for being quiet: nothing to remember for them.
      if (!who.operator) lastWho.set(turn.sessionKey, who);
      for (const { plugin, as } of oncePerPlugin(deps.offered(who))) {
        const hook = plugin.afterTurn;
        if (hook === undefined) continue;
        run(plugin.name, "afterTurn", turn.sessionKey, who.person.key, () =>
          hook({ ...turn, person: { key: who.person.key }, operator: who.operator, as }),
        );
      }
    },
    sessionClosed(session) {
      const who = lastWho.get(session.key);
      if (who === undefined) return;
      lastWho.delete(session.key);
      const messages = session.messages.map(hookMessage);
      for (const { plugin } of oncePerPlugin(deps.offered(who))) {
        const hook = plugin.onSessionClose;
        if (hook === undefined) continue;
        run(plugin.name, "onSessionClose", session.key, session.userId, () =>
          hook({ sessionKey: session.key, person: { key: session.userId }, messages }),
        );
      }
    },
  };
}
