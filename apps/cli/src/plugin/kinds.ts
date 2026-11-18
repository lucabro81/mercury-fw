/**
 * The kinds of plugin `mfw plugin create` writes, one per contract an app
 * declares in `mercury.config.ts`: where the config takes it, the version of
 * the contract its template is written for (this CLI's, which is the app's
 * framework's), how its package and its export are named. And the spellings
 * of a plugin's name its templates use.
 */
import {
  AUTH_API_VERSION,
  CHANNEL_API_VERSION,
  CONVERSATION_STORE_API_VERSION,
  DIRECTORY_API_VERSION,
  PLUGIN_API_VERSION,
  TRACE_SINK_API_VERSION,
  VECTOR_INDEX_API_VERSION,
} from "@mercury-fw/kit";

/** Every kind, in the order `mfw plugin create --help` lists them. */
export const PLUGIN_KINDS = [
  "tool",
  "cli",
  "memory",
  "context-strategy",
  "channel",
  "auth",
  "directory",
  "trace-sink",
  "vector-index",
  "conversation-store",
] as const;

export type PluginKind = (typeof PLUGIN_KINDS)[number];

/**
 * Where the config takes a kind: in an array (`plugins`, `channels`), as a
 * key of its own (`auth`, `directory`, `vectorIndex`, `conversationStore`),
 * as `traces.sink`, or as a context profile's `conversation`.
 */
export type Declaration =
  | { in: "array"; key: "plugins" | "channels" }
  | { in: "key"; key: "auth" | "directory" | "vectorIndex" | "conversationStore" }
  | { in: "traces" }
  | { in: "profile" };

export type KindSpec = {
  /** What `mfw plugin create --help` says the kind is. */
  summary: string;
  /** What the kind is called in a sentence: "a tool plugin", "an auth provider". */
  label: string;
  declare: Declaration;
  apiVersion: number;
  /** What the package's name starts with, as in this repo (`plugin-jira`, `channel-http`). */
  packagePrefix: string;
  /** What the export's name ends with (`guestWifiPlugin`). */
  exportSuffix: string;
};

const KINDS: Record<PluginKind, KindSpec> = {
  tool: {
    summary: "typed tools the model calls, each with its input schema",
    label: "a tool plugin",
    declare: { in: "array", key: "plugins" },
    apiVersion: PLUGIN_API_VERSION,
    packagePrefix: "plugin-",
    exportSuffix: "Plugin",
  },
  cli: {
    summary: "a tool running a pinned command-line program, through an allowlist",
    label: "a CLI plugin",
    declare: { in: "array", key: "plugins" },
    apiVersion: PLUGIN_API_VERSION,
    packagePrefix: "plugin-",
    exportSuffix: "Plugin",
  },
  memory: {
    summary: "what the agent keeps from each turn and session, and what it reads back",
    label: "a memory plugin",
    declare: { in: "array", key: "plugins" },
    apiVersion: PLUGIN_API_VERSION,
    packagePrefix: "",
    exportSuffix: "Plugin",
  },
  "context-strategy": {
    summary: "a context profile's conversation: what the model reads of it",
    label: "a context strategy",
    declare: { in: "profile" },
    apiVersion: PLUGIN_API_VERSION,
    packagePrefix: "",
    exportSuffix: "Strategy",
  },
  channel: {
    summary: "a way people talk to the agent",
    label: "a channel",
    declare: { in: "array", key: "channels" },
    apiVersion: CHANNEL_API_VERSION,
    packagePrefix: "channel-",
    exportSuffix: "Channel",
  },
  auth: {
    summary: "who is calling a channel that takes credentials",
    label: "an auth provider",
    declare: { in: "key", key: "auth" },
    apiVersion: AUTH_API_VERSION,
    packagePrefix: "auth-",
    exportSuffix: "Auth",
  },
  directory: {
    summary: "who people are and their roles",
    label: "a directory",
    declare: { in: "key", key: "directory" },
    apiVersion: DIRECTORY_API_VERSION,
    packagePrefix: "directory-",
    exportSuffix: "Directory",
  },
  "trace-sink": {
    summary: "where the traces of what the agent does go",
    label: "a trace sink",
    declare: { in: "traces" },
    apiVersion: TRACE_SINK_API_VERSION,
    packagePrefix: "trace-",
    exportSuffix: "TraceSink",
  },
  "vector-index": {
    summary: "the vector index memory searches by meaning",
    label: "a vector index",
    declare: { in: "key", key: "vectorIndex" },
    apiVersion: VECTOR_INDEX_API_VERSION,
    packagePrefix: "store-",
    exportSuffix: "VectorIndex",
  },
  "conversation-store": {
    summary: "where conversations are kept word for word",
    label: "a conversation store",
    declare: { in: "key", key: "conversationStore" },
    apiVersion: CONVERSATION_STORE_API_VERSION,
    packagePrefix: "store-",
    exportSuffix: "ConversationStore",
  },
};

/** What `kind` is; throws naming the kinds for one that isn't. */
export function pluginKind(kind: string): KindSpec {
  if (!(PLUGIN_KINDS as readonly string[]).includes(kind)) {
    throw new Error(`"${kind}" is not a kind of plugin: ${PLUGIN_KINDS.join(", ")}`);
  }
  return KINDS[kind as PluginKind];
}

/** The longest name a plugin may have. */
const NAME_MAX = 50;

/** What's wrong with `name` as a plugin's name, or `undefined` when nothing is. */
export function pluginNameError(name: string): string | undefined {
  if (name === "") return "a plugin's name can't be empty";
  if (name.length > NAME_MAX) return `a plugin's name is at most ${NAME_MAX} characters`;
  if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(name)) {
    return `a plugin's name is lowercase words joined by hyphens (e.g. guest-wifi), not "${name}"`;
  }
  if (name === "core" || name === "app") return 'a plugin can\'t be named "core" or "app": the core and the app own those message keys';
  return undefined;
}

/** A plugin's name in every spelling its templates use. */
export type PluginNames = {
  /** As given: the plugin's `name`, its message keys' prefix, its folder. */
  name: string;
  camel: string;
  pascal: string;
  /** For constants and environment variables. */
  constant: string;
  /** For tool names. */
  snake: string;
  /** For headings. */
  title: string;
  exportName: string;
};

/** Every spelling of `name` (already valid) for a plugin of `kind`. */
export function pluginNames(name: string, kind: PluginKind): PluginNames {
  const words = name.split("-");
  const camel = words.map((w, i) => (i === 0 ? w : w[0]!.toUpperCase() + w.slice(1))).join("");
  return {
    name,
    camel,
    pascal: camel[0]!.toUpperCase() + camel.slice(1),
    constant: words.join("_").toUpperCase(),
    snake: words.join("_"),
    title: words.join(" ").replace(/^./, (c) => c.toUpperCase()),
    exportName: camel + KINDS[kind].exportSuffix,
  };
}
