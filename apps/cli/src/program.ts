/**
 * The `mfw` command line, declared with commander: every command, its
 * arguments and options, and the help for each level (`mfw --help`,
 * `mfw vault --help`, `mfw vault write-curated --help`). Parsing and
 * validation happen here, before anything runs; what a command does lives in
 * `create` (passed in) and `app/commands.ts`.
 */
import { Argument, Command, CommanderError, InvalidArgumentError, Option, type OutputConfiguration } from "commander";
import { toCreateArgs, type CreateArgs, type CreateOptions } from "./args.ts";
import { appCommands, RESET_TARGETS, type ResetTarget } from "./app/commands.ts";
import { CATALOG } from "./catalog.ts";
import { cliVersion } from "./versions.ts";
import { DEFAULT_ASSISTANT_NAME, DEFAULT_ROLE } from "./wizard.ts";

/** The commands that operate an app, bound to it. */
export type AppCommands = ReturnType<typeof appCommands>;

export type ProgramHandlers = {
  /** `mfw create`; returns the exit code. */
  create: (args: CreateArgs) => Promise<number>;
  /** `mfw upgrade`; returns the exit code. */
  upgrade: () => Promise<number>;
  /** The app the app commands act on; throws outside one. */
  app: () => AppCommands;
};

/** A parser for `flag`'s value: a positive whole number, kept as typed. */
function positiveInt(flag: string): (value: string) => string {
  return (value) => {
    if (!/^\d+$/.test(value) || Number(value) < 1) {
      throw new InvalidArgumentError(`${flag} takes a positive whole number (got "${value}").`);
    }
    return value;
  };
}

/** The help's closing paragraph for the commands that run inside an app. */
const INSIDE_AN_APP = "\nRun it from the app's folder or any folder under it (the one holding mercury.config.ts).";

/** Builds the `mfw` program; every action stores its exit code in `result`. */
function buildProgram(handlers: ProgramHandlers, result: { code: number }): Command {
  const program = new Command("mfw")
    .description("The Mercury command-line tool: creates an app, then runs it.")
    .version(cliVersion(), "-V, --version")
    .showSuggestionAfterError()
    .helpCommand(false);
  const inApp = (run: (app: AppCommands) => Promise<number>) => async () => {
    result.code = await run(handlers.app());
  };

  program
    .command("create")
    .summary("writes a new Mercury app")
    .description(
      "Writes a new Mercury app into <folder>, which has to be missing or empty (its own name is turned into kebab case). Without options it asks for the app name, the assistant's name and role, and which channels (with the HTTP channel's auth provider) and tool plugins to include; then it writes mercury.config.ts for that selection, the persona (persona/identity.md, persona/tone.md), the service and REPL entrypoints, a Dockerfile, a compose file with Qdrant, and an env example listing every variable the app reads. Then it runs bun install, and creates a git repository on main with a first commit, adding the origin when given (nothing is pushed).",
    )
    .argument("<folder>", "where to write the app")
    .option("--name <name>", "app name, as in package.json (default: the folder's name)")
    .option("--assistant-name <name>", `the assistant's name (default: ${DEFAULT_ASSISTANT_NAME})`)
    .option("--role <text>", `completes "You are <name>, …" (default: ${DEFAULT_ROLE})`)
    .option(
      "--channels <ids>",
      `comma-separated: ${CATALOG.filter((e) => e.kind === "channel").map((e) => e.id).join(", ")}`,
    )
    .option("--plugins <ids>", `comma-separated: ${CATALOG.filter((e) => e.kind === "tool").map((e) => e.id).join(", ")}`)
    .option(
      "--auth <id>",
      `the HTTP channel's auth provider, required with it: ${CATALOG.filter((e) => e.kind === "auth").map((e) => e.id).join(", ")}`,
    )
    .option("--git-remote <url>", "the repository's origin, taken as typed (default: none)")
    .option(
      "--local-packages <folder>",
      "install the packages packed in <folder> (bun pm pack) instead of the registry's, taking their versions from the tarballs, as mfw local-packages does",
    )
    .option("--no-install", "don't run bun install")
    .option("--no-git", "don't create the git repository")
    .option("-y, --yes", "don't ask: use the flags and the defaults")
    .addHelpText(
      "after",
      `
The framework packages get this CLI's version; each chosen plugin or channel
its latest on the registry (https://registry.npmjs.org, or MFW_REGISTRY).

Examples:
  mfw create my-agent
  mfw create my-agent --assistant-name Hermes --channels http --auth oidc --plugins jira --yes`,
    )
    .action(async (folder: string, opts: CreateOptions) => {
      result.code = await handlers.create(toCreateArgs(folder, opts));
    });

  program
    .command("upgrade")
    .summary("updates the global mfw")
    .description(
      "Installs the registry's latest mfw globally (bun add -g @mercury-fw/cli@<latest>), when it's newer than this one. An app's own framework, its CLI included, is upgraded with bun update in the app.",
    )
    .action(async () => {
      result.code = await handlers.upgrade();
    });

  // commander reads --no-cache as "cache: false"; the commands take noCache.
  const cacheOff = (opts: { cache: boolean }) => ({ noCache: !opts.cache });

  program
    .command("start")
    .summary("builds and starts the app")
    .description(
      "Builds the app's image and starts the app and Qdrant in the background. Only what changed is rebuilt, and only what changed (image, .env, compose file) is recreated.",
    )
    .addOption(new Option("--no-cache", "rebuild everything from scratch"))
    .addHelpText("after", INSIDE_AN_APP)
    .action(async (opts: { cache: boolean }) => inApp((app) => app.start(cacheOff(opts)))());

  program
    .command("stop")
    .summary("stops the app")
    .description("Stops the app and Qdrant and removes their containers. The volumes (memory, wiki, CLI credentials) stay.")
    .addHelpText("after", INSIDE_AN_APP)
    .action(inApp((app) => app.stop()));

  program
    .command("restart")
    .summary("rebuilds and restarts the app")
    .description("Like mfw start, but recreates the containers even when nothing changed: a clean restart.")
    .addOption(new Option("--no-cache", "rebuild everything from scratch"))
    .addHelpText("after", INSIDE_AN_APP)
    .action(async (opts: { cache: boolean }) => inApp((app) => app.restart(cacheOff(opts)))());

  program
    .command("logs")
    .summary("follows the logs")
    .description("Follows the logs of every service, or only of [service].")
    .argument("[service]", "mercury or qdrant")
    .addHelpText("after", INSIDE_AN_APP)
    .action(async (service: string | undefined) => inApp((app) => app.logs(service))());

  program
    .command("repl")
    .summary("opens the dev REPL")
    .description("Opens the dev REPL, a terminal conversation with the assistant, in a one-off container. A running app isn't touched.")
    .addHelpText("after", INSIDE_AN_APP)
    .action(inApp((app) => app.repl()));

  program
    .command("shell")
    .summary("opens a shell in the app's container")
    .description("Opens a shell in the app's container: the running one if the app is up, otherwise a one-off container.")
    .addHelpText("after", INSIDE_AN_APP)
    .action(inApp((app) => app.shell()));

  const vault = program
    .command("vault")
    .summary("wiki vault maintenance")
    .description(
      "Maintains the wiki vault, in a one-off container on the vault's volume. Paths are vault-relative, as mfw vault list prints them (curated/…, raw/…).",
    )
    .helpCommand(false)
    .addHelpText("after", INSIDE_AN_APP);
  vault
    .command("list")
    .summary("every note")
    .description("Lists every note.")
    .action(async () => inApp((app) => app.vault(["list"]))());
  vault
    .command("read")
    .summary("a note")
    .description("Prints a note.")
    .argument("<path>", "the note, vault-relative")
    .action(async (path: string) => inApp((app) => app.vault(["read", path]))());
  vault
    .command("grep")
    .summary("lines matching a pattern")
    .description("Prints every line matching <pattern> (a regular expression) as path:line:text.")
    .argument("<pattern>", "a regular expression; after --, one starting with - too")
    .action(async (pattern: string) => inApp((app) => app.vault(["grep", pattern]))());
  vault
    .command("write-curated")
    .summary("writes a curated note from stdin")
    .description("Writes a curated note, the body read from stdin.")
    .argument("<path>", "curated/…, vault-relative")
    .option("--author <name>", "who wrote it")
    .addHelpText("after", "\nExample:\n  cat note.md | mfw vault write-curated curated/standards/new-note.md --author luca")
    .action(async (path: string, opts: { author?: string }) =>
      inApp((app) => app.vault(["write-curated", path, ...(opts.author === undefined ? [] : ["--author", opts.author])]))(),
    );
  vault
    .command("write-raw")
    .summary("writes raw material from stdin")
    .description("Writes raw material for the nightly review to triage, the body read from stdin.")
    .argument("<path>", "raw/…, vault-relative")
    .action(async (path: string) => inApp((app) => app.vault(["write-raw", path]))());

  const memory = program
    .command("memory")
    .summary("reads Layer-3 memory")
    .description("Reads Layer-3 memory on Qdrant, in a one-off container. Read-only.")
    .helpCommand(false)
    .addHelpText("after", INSIDE_AN_APP);
  memory
    .command("list")
    .summary("the collections and their points")
    .description("Lists the collections and how many points each holds.")
    .action(async () => inApp((app) => app.memory(["list"]))());
  memory
    .command("read")
    .summary("a collection's points")
    .description(
      "Prints a collection's points, each as its id and one line per payload field: newest first where the collection has a timestamp index, in Qdrant's own order otherwise.",
    )
    .argument("<collection>", "as mfw memory list prints it")
    .option("--limit <n>", "how many points (default: 20)", positiveInt("--limit"))
    .action(async (collection: string, opts: { limit?: string }) =>
      inApp((app) => app.memory(["read", collection, ...(opts.limit === undefined ? [] : ["--limit", opts.limit])]))(),
    );

  program
    .command("reset")
    .summary("deletes memory or the wiki, after confirmation")
    .description(
      "Deletes for good what the assistant remembers: memory is every Qdrant collection, wiki the whole vault. It asks you to type the app's name first (anything else deletes nothing), then brings the service back up empty.",
    )
    .addArgument(new Argument("<target>", "what to delete").choices(Object.keys(RESET_TARGETS)))
    .addHelpText("after", INSIDE_AN_APP)
    .action(async (target: ResetTarget) => inApp((app) => app.reset(target))());

  const credentials = program
    .command("credentials")
    .summary("the login of a plugin's CLI")
    .description(
      "For a tool plugin whose CLI keeps its login in a folder (under ~/.config, or elsewhere in the home), and declares it with the commands that set it up (mercury.cliCredentials in its package.json): the commands run in a one-off container of the app, so the CLI writes its login straight onto the credentials volume, where it stays across redeploys. Every environment (development, production) sets up its own.",
    )
    .helpCommand(false)
    .addHelpText("after", INSIDE_AN_APP);
  credentials
    .command("setup")
    .summary("sets up a CLI's login in the app's container")
    .description(
      "Runs the setup the plugin declares for its CLI's service identity (the identity Mercury acts as), in a one-off container on your terminal: the CLI asks for what it needs, and its login lands on the credentials volume. People log in on their own later, through Mercury.",
    )
    .argument("<plugin>", "the plugin's package (@mercury-fw/plugin-jira) or its CLI's folder as declared (jira-cli)")
    .action(async (plugin: string) => inApp((app) => app.credentialsSetup(plugin))());
  credentials
    .command("check")
    .summary("checks a CLI's login")
    .description("Runs the check the plugin declares for its CLI's login (its doctor, for the first-party plugins), in a one-off container.")
    .argument("<plugin>", "the plugin's package or its CLI's folder")
    .action(async (plugin: string) => inApp((app) => app.credentialsCheck(plugin))());
  credentials
    .command("reset")
    .summary("logs an identity out of a CLI")
    .description(
      "Runs the logout the plugin declares for its CLI, after you type the folder's name: of the service identity, which then needs mfw credentials setup again, or with --user of one person, who logs in again through Mercury the next time they need it. Local only: the tokens aren't revoked at the service.",
    )
    .argument("<plugin>", "the plugin's package or its CLI's folder")
    .option("--user <key>", "the person to log out, by their user key (<provider>:<id>, e.g. oidc:312345678901234567)")
    .action(async (plugin: string, opts: { user?: string }) =>
      inApp((app) => app.credentialsReset(plugin, opts.user === undefined ? {} : { user: opts.user }))(),
    );

  const googleChat = program
    .command("google-chat")
    .summary("the Google Chat channel's setup")
    .description("Sets up the Google Chat channel of an app that has it.")
    .helpCommand(false)
    .addHelpText("after", INSIDE_AN_APP);
  googleChat
    .command("set-key")
    .summary("writes the Chat app's key into the env file")
    .description(
      "Reads the service account key file gcloud iam service-accounts keys create writes, and sets GOOGLE_CHAT_APP_CLIENT_EMAIL and GOOGLE_CHAT_APP_PRIVATE_KEY in the app's env file (the key on one line), plus GOOGLE_CHAT_PUBSUB_SUBSCRIPTION with --subscription. Older values are replaced, the key is never printed. Delete the key file afterwards.",
    )
    .argument("<key-file>", "the service account's JSON key")
    .option("--subscription <name>", "projects/<project>/subscriptions/<name>, the subscription the Chat app's events arrive on")
    .addHelpText(
      "after",
      "\nExample:\n  mfw google-chat set-key key.json --subscription projects/my-project/subscriptions/mercury-chat-sub",
    )
    .action(async (keyFile: string, opts: { subscription?: string }) =>
      inApp((app) =>
        app.googleChatSetKey(keyFile, opts.subscription === undefined ? {} : { subscription: opts.subscription }),
      )(),
    );

  program
    .command("local-packages")
    .summary("installs @mercury-fw packages from local tarballs")
    .description(
      "Makes the app install the packages in <folder>'s tarballs (bun pm pack) instead of the registry's: copies them into .packs/ (the image copies it too), points each package at its tarball with overrides in package.json, so packages that depend on it get it as well, and runs bun install. Run it again after packing anew. --off removes them and installs from the registry.",
    )
    .argument("[folder]", "the folder holding the .tgz files")
    .option("--off", "go back to the registry's packages")
    .addHelpText("after", `\nExamples:\n  mfw local-packages ../mercury-fw/apps/testbed/.packs\n  mfw local-packages --off${INSIDE_AN_APP}`)
    .action(async (folder: string | undefined, opts: { off?: boolean }) => {
      if ((folder === undefined) === (opts.off !== true)) throw new Error("local-packages takes a folder of tarballs, or --off");
      await inApp((app) => (folder === undefined ? app.localPackagesOff() : app.localPackages(folder)))();
    });

  program
    .command("e2e")
    .summary("runs the app's end-to-end tests against its model")
    .description(
      "Runs e2e tests: each case's turns go to the app's real model through its REPL (in the container, like mfw repl), and its checks run on the tool calls each turn made and the answer it gave. Without files, every e2e/*.e2e.ts in the app. Prints every check, exits 1 when a case didn't pass enough runs, and keeps the turns and checks in e2e/results/<time>/. The app must be built and its env file filled in, as for mfw repl.",
    )
    .argument("[tests...]", "test files (default: e2e/*.e2e.ts)")
    .option("--repeat <n>", "runs of each case, overriding its own repeat", positiveInt("--repeat"))
    .addHelpText("after", `\nExamples:\n  mfw e2e\n  mfw e2e e2e/jira.e2e.ts --repeat 3${INSIDE_AN_APP}`)
    .action(async (tests: string[], opts: { repeat?: string }) =>
      inApp((app) => app.e2e(tests, opts.repeat === undefined ? {} : { repeat: Number(opts.repeat) }))(),
    );

  return program;
}

/** Runs `mfw` on `argv` (the arguments after the command name) and returns
 * the exit code. Commander's own messages (help, errors) go to `output`, and
 * so does the message of an error a command throws. */
export async function runProgram(argv: string[], handlers: ProgramHandlers, output?: OutputConfiguration): Promise<number> {
  const result = { code: 0 };
  const program = buildProgram(handlers, result);
  const writeErr = output?.writeErr ?? ((s: string) => process.stderr.write(s));
  const configure = (cmd: Command): void => {
    cmd.exitOverride();
    if (output !== undefined) cmd.configureOutput(output);
    cmd.commands.forEach(configure);
  };
  configure(program);
  if (argv.length === 0) {
    program.outputHelp({ error: true });
    return 1;
  }
  try {
    await program.parseAsync(argv, { from: "user" });
    return result.code;
  } catch (err) {
    if (err instanceof CommanderError) return err.exitCode;
    writeErr(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}
