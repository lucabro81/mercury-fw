# __PACKAGE__

The __TITLE__ plugin: the agent runs the `__BINARY__` command-line program, only the commands its allowlist names. `mfw plugin create` wrote it as a starting point: the allowlist's commands are examples to replace with the program's own.

## Contents

- [Setting it up](#setting-it-up)
- [Files](#files)
- [Testing](#testing)

## Setting it up

- The app lists this package in `trustedDependencies` in its `package.json` (`mfw plugin create` did it), so Bun runs the postinstall that downloads the binary.
- The program logs in once, inside the app's container: `mfw credentials setup` runs `__BINARY__ init`, `mfw credentials check` runs `__BINARY__ doctor`. Change them in `package.json` (`mercury.cliCredentials`) to the program's own commands.
- `mercury.cliBinary` pins the binary: the GitHub repository releasing it, its name, its version.

## Files

- `index.ts`: the plugin and its one tool, `__CAMEL__Command`, built by `@mercury-fw/cli-engine` from the allowlist.
- `__BINARY__.json`: the allowlist. A command runs only when it starts with one of its `prefix`es; one with `confirm: true` waits for the person's confirmation.
- `scripts/install-__BINARY__-cli.ts`: the postinstall downloading the pinned binary.

## Testing

`bun test` in this folder, or `bun run test` in the app's. `allowlist.test.ts` pins what the model may run: change it with the allowlist.
