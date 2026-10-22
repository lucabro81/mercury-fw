/// <reference path="./template.d.ts" />
/**
 * Turns the wizard's answers into the new app's files, as a `path → content`
 * map, without touching the disk (`write.ts` does that). The static files come
 * from `template/` imported as text, so they are bundled with the CLI; the
 * config (with the persona), the manifest, the env example, the compose file
 * and the README are generated from the selection. Channels and plugins are always
 * written in catalog order, whatever order they were chosen in; the auth
 * provider, when there is one, after the channels.
 */
import { DEFAULT_PERSONA_TONE, assistantNameOf } from "@mercury-fw/core";
import { CATALOG, type CatalogEntry, type EnvVar } from "./catalog.ts";
import indexTs from "../template/src/index.ts.tpl" with { type: "text" };
import replTs from "../template/src/repl.ts.tpl" with { type: "text" };
import tsconfigJson from "../template/tsconfig.json.tpl" with { type: "text" };
import bunfigToml from "../template/bunfig.toml.tpl" with { type: "text" };
import gitignore from "../template/gitignore.tpl" with { type: "text" };
import dockerignore from "../template/dockerignore.tpl" with { type: "text" };
import dockerfile from "../template/Dockerfile.tpl" with { type: "text" };

/** What the new app is made of. `versions` maps each package the app depends
 * on to the version its range is written against. */
export type RenderInput = {
  name: string;
  assistantName: string;
  role: string;
  channels: string[];
  plugins: string[];
  /** The HTTP channel's auth provider: required with it, refused without it. */
  auth?: string;
  /** The user directory: who the people are and their roles. */
  directory?: string;
  versions: Record<string, string>;
};

/** An app name that is a valid unscoped npm name and a valid prefix for the
 * compose volume names. */
const APP_NAME = /^[a-z0-9][a-z0-9._-]*$/;
const APP_NAME_MAX = 214;

/** The variables the core reads, first in every app's env example. */
const CORE_ENV: EnvVar[] = [
  {
    name: "OLLAMA_HOST",
    comment: "Model endpoint (Ollama-compatible). Ollama running on the Docker host is host.docker.internal.",
    value: "http://host.docker.internal:11434",
  },
  { name: "OLLAMA_MODEL", comment: "Chat model the assistant runs on" },
  { name: "OLLAMA_EMBEDDING_MODEL", comment: "Embedding model for the episodic memory", value: "nomic-embed-text" },
  { name: "QDRANT_URL", comment: "Qdrant, the compose service", value: "http://qdrant:6333" },
  { name: "WIKI_VAULT_PATH", comment: "Wiki vault, the named volume's mount point", value: "/app/wiki-vault" },
  {
    name: "TURN_STALL_TIMEOUT_MS",
    comment: "How long a streaming turn waits for the model's next token before it's stopped with an error (0 turns it off)",
    value: "120000",
  },
];

const CONFIG_HEADER = `/**
 * This app's composition: the tool plugins and channels it runs, the auth
 * provider when a channel needs one, how the lists its plugins hand over read,
 * the assistant's persona and the languages it speaks (\`i18n\`: a file per
 * language in \`locales/\`, \`en.json\` overriding the English texts). The entrypoints
 * (\`src/index.ts\`, \`src/repl.ts\`) hand this config to \`composeMercury\`.
 *
 * Every tool plugin and channel declared here is active.
 */`;

/** Builds every file of the new app. Throws on an invalid app name, an empty
 * assistant name or role, an id the catalog doesn't have, or a package with no
 * version in `input.versions`. */
export function renderApp(input: RenderInput): Map<string, string> {
  validate(input);
  const channels = selected("channel", input.channels);
  const tools = selected("tool", input.plugins);
  const auth = selected("auth", input.auth === undefined ? [] : [input.auth])[0];
  const directory = selected("directory", input.directory === undefined ? [] : [input.directory])[0];
  const assistantName = input.assistantName.trim();

  const extraFiles = [...channels, ...tools].flatMap((e) => Object.entries(e.files ?? {}));
  const services = tools.flatMap((t) => (t.service ? [t.service] : []));
  return new Map([
    ...extraFiles,
    [".dockerignore", dockerignore],
    [".env.example", renderEnv(channels, auth, tools, directory)],
    [".gitignore", gitignore],
    ["Dockerfile", dockerfile],
    ["README.md", renderReadme(input.name, channels, auth, tools, directory)],
    ["bunfig.toml", bunfigToml],
    ["docker-compose.yml", renderCompose(input.name, channels.some((c) => c.id === "http"), services)],
    ["locales/en.json", renderEnglish(tools)],
    ["mercury.config.ts", renderConfig(assistantName, input.role, channels, auth, tools, directory)],
    ["package.json", renderPackageJson(input.name, channels, auth, tools, input.versions, directory)],
    ["src/index.ts", indexTs],
    ["src/repl.ts", replTs],
    ["tsconfig.json", tsconfigJson],
  ]);
}

/** Why `name` can't be an app name, or undefined when it can. Shared with the
 * wizard, which checks the name as it's typed. */
export function appNameError(name: string): string | undefined {
  if (!APP_NAME.test(name) || name.length > APP_NAME_MAX) {
    return `Invalid app name "${name}": lowercase letters, digits, ".", "_" and "-", starting with a letter or digit`;
  }
  return undefined;
}

/** Rejects what would produce a broken app, naming the valid choices. */
function validate(input: RenderInput): void {
  const nameError = appNameError(input.name);
  if (nameError !== undefined) {
    throw new Error(nameError);
  }
  if (!input.assistantName.trim()) {
    throw new Error("The assistant name can't be empty");
  }
  if (!input.role.trim()) {
    throw new Error("The assistant's role can't be empty");
  }
  if (/[\r\n]/.test(input.assistantName) || /[\r\n]/.test(input.role)) {
    throw new Error("The assistant name and role must each be one line");
  }
  // What the app would refuse at startup.
  assistantNameOf({ name: input.assistantName });
  const selection =
    selectionError(input.channels, input.plugins, input.auth, input.directory) ?? pairingError(input.channels, input.auth);
  if (selection !== undefined) {
    throw new Error(selection);
  }
}

/** The ids of the catalog entries of `kind`. */
const idsOf = (kind: CatalogEntry["kind"]): string[] => CATALOG.filter((e) => e.kind === kind).map((e) => e.id);

/** Names the first channel, plugin, auth provider or directory id the catalog
 * doesn't have, with the valid ones, or undefined when all are known. Shared
 * with the command, which checks the flags before asking anything. */
export function selectionError(channels: string[], plugins: string[], auth?: string, directory?: string): string | undefined {
  for (const [kind, ids, label] of [
    ["channel", channels, "channel"],
    ["tool", plugins, "plugin"],
    ["auth", auth === undefined ? [] : [auth], "auth provider"],
    ["directory", directory === undefined ? [] : [directory], "directory"],
  ] as const) {
    const valid = idsOf(kind);
    const unknown = ids.find((id) => !valid.includes(id));
    if (unknown !== undefined) {
      return `Unknown ${label} "${unknown}" (valid: ${valid.join(", ")})`;
    }
  }
  return undefined;
}

/** What's wrong with pairing the HTTP channel and the auth provider: it
 * doesn't start without one, and one without it has nothing to authenticate.
 * Undefined when they go together. Shared with the command, which checks it
 * before writing when nothing will ask (`--yes`). */
export function pairingError(channels: string[], auth?: string): string | undefined {
  const http = channels.includes("http");
  if (http && auth === undefined) return `The http channel needs an auth provider (valid: ${idsOf("auth").join(", ")})`;
  if (!http && auth !== undefined) return `The auth provider "${auth}" goes with the http channel, which isn't chosen`;
  return undefined;
}

/** The catalog entries of `kind` among `ids`, deduplicated, in catalog order. */
function selected(kind: CatalogEntry["kind"], ids: string[]): CatalogEntry[] {
  return CATALOG.filter((e) => e.kind === kind && ids.includes(e.id));
}

/** What the core's persona texts write where the assistant's name goes. */
const ASSISTANT = "{{assistant}}";

/** `text` as the inside of a template literal: backslashes, backticks and `${` stay text. */
function templateText(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
}

/** One line of the persona as config source: a template literal referring to
 * the config's `name` where the line names the assistant, a string otherwise. */
function personaLine(line: string): string {
  if (!line.includes(ASSISTANT)) return JSON.stringify(line);
  return `\`${line.split(ASSISTANT).map(templateText).join("${name}")}\``;
}

/** The config's `persona`: the name, the role as the identity, and the core's
 * default tone written out line by line, so the whole persona is there to edit. */
function renderPersona(role: string): string[] {
  return [
    "  persona: {",
    "    name,",
    `    identity: ${personaLine(`You are ${ASSISTANT}, ${role.trim().replace(/\.+$/, "")}.`)},`,
    "    tone: [",
    ...DEFAULT_PERSONA_TONE.split("\n").map((line) => `      ${personaLine(line)},`),
    '    ].join("\\n"),',
    "  },",
  ];
}

/** `locales/en.json`: the English texts of the chosen plugins' starting
 * formatter rules (the app's own `app.` keys), `{}` when there are none. */
function renderEnglish(tools: CatalogEntry[]): string {
  const messages = Object.assign({}, ...tools.map((t) => t.formatter?.messages ?? {})) as Record<string, string>;
  return Object.keys(messages).length === 0 ? "{}\n" : `${JSON.stringify(messages, null, 2)}\n`;
}

/** `mercury.config.ts`: imports, the assistant's name, the formatter helpers of
 * the plugins that have any, then the config with the persona, each plugin
 * (wrapped in the formatter when it has starting rules) and channel. */
function renderConfig(
  assistantName: string,
  role: string,
  channels: CatalogEntry[],
  auth: CatalogEntry | undefined,
  tools: CatalogEntry[],
  directory: CatalogEntry | undefined,
): string {
  const withRules = tools.filter((t) => t.formatter);
  const imports = ['import { defineMercuryConfig } from "@mercury-fw/core";', 'import en from "./locales/en.json";'];
  if (withRules.length > 0) {
    imports.push('import { formatterPlugin, formatter } from "@mercury-fw/formatter";');
  }
  for (const t of tools) {
    const names = t.formatter ? `${t.exportName}, type ${t.formatter.displaysType}` : t.exportName;
    imports.push(`import { ${names} } from "${t.package}";`);
    for (const extra of t.build?.imports ?? []) imports.push(`import { ${extra.names} } from "${extra.package}";`);
  }
  for (const c of [...channels, ...(auth ? [auth] : []), ...(directory ? [directory] : [])]) {
    imports.push(`import { ${c.exportName} } from "${c.package}";`);
  }

  const helpers = withRules.map((t) => `${t.formatter?.helpers}\n\n`).join("");

  const plugins =
    tools.length === 0
      ? "  plugins: [],"
      : ["  plugins: [", ...tools.map(renderPluginEntry), "  ],"].join("\n");
  const channelList = `  channels: [${channels.map((c) => c.exportName).join(", ")}],`;

  return [
    CONFIG_HEADER,
    ...imports,
    "",
    "/** The assistant's name: what the persona calls it, and every text the model reads. */",
    `const name = ${JSON.stringify(assistantName)};`,
    "",
    `${helpers}export default defineMercuryConfig({`,
    ...renderPersona(role),
    plugins,
    channelList,
    ...(auth ? [`  auth: ${auth.exportName},`] : []),
    ...(directory ? [`  directory: ${directory.exportName},`] : []),
    "  i18n: { locales: { en } },",
    "});",
    "",
  ].join("\n");
}

/** One element of the config's `plugins` array. */
function renderPluginEntry(t: CatalogEntry): string {
  if (t.build) return `${t.build.expression},`;
  if (!t.formatter) {
    return `    ${t.exportName},`;
  }
  return [
    "    formatterPlugin(",
    `      ${t.exportName},`,
    `      formatter<${t.formatter.displaysType}>({`,
    ...t.formatter.rules.map((r) => `        ${r}`),
    "      }),",
    "    ),",
  ].join("\n");
}

/** The packages an entry brings into the app: its own, and those its config imports. */
export function entryPackages(e: CatalogEntry): string[] {
  return [e.package, ...(e.build?.imports ?? []).map((i) => i.package)];
}

/** `package.json`: the core, the formatter when a plugin is wrapped in it, the
 * chosen packages, and every tool plugin trusted to run its postinstall (it
 * downloads the plugin's CLI), plus what a chosen entry says it needs trusted. */
function renderPackageJson(
  name: string,
  channels: CatalogEntry[],
  auth: CatalogEntry | undefined,
  tools: CatalogEntry[],
  versions: Record<string, string>,
  directory: CatalogEntry | undefined,
): string {
  const chosen = [...channels, ...(auth ? [auth] : []), ...tools, ...(directory ? [directory] : [])];
  const packages = [...new Set(["@mercury-fw/core", ...chosen.flatMap(entryPackages)])];
  if (tools.some((t) => t.formatter)) {
    packages.push("@mercury-fw/formatter");
  }
  const dependencies: Record<string, string> = {};
  for (const pkg of packages.sort()) {
    const version = versions[pkg];
    if (version === undefined) {
      throw new Error(`No version known for ${pkg}`);
    }
    dependencies[pkg] = `^${version}`;
  }
  const cli = versions["@mercury-fw/cli"];
  if (cli === undefined) {
    throw new Error("No version known for @mercury-fw/cli");
  }
  const manifest: Record<string, unknown> = {
    name,
    version: "0.1.0",
    type: "module",
    private: true,
    // The app's own plugins, each a package of its own under plugins/.
    workspaces: ["plugins/*"],
    scripts: { start: "bun src/index.ts", repl: "bun src/repl.ts", typecheck: "tsc --noEmit", test: "bun test" },
    dependencies,
    // The CLI in the app itself, at the framework's version: a global `mfw`
    // hands the app's commands over to it.
    devDependencies: { "@mercury-fw/cli": `^${cli}`, "@types/bun": "^1.4.2", typescript: "^6.0.3" },
  };
  const trusted = [...new Set([...tools.map((t) => t.package), ...chosen.flatMap((e) => e.trusts ?? [])])];
  if (trusted.length > 0) {
    manifest.trustedDependencies = trusted.sort();
  }
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/** The env example: the core's variables, then a section per chosen entry
 * that reads any variable. */
function renderEnv(
  channels: CatalogEntry[],
  auth: CatalogEntry | undefined,
  tools: CatalogEntry[],
  directory: CatalogEntry | undefined,
): string {
  const block = (vars: EnvVar[]) => vars.map((v) => `# ${v.comment}\n${v.name}=${v.value ?? ""}`).join("\n");
  const sections = [block(CORE_ENV)];
  for (const entry of [...channels, ...(auth ? [auth] : []), ...tools, ...(directory ? [directory] : [])]) {
    if (entry.env.length > 0) {
      // A directory can share its id with a tool plugin of the same package.
      sections.push(`# --- ${entry.id}${entry.kind === "directory" ? " directory" : ""}\n${block(entry.env)}`);
    }
  }
  return `${sections.join("\n\n")}\n`;
}

/** `docker-compose.yml`: the app and Qdrant, with named volumes prefixed by the
 * app's name, the CLI credentials one included whatever was chosen (a plugin
 * with a CLI can come later); the HTTP surface's port published on the host
 * only with the HTTP channel; and the services chosen plugins need. */
function renderCompose(name: string, hasHttp: boolean, services: Array<{ name: string; lines: string[] }>): string {
  const httpPort = hasHttp
    ? [
        "    # The HTTP surface, on the host: every route but its OpenAPI document needs a token.",
        "    ports:",
        '      - "${HTTP_SURFACE_PORT:-4100}:${HTTP_SURFACE_PORT:-4100}"',
      ]
    : [];
  return [
    "services:",
    "  mercury:",
    "    build: .",
    "    # Back up after a crash or a host reboot.",
    "    restart: unless-stopped",
    "    env_file:",
    "      - path: .env",
    "        required: false",
    "    volumes:",
    "      - wiki-vault:/app/wiki-vault",
    "      # The login of a plugin's CLI, on a volume so what the CLI writes back",
    "      # (refreshed tokens) survives a redeploy: see README.md.",
    "      - cli-credentials:/home/mercury/.config",
    ...httpPort,
    "    extra_hosts:",
    '      - "host.docker.internal:host-gateway"',
    "    depends_on:",
    "      - qdrant",
    ...services.map((s) => `      - ${s.name}`),
    "",
    "  qdrant:",
    "    image: qdrant/qdrant:v1",
    "    volumes:",
    "      - qdrant-data:/qdrant/storage",
    "",
    ...services.flatMap((s) => [...s.lines, ""]),
    "volumes:",
    "  wiki-vault:",
    `    name: ${name}_wiki-vault`,
    "  qdrant-data:",
    `    name: ${name}_qdrant-data`,
    "  cli-credentials:",
    `    name: ${name}_cli-credentials`,
    "",
  ].join("\n");
}

/** The app's README: what it was scaffolded with and how to run it. */
function renderReadme(
  name: string,
  channels: CatalogEntry[],
  auth: CatalogEntry | undefined,
  tools: CatalogEntry[],
  directory: CatalogEntry | undefined,
): string {
  const list = (entries: CatalogEntry[]) => (entries.length > 0 ? entries.map((e) => e.id).join(", ") : "none");
  // What the app can't start without, named where the reader is about to start it.
  const required = [...channels, ...(auth ? [auth] : []), ...tools, ...(directory ? [directory] : [])]
    .flatMap((e) => e.env)
    .filter((v) => v.comment.startsWith("Required:"))
    .map((v) => `\`${v.name}\``);
  const requiredNote =
    required.length > 0 ? `\nBefore \`mfw start\`, fill in the variables the chosen pieces require: ${required.join(", ")}.\n` : "";
  return `# ${name}

A Mercury app, scaffolded by \`mfw create\`.

- Channels: ${list(channels)}
${auth ? `- Auth: ${auth.id}\n` : ""}- Tool plugins: ${list(tools)}
${directory ? `- Directory: ${directory.id}\n` : ""}
## Layout

- \`mercury.config.ts\`: what the app is made of (tool plugins, channels, how their lists read) and the assistant's persona: its name, who it is and how it answers. Edit them freely.
- \`locales/\`: the texts people see, one file per language the assistant speaks. \`en.json\` overrides the English ones; add \`it.json\` (and \`it\` to \`i18n.locales\` in the config) for Italian, \`i18n.defaultLocale\` for the language people get when they haven't picked one, \`i18n.timeZone\` (an IANA name such as \`Europe/Rome\`) for the time zone of whoever saved none and whose app says none. The app's own texts (a formatter rule's) are \`app.\` keys, written in English in \`en.json\` and translated in every other file. Mercury logs at startup the keys a file is missing.
- \`src/index.ts\`: the service (channels, crons). \`src/repl.ts\`: an interactive terminal for trying things out.
- \`plugins/\`: the app's own plugins, when it has any: each one a package in a folder of its own (\`plugins/<name>\`, a workspace), listed in \`dependencies\` as \`workspace:*\` and declared in \`mercury.config.ts\`. \`bun run test\` runs their tests.
- \`.env.example\`: every variable the app reads. Copy it to \`.env\` and fill it in.

## Running it

\`mfw\` is Mercury's command-line tool. Install it once, globally (\`mfw upgrade\` keeps it current), or put \`bunx\` in front of every command instead (\`bunx mfw start\`):

\`\`\`bash
bun add -g @mercury-fw/cli
\`\`\`

Then, in the app:

\`\`\`bash
bun install
cp .env.example .env
mfw start
mfw repl
\`\`\`
${requiredNote}
\`bun install\` here gives your editor, \`bun run typecheck\` and the app's own \`mfw\` (the one a global \`mfw\` runs inside the app) the packages (tool plugins download their CLI binary as they install); the image installs its own copy when it builds. \`mfw start\` builds the image and starts the app with Qdrant in the background, \`mfw repl\` opens a terminal conversation with the assistant. \`mfw --help\` lists the rest: stopping and restarting, logs, a shell in the container, the wiki and the memory, and resetting them.
${renderHttpSection(channels, auth)}${CREDENTIALS_SECTION}`;
}

/** The README section on the HTTP surface, for an app with the HTTP channel
 * (and so its auth provider); nothing without it. */
function renderHttpSection(channels: CatalogEntry[], auth: CatalogEntry | undefined): string {
  if (!channels.some((c) => c.id === "http") || auth === undefined) return "";
  return `
## HTTP surface

The HTTP channel listens on \`http://<host>:4100\`, the port in \`HTTP_SURFACE_PORT\` (the compose file publishes whatever port it holds on the host). Every route but its OpenAPI document needs \`Authorization: Bearer <token>\`, and the auth provider, \`${auth.id}\` (\`${auth.package}\`), decides who the token belongs to: its variables are in the env example. If the provider can't load, the channel doesn't start and the logs say why.
`;
}

/** The README section on CLI credentials: how a plugin whose CLI keeps its
 * login in a folder gets it into the container. Generic on purpose: a CLI is
 * a feature of some plugins, from any author, not something to list here. */
const CREDENTIALS_SECTION = `
## CLI credentials

Some tool plugins run a CLI. When that CLI keeps its login in a folder under your home and reads it at runtime to authenticate, the plugin declares that folder and the commands that set it up (\`mercury.cliCredentials\` in its \`package.json\`: a folder under \`~/.config\`, or a path anywhere under the home), and the login is set up inside the app's container, on your terminal:

\`\`\`bash
mfw credentials setup <plugin>
mfw credentials check <plugin>
\`\`\`

\`<plugin>\` is the plugin's package or its CLI's folder; a name the app doesn't have lists the ones it has. \`setup\` runs the CLI's own setup in a one-off container, so it asks you for what it needs and writes the login straight onto the \`cli-credentials\` volume (mounted on \`~/.config\`: a folder declared elsewhere in the home lives under \`~/.config/mercury-home\`, and its usual place links there). What the CLI writes back afterwards, like a refreshed token, stays on the volume across redeploys. Nothing goes in \`.env\`, and nothing is carried from one machine to another: every environment sets up its own, development with its credentials, production with its own.

To log an identity out, the one Mercury runs as or, with \`--user\`, one person:

\`\`\`bash
mfw credentials reset <plugin> [--user <key>]
\`\`\`

A CLI that authenticates any other way isn't covered by this, and nothing guarantees it works in Mercury; neither does one that deletes its own folder and makes it again, since that replaces the link.
`;
