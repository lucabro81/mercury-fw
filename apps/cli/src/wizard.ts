/**
 * The interactive side of `mfw create`: asks for the answers, pre-filled
 * with whatever the flags already gave, shows a summary and asks to confirm.
 * Only questions; building and writing the app is `index.ts`'s job.
 */
import { basename } from "node:path";
import * as p from "@clack/prompts";
import { CATALOG, type CatalogEntry } from "./catalog.ts";
import { appNameError } from "./render.ts";
import type { CreateArgs } from "./args.ts";

/** The answers `renderApp` needs, apart from the package versions, and the
 * repository's origin (none when absent). */
export type Answers = {
  name: string;
  assistantName: string;
  role: string;
  channels: string[];
  plugins: string[];
  /** The HTTP channel's auth provider, there exactly when that channel is. */
  auth?: string;
  gitRemote?: string;
};

export const DEFAULT_ASSISTANT_NAME = "Mercury";
export const DEFAULT_ROLE = "an internal assistant";

/** A text answer's default, shown greyed out and taken on a bare Enter; typing
 * replaces it instead of appending to it. */
const suggest = (value: string) => ({ placeholder: value, defaultValue: value });

/** A multi-select over the catalog entries of `kind`; none selected is fine.
 * Undefined when the user cancels. */
async function pick(kind: CatalogEntry["kind"], message: string, initial: string[]): Promise<string[] | undefined> {
  const picked = await p.multiselect({
    message,
    options: CATALOG.filter((e) => e.kind === kind).map((e) => ({ value: e.id, label: e.id, hint: e.package })),
    initialValues: initial,
    required: false,
  });
  return p.isCancel(picked) ? undefined : picked;
}

/** Asks every question, starting from `args`, for an app to be written into
 * `dir` (already in kebab case, and the app name's default). Resolves to
 * undefined when the user cancels (Ctrl+C) or doesn't confirm. */
export async function askAnswers(args: CreateArgs, dir: string): Promise<Answers | undefined> {
  p.intro("mfw create");
  // A --name that isn't a valid app name isn't offered; then there's no
  // default, and an empty answer is rejected.
  const nameDefault = args.name ?? basename(dir);
  const name = await p.text({
    message: "App name",
    ...(appNameError(nameDefault) === undefined ? suggest(nameDefault) : {}),
    validate: (v) => (v ? appNameError(v) : appNameError(nameDefault)),
  });
  if (p.isCancel(name)) return cancelled();
  const assistantName = await p.text({
    message: "Assistant name",
    ...suggest(args.assistantName ?? DEFAULT_ASSISTANT_NAME),
    validate: (v) => (v === undefined || v === "" || v.trim() ? undefined : "The assistant needs a name"),
  });
  if (p.isCancel(assistantName)) return cancelled();
  const role = await p.text({
    message: `${assistantName} is… (completes "You are ${assistantName}, …")`,
    ...suggest(args.role ?? DEFAULT_ROLE),
    validate: (v) => (v === undefined || v === "" || v.trim() ? undefined : "The role can't be empty"),
  });
  if (p.isCancel(role)) return cancelled();
  const channels = await pick("channel", "Channels (space to select, none is fine: the REPL always works)", args.channels ?? []);
  if (channels === undefined) return cancelled();
  // The HTTP channel doesn't start without an auth provider, so choosing it
  // means choosing one; without it there's nothing to ask.
  let auth: string | undefined;
  if (channels.includes("http")) {
    const picked = await p.select({
      message: "Auth provider for the HTTP channel (who may call it)",
      options: CATALOG.filter((e) => e.kind === "auth").map((e) => ({ value: e.id, label: e.id, hint: e.package })),
      ...(args.auth !== undefined ? { initialValue: args.auth } : {}),
    });
    if (p.isCancel(picked)) return cancelled();
    auth = picked;
  }
  const plugins = await pick("tool", "Tool plugins (space to select)", args.plugins ?? []);
  if (plugins === undefined) return cancelled();
  // Asked only when there will be a repository and the flag didn't say.
  let gitRemote = args.gitRemote;
  if (args.git && gitRemote === undefined) {
    const typed = await p.text({
      message: "Git remote for origin (empty: none, add it later)",
      validate: (v) => (v?.trim().startsWith("-") ? "That's not a remote: git would read it as an option" : undefined),
    });
    if (p.isCancel(typed)) return cancelled();
    if (typed && typed.trim()) gitRemote = typed.trim();
  }

  p.note(
    [
      `App: ${name}`,
      `Assistant: You are ${assistantName}, ${role}.`,
      `Channels: ${channels.length > 0 ? channels.join(", ") : "none"}`,
      ...(auth !== undefined ? [`Auth: ${auth}`] : []),
      `Tool plugins: ${plugins.length > 0 ? plugins.join(", ") : "none"}`,
      ...(args.git ? [`Origin: ${gitRemote ?? "none"}`] : []),
    ].join("\n"),
    "Summary",
  );
  const ok = await p.confirm({ message: `Create it in ${dir}?` });
  if (p.isCancel(ok) || !ok) return cancelled();
  return {
    name,
    assistantName,
    role,
    channels,
    plugins,
    ...(auth !== undefined ? { auth } : {}),
    ...(gitRemote !== undefined ? { gitRemote } : {}),
  };
}

function cancelled(): undefined {
  p.cancel("Nothing written.");
  return undefined;
}
