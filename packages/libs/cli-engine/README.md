# @mercury-fw/cli-engine

For [Mercury](https://github.com/lucabro81/mercury-fw) plugins that work through a command-line tool: it turns the command line the model writes into an argv array of its own (never a shell), runs it only when it matches the plugin's allowlist, and stages the commands the allowlist marks as needing confirmation behind a one-time token instead of running them.

On Mercury's documentation site: [Plugins and skills](https://lucabro81.github.io/mercury-fw/concepts/plugins/).

The allowlist is a JSON file the plugin ships and validates when it loads:

```json
{
  "binary": "bitbucket",
  "commands": [
    { "prefix": ["pr", "list"], "confirm": false, "mutating": false },
    { "prefix": ["pr", "merge"], "confirm": true, "mutating": true }
  ],
  "globalFlags": [{ "flag": "--select", "takesValue": true }]
}
```

A command runs when its arguments start with one of the `prefix`es (`--help` always runs); `confirm: true` stages it until the user sends the token back. In `build()` the plugin validates the file with `parseCliConfig` and builds its tool with `createCliTool(runCli, configs, …)`, passing the turn's texts it gets in its session context as `t` (`t: sctx.t`); the status describer `createCliStatusDescriber` builds takes the command and the same `t`; [`@mercury-fw/plugin-bitbucket`](https://github.com/lucabro81/mercury-fw/tree/main/packages/tools/plugin-bitbucket/index.ts) does exactly that.

MIT
