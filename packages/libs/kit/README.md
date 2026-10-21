# @mercury-fw/kit

What a [Mercury](https://github.com/lucabro81/mercury-fw) plugin author imports: the contract a tool plugin implements (`Plugin`, `PLUGIN_API_VERSION` and the types around them) and the one a channel implements (`ChannelPlugin`, `CHANNEL_API_VERSION`), in one place. It carries no runtime, so a plugin that depends on it doesn't pull the framework in.

A plugin whose CLI keeps its login in a folder under the home, reading it from there at runtime, declares that folder in its `package.json`, by default under `~/.config`:

```json
{
  "mercury": {
    "cliCredentials": {
      "folder": "my-cli",
      "setup": ["my-cli", "init"],
      "check": ["my-cli", "doctor"],
      "logout": ["my-cli", "auth", "logout"]
    }
  }
}
```

or anywhere else under the home, with `{ "path": ".my-cli" }` instead of `folder` (relative to the home, inside it). Each command is a binary on the container's PATH followed by its arguments: `setup` sets up the identity the agent runs as and is required, `userSetup` (the app people log in through, logging nobody in), `check` and `logout` (of that identity, or of one person with `--user <id>`) are optional.

An app then runs `mfw credentials setup <plugin>`, which runs `setup` in a one-off container on the user's terminal, so the CLI asks for what it needs and writes its login straight onto a volume that keeps what the CLI writes back (a folder outside `~/.config` gets a link from its usual place to the volume). A CLI that authenticates any other way isn't covered by this, and neither is one that deletes its own folder and makes it again.

A plugin also says whose identity its tools act with (`actsAs`). `"person"`: the person the turn is for, who logs in to the service through Mercury; the plugin contributes a `login` (`start` and `complete`, which `createCliPersonLogin` from `@mercury-fw/cli-engine` builds for a CLI with a two-step remote login), and its tools get the person and `requireLogin` in their context (`createCliTool` takes both, adds `--user` to every command and asks for the login when the CLI exits with code 3). `"mercury"`, or nothing declared: Mercury's own identity, whoever asks, which only someone allowed to make Mercury act as itself may use: a person holding `mercury.act-as-self` (every plugin) or `mercury.act-as-self.<plugin>` (that one), and the terminal. Those people also get each tool of a plugin acting as the person a second time, as `<tool>AsSelf`, run with Mercury's identity. `"anyone"`: no identity at all, for a public service with no login (web search, for example). Everyone gets such a plugin, with no second version of its tools, and its tools still get the person the turn is for (on the terminal, the operator), to keep what belongs to each one; they can't ask for a login. Roles come from the directory the app declares (`DirectoryPlugin` in the channel contract: given who a channel says is talking, it returns the person and their roles, or `null` for someone it doesn't know).

Every plugin says what it lets the agent do in its `description`: one sentence, in English, for the model. The system prompt lists the plugins offered to the person with their descriptions, and the model answers "what can you do?" from that list. It says what, never how: how to use the plugin belongs to its fragment and skills. The core doesn't load a plugin without one.

The assistant has the name the app gives it (`persona.name`), so a plugin never writes one into what the model reads. Its fragment, its skills and its tools' descriptions say `{{assistant}}`, which the core replaces with that name. A text the plugin builds while running gets the name as `assistantName` in its `build()` context (a channel gets it in its runtime context too). Where the one acting is the system around the model (a list it appends, an account it picks), the text says "the system" and no name at all.

What a plugin shows the person in its own words (a status line while its tool runs, a choice's label, a heading it adds) is written once, in English, in the plugin's `messages`, every key under its name (`web-search.choice.once`); the core refuses a plugin with a key outside it, and `core` and `app` can't be plugin names (their keys are the core's and the app's). While a turn runs the plugin gets `t`, the texts of the person the turn is for, and asks for each text by its key: in `SessionToolContext.t`, as the second argument of a status describer, the third of a post-processor, and in a post-turn guard (`statusLabel(t)`, `run(text, steps, t)`). The app translates the keys in its language files. The core's own keys (`core.…`) are always there, `core.status.command` for a CLI command's default status line among them. This came with version 5 of the plugin contract; version 6 makes the `description` required. A plugin written for an older version isn't loaded, and the log says why.

A channel's texts work the same way (channel contract version 6): its English in `messages`, under its name; `ctx.i18n.forRequest(principal, hint)` gives the texts for a request, in the person's language, else the `hint` (an `Accept-Language` value the channel passes on, also as `InboundTurn.languageHint`), else the app's default. `ctx.confirm` and `ctx.resolveConfirmation` hand back what to tell the person (`{ text, resume? }`), so a channel never words a confirmation itself, and `finalize(text, { pendingNote })` says when the text begins with the core's stand-in for an answer the model didn't write, which a channel showing its own confirmation UI drops.

A proper workflow for writing plugins, with an SDK on top of these contracts, is planned ([#27](https://github.com/lucabro81/mercury-fw/issues/27)).

MIT
