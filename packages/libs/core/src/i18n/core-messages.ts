/**
 * The core's own texts a person sees, in English: the base every instance's
 * language files translate (see `i18n.ts`). Model-facing prompts, logs and
 * the HTTP API's developer errors aren't here: they aren't translated.
 */
import type { Messages } from "./i18n.ts";

export const CORE_MESSAGES: Messages = {
  // Who the core talks to (`identity/people.ts`).
  "core.access.unknown": "This assistant only talks to the people it knows. Ask an administrator for access.",
  "core.access.unavailable": "I can't check who you are right now. Try again in a few minutes.",

  // Linking a second account (`identity/linking.ts`).
  "core.link.invalid":
    "That code isn't valid: it may have expired or been used already. Ask for a new one on the account you want to link to.",
  "core.link.terminal": "The terminal can't link accounts.",
  "core.link.same-account": "That code is for linking another account to this one.",
  "core.link.has-linked": "Other accounts are linked to this one: unlink them first, or link them to {owner} directly.",
  "core.link.confirm":
    "This will link this account to {owner}: from then on {assistant} treats them as one person, with {owner}'s private area and roles. Send the same code again to confirm.",
  "core.link.cant-check": "I can't check this account right now. Ask for a new code and try again in a few minutes.",
  "core.link.someone-else": "This account belongs to someone else in the directory: it can't be linked to {owner}.",
  "core.link.failed": "I can't link accounts right now. Ask whoever runs this assistant to check its logs.",
  "core.link.done": "Linked: this account is now {owner}.",

  // A staged action, and the person's confirmation of it (`session/agent-turn.ts`, `identity/confirm-binding.ts`).
  "core.pending.note": "Action pending, waiting for confirmation.",
  "core.confirm.not-found": "There's no pending confirmation for this token: it may have expired, been used already, or never existed.",
  "core.confirm.failed": "Confirmed, but it failed: {error}",
  "core.confirm.done": "Confirmed and done.",
  "core.confirm.resume": "Confirmed, picking up where I left off.",

  // A person's login to a service (`identity/person-logins.ts`), and the words on its link (`loginLinkText`).
  "core.login.link": "Log in to {service}",
  "core.login.link-any": "Log in to the service",
  "core.login.expired": "This login link has expired or was already used: ask {assistant} again for a new one.",
  "core.login.failed": "The {service} login didn't go through. Ask {assistant} again for a new link.",

  // What a tool call is doing, on the channel's status (`session/tool-start-hook.ts`).
  "core.status.memory": "Checking my memory…",
  "core.status.instructions": "Checking the instructions…",
  "core.status.searching": "Searching…",
  "core.status.wiki-read": "Reading the wiki…",
  "core.status.wiki-write": "Writing to the wiki…",
  "core.status.tool": "Using {tool}…",
  "core.status.wiki-all": "Every document in the wiki",
  "core.status.call-history": "The calls made in this conversation",
  // A CLI command a plugin runs, unless the plugin words it itself (`defaultStatusLabel`, `@mercury-fw/cli-engine`).
  "core.status.command": "Running {binary} {command}",
  "core.status.command-bare": "Running {binary}",
  "core.status.command-unknown": "Running a command",
  // Saving to memory (`session/session-capture.ts`, `compose.ts`).
  "core.status.remembering": "Noting down something important…",
  "core.status.capture-detail": 'Recent conversation ({count} messages: "{preview}"), collection "{collection}"',
  "core.status.correction-detail": 'Correction for the tool "{tool}" (topic: "{topic}", collection: "{collection}")',

  // The terminal REPL (`router/terminal-provider.ts`, `router/terminal.ts`).
  "core.terminal.thinking": "Thinking…",
  "core.terminal.pending": "Action pending: `{summary}` — type: {token}",
  "core.terminal.pending-choices": "Action pending: `{summary}`",
  "core.terminal.choice": "{label} — type: {token}",
  "core.terminal.corrected": "[answer corrected from what was shown above]",
};
