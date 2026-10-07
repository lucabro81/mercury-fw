/**
 * The plugin contract: the shared types both the Mercury core and every plugin
 * package program against. It exists so neither side has to mirror the other's
 * shapes locally (as the Jira plugin did through Fase 2) and so the compiler
 * checks compatibility at a real seam rather than by hand. It's a monorepo
 * type package, not a published SDK — there is no runtime here beyond the one
 * version constant.
 *
 * The interface is deliberately the *sum of what Fase 2 actually had to
 * deliver*, not a guess at what a plugin might one day want. Its real
 * validation is the second plugin (Bitbucket): if extracting it forces this
 * file to grow, the interface was Jira-shaped and gets redrawn. Two slots are
 * reserved ahead of that — `apiVersion` and `surfaces` — not because Jira uses
 * them, but because adding either later would be a retrofit on every plugin
 * already written.
 */
import type { LanguageModel, Tool } from "ai";

/**
 * Contract version. The core and a plugin are versioned and installed
 * separately, so a plugin compiled against a different contract than the core
 * supports is possible by construction; the loader compares this against each
 * plugin's declared `apiVersion` and refuses a mismatch (fail-soft). A single
 * integer, bumped only on a breaking change to the shapes in this file.
 */
export const PLUGIN_API_VERSION = 4;

/** A tool built with `ai`'s `tool()` and an `execute`: what the core's and the
 * plugins' tool factories return. Spelled out so their declarations name it
 * instead of `ai`'s internal types, which a published package can't reference. */
export type ExecutableTool = Tool & { execute: NonNullable<Tool["execute"]> };

/**
 * The user-facing channel of a tool result: structured output destined for the
 * user and — unlike `data` — never placed into the model's context. `type`
 * names the kind of data (e.g. "issue-list"): the key an instance's formatter
 * rules are looked up by, so a plugin should export the kinds it emits as a
 * type mapping each kind to its item shape. `items` are its entries. Kept deliberately generic here so it serves any plugin (a CLI
 * post-processor today, an endpoint/MCP plugin later), not just CLI results.
 * The core strips it before the result reaches the model (see the core's
 * `toModelOutput`) and renders it separately for the user.
 */
export type ToolDisplay = { type: string; items: unknown[] };

/**
 * Result of running a CLI command, carrying two explicit channels. On success
 * `data` is the model channel — the parsed JSON (or raw text) stdout the model
 * reasons on — and the optional `display` is the user channel (see
 * `ToolDisplay`), which never enters the model's context. On failure `error` is
 * a human/model-readable string, with the process's `exitCode` when it ran
 * and exited non-zero. Mirrors `runCli`'s return — `@mercury-fw/cli-engine`
 * owns the runner, this owns the shape both sides agree on.
 */
export type CliResult =
  | { ok: true; data: unknown; display?: ToolDisplay }
  | { ok: false; error: string; exitCode?: number };

/**
 * Deterministically transforms a `runCli` result. A plugin contributes at most
 * one, and it runs after every allowed command of the plugin's tool; `prefix`
 * is the allowlist entry that matched (`[]` for `--help`), so the plugin
 * decides for itself which commands it touches and passes the rest through.
 * Can augment `data`, attach a `display`, or turn a technically-ok result into
 * `{ ok: false }` when the data isn't shaped as it needs.
 */
export type CliPostProcessor = (
  cmd: { binary: string; args: string[]; prefix: string[] },
  result: CliResult,
) => CliResult;

/**
 * The outcome of running a deferred, confirm-required action. Deliberately
 * generic (no `display` channel, unlike `CliResult`): the confirmation
 * subsystem reports `data` or `error` and nothing more. A CLI command's
 * execution is one producer of it, a future non-CLI action another.
 */
export type ActionResult = { ok: true; data: unknown } | { ok: false; error: string };

/**
 * Stages an irreversible action behind a confirmation token and returns that
 * token. The action is opaque — a `run` thunk plus a `describe` string for the
 * paper trail — so nothing here (and nothing in the core that runs it later)
 * needs to know what kind of action it is. The core binds an implementation to
 * a session/user and hands it to whatever needs to defer an action; the plugin
 * side calls it without touching the confirmation store or the wiki. See the
 * core's confirmation-staging and confirm-flow for the two halves.
 */
export type StageConfirmation = (action: {
  run: () => Promise<ActionResult>;
  describe: string;
}) => Promise<string>;

/**
 * Minimal shape of a finished generation step — enough to see what tool was
 * called, with what input, and what came back. A subset of the AI SDK's
 * `StepResult`; function parameter types only need to be structurally
 * compatible, not identical. A `toolCalls` entry with no matching
 * `toolResults` entry (linked by `toolCallId`) means the call failed before
 * executing, surfaced as a `tool-error` in `content`.
 */
export type StepInfo = {
  toolCalls: Array<{ toolCallId: string; toolName: string; input: unknown }>;
  toolResults: Array<{ toolCallId: string; toolName: string; output: unknown }>;
  content: Array<{ type: string; toolCallId?: string; error?: unknown }>;
};

/**
 * A post-turn guard: something run over the model's finished text before it
 * reaches the user. `shouldRun` gates both the transformation and its status
 * indicator; `run` returns the (possibly unchanged) text plus an `outcome`
 * that drives the status pair and an optional diagnostic `log`. `steps` is
 * offered for guards that need the turn's tool trace; a guard free to ignore
 * it. A guard that throws never blocks delivery — the core wraps each one.
 */
export type PostTurnGuard = {
  statusLabel: string;
  statusId: string;
  shouldRun: (text: string) => boolean;
  run: (text: string, steps: StepInfo[]) => Promise<{ text: string; outcome: "success" | "failed"; log?: string }>;
};

/**
 * What a plugin's `build()` receives — everything its runtime contributions may
 * need that isn't static data: the shared model (for a model-backed guard), the
 * process env (for its own configuration), and a logger for anything it skips.
 */
export type PluginRuntimeContext = {
  model: LanguageModel;
  env: Record<string, string | undefined>;
  log: (msg: string) => void;
};

/**
 * The per-turn context a `sessionTools` factory receives: the session it's
 * building tools for, and the two core capabilities a tool may need bound to
 * that session — staging a confirm-required action, and stashing a display
 * artifact for the model to `present`. All generic; nothing here is CLI-shaped.
 */
export type SessionToolContext = {
  sessionKey: string;
  stageConfirmation: StageConfirmation;
  stashDisplay: (artifact: string) => string;
  /** Who the turn is for, by user key (`<provider>:<id>`), when it's a person;
   * `null` on the terminal, where whoever types already holds the container
   * and a plugin acts as its own service identity. */
  person: { key: string } | null;
  /** For a plugin acting as `person` whose service says that person isn't
   * logged in: starts their login and returns what the tool hands back, a
   * `loginRequired` result whose link the channel shows them, or an error
   * when nothing can take a login. */
  requireLogin: () => Promise<LoginRequired>;
};

/** What a tool returns when its person has to log in first. The channel shows
 * `authorizeUrl` (see the channel contract's `detectLoginRequired`); the model
 * only reads `error`, which never contains the link. */
export type LoginRequired =
  | { ok: false; loginRequired: true; service: string; authorizeUrl: string; error: string }
  | { ok: false; error: string };

/**
 * How a plugin acting as `person` logs one in, for a person who isn't at the
 * service's machine: `start` begins the login for `personKey` (a user key)
 * with the link back to Mercury that the provider redirects to, and returns
 * the link the person opens and the `state` the provider sends back with the
 * code; `complete` finishes it with that code. The core keeps which person a
 * `state` belongs to, so `complete` only ever runs for the person who started.
 */
export type PersonLogin = {
  start: (
    personKey: string,
    callbackUrl: string,
  ) => Promise<{ ok: true; authorizeUrl: string; state: string } | { ok: false; error: string }>;
  complete: (personKey: string, code: string, state: string) => Promise<{ ok: true } | { ok: false; error: string }>;
};

/**
 * The env/model-dependent half of a plugin's contributions, produced by
 * `build()` (which may be async, e.g. to validate its own config before
 * building its tool). Every field optional: a plugin may contribute nothing.
 *
 * - `postProcess`: the result transform for the plugin's own tool (see
 *   `CliPostProcessor`). A formatter decorator may wrap it to render a display;
 *   the composition then hands the final one to `sessionTools` (which is why the
 *   factory takes it as an argument rather than closing over it — the wrapping
 *   happens after `build()` returns).
 * - `sessionTools`: builds the plugin's model-facing tools for one turn, given
 *   the session context and the plugin's (possibly decorated) post-processor.
 *   This is how a tool reaches the model without the core knowing what it is.
 * - `toolStatusDescribers`: one per tool name the plugin contributes, turning a
 *   tool call's input into the one-line status shown while it runs — so the core
 *   can label a plugin's tool without knowing it's a CLI.
 * - `postTurnGuards`: run over the model's finished text (see `PostTurnGuard`).
 * - `login`: how a plugin acting as `person` logs one in (see `PersonLogin`).
 */
export type PluginRuntimeContributions = {
  postProcess?: CliPostProcessor;
  login?: PersonLogin;
  sessionTools?: (ctx: SessionToolContext, postProcess?: CliPostProcessor) => Record<string, Tool>;
  toolStatusDescribers?: Record<string, (input: unknown) => string>;
  postTurnGuards?: PostTurnGuard[];
};

/**
 * A CLI command about to run, as the status describer sees it: the binary, the
 * argv after it, and whether the command mutates state (the core computes this
 * from the allowlist and passes it in, so a custom describer can vary read vs
 * write without re-deriving it).
 */
export type CliCommandInfo = { binary: string; args: string[]; mutating: boolean };

/** Turns a command about to run into the one-line status content shown while it
 * runs. A plugin may supply one to `createCliStatusDescriber` (see
 * `@mercury-fw/cli-engine`) to override the default; the core only transports the
 * result, the channel decides how to render it. */
export type StatusDescriber = (cmd: CliCommandInfo) => string;

/**
 * The default status content for a CLI command, used for every command unless a
 * plugin overrides it. A plain "esecuzione <binary> <sottocomando>", where the
 * subcommand is the leading non-flag tokens capped at two — deliberately not a
 * read/write classification. A plugin that wants finer wording supplies its own
 * `StatusDescriber`.
 */
export const defaultStatusLabel: StatusDescriber = ({ binary, args }) => {
  const sub: string[] = [];
  for (const a of args) {
    if (a.startsWith("-")) break;
    sub.push(a);
    if (sub.length === 2) break;
  }
  return sub.length > 0 ? `esecuzione ${binary} ${sub.join(" ")}` : `esecuzione ${binary}`;
};

/**
 * A skill in the Anthropic Agent Skills sense: a `name` and a one-line
 * `description` that stay in the system prompt so the model knows the capability
 * exists, plus a `body` (the voluminous "how to" — conventions, flags, examples)
 * loaded on demand only when a request matches. A plugin declares its skills via
 * `Plugin.skills`; `parseSkill` reads them from the standard `SKILL.md` shape.
 */
export type Skill = { name: string; description: string; body: string };

/**
 * Parses the Anthropic Agent Skills `SKILL.md` shape — frontmatter fenced by
 * `---` lines carrying at least `name` and `description`, then the markdown
 * body — into a `Skill`. A deliberately tiny hand-rolled parser (no yaml
 * dependency, so this package stays dependency-free): it reads only `name` and
 * `description` from the frontmatter and takes everything after the closing
 * fence as the body verbatim. Throws when the frontmatter or either required
 * field is missing, so a malformed skill fails loudly at load.
 */
export function parseSkill(markdown: string): Skill {
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(markdown);
  if (!match) {
    throw new Error("SKILL.md is missing its frontmatter (--- name/description ---)");
  }
  const [, frontmatter = "", body = ""] = match;
  const fields: Record<string, string> = {};
  for (const line of frontmatter.split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    if (key) fields[key] = line.slice(idx + 1).trim();
  }
  const name = fields.name;
  const description = fields.description;
  if (!name || !description) {
    throw new Error("SKILL.md frontmatter must set both name and description");
  }
  return { name, description, body: body.trim() };
}

/**
 * Reserved slot. A plugin may declare a persistent surface that lives *outside*
 * a turn — a Figma canvas, a configuration view — as data only: a `type` the
 * hosting UI recognizes, an `address` to reach it, and opaque `params`. Never
 * frontend code, never a component; a UI that doesn't know the `type` simply
 * doesn't show it. Distinct from per-turn output (status, lists, cards), which
 * already flows through the core's sink — a plugin exposes nothing for that.
 * Jira declares none; the shape is a placeholder until a real surface plugin
 * (Figma) nails it down.
 */
export type PluginSurface = {
  type: string;
  address: string;
  params?: Record<string, unknown>;
};

/**
 * The plugin module: the single value the core's loader consumes. A plugin
 * package exports one as a plain object — it must not import the app it plugs
 * into, so compatibility is checked where the core's plugin list is typed
 * against this.
 *
 * - `apiVersion`: the contract version this plugin was built against (see
 *   `PLUGIN_API_VERSION`). Mandatory; the loader refuses a mismatch.
 * - `name`: the plugin's name, what `dependsOn` and the logs refer to it by; for a CLI plugin, the binary it owns.
 * - `dependsOn`: names of plugins this one requires present. The loader loads
 *   dependencies first and skips this plugin fail-soft if any is absent or
 *   failed (see `loadPlugins`). Presence + ordering only — a dependency shares
 *   its capability through the usual registries, not a handle injected here.
 *   Absent/empty ⇒ no dependency.
 * - `systemPromptFragment`: the tool-surface description spliced into the
 *   system prompt when the plugin is active.
 * - `build`: the env/model-dependent contributions (its tool, post-processors,
 *   status describers, guards). A plugin that owns a CLI tool validates its own
 *   allowlist here (schema only — its pinned binary is co-shipped) before
 *   building the tool.
 * - `skills`: Agent-Skills the plugin contributes (see `Skill`); their
 *   descriptors go in the system prompt, their bodies load on demand.
 * - `surfaces`: reserved (see `PluginSurface`); absent for a plugin with none.
 * - `actsAs`: whose identity the plugin's tools act with at the service they
 *   reach. `"person"`: the person the turn is for, who logs in to it through
 *   Mercury (the plugin contributes `login`). `"mercury"`: Mercury's own
 *   service identity, whoever asks. Undeclared counts as `"mercury"`. A
 *   `"mercury"` plugin is offered to people only once they hold the
 *   permission to make Mercury act as itself, which doesn't exist yet: until
 *   then it's offered on the terminal only, where its prompt fragment, skills
 *   and tools stay.
 *
 * A plugin no longer carries a raw `cliConfig`: the core knows nothing about
 * CLIs. A CLI-based plugin owns its allowlist and, using `@mercury-fw/cli-engine`,
 * builds its own tool in `build()` — the core just collects the contributed
 * tools.
 */
export type Plugin = {
  apiVersion: number;
  name: string;
  dependsOn?: string[];
  systemPromptFragment?: string;
  build?: (ctx: PluginRuntimeContext) => PluginRuntimeContributions;
  skills?: Skill[];
  surfaces?: PluginSurface[];
  actsAs?: "person" | "mercury";
};
