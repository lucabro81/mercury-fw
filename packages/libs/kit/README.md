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

or anywhere else under the home, with `{ "path": ".my-cli" }` instead of `folder` (relative to the home, inside it). Each command is a binary on the container's PATH followed by its arguments: `setup` sets up the identity the agent runs as and is required, `check` and `logout` (of that identity, or of one person with `--user <id>`) are optional.

An app then runs `mfw credentials setup <plugin>`, which runs `setup` in a one-off container on the user's terminal, so the CLI asks for what it needs and writes its login straight onto a volume that keeps what the CLI writes back (a folder outside `~/.config` gets a link from its usual place to the volume). A CLI that authenticates any other way isn't covered by this, and neither is one that deletes its own folder and makes it again.

A proper workflow for writing plugins, with an SDK on top of these contracts, is planned ([#27](https://github.com/lucabro81/mercury-fw/issues/27)).

MIT
