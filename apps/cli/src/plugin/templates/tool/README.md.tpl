# __PACKAGE__

The __TITLE__ plugin: the agent lists the items of a service and deletes one, once the person confirms. `mfw plugin create` wrote it as a starting point: the service, its client and the tools are examples to replace with the plugin's own.

## Contents

- [Settings](#settings)
- [Files](#files)
- [Testing](#testing)

## Settings

`__CONSTANT___URL` in the app's env file: the service's address. Without it the plugin contributes no tool, and says so in the log.

## Files

- `index.ts`: the plugin, what the model reads about it, its tools' status lines.
- `tools.ts`: the tools and the service's client. `__SNAKE___delete` stages its action behind the person's confirmation, as every irreversible action does.
- `messages.ts`: the texts a person sees, in English, under the plugin's name; the app's `locales/` translate them.
- `skills/__NAME__/SKILL.md`: how to use the tools, which the model loads when it needs them.

## Testing

`bun test` in this folder, or `bun run test` in the app's. To check what the model does with the tools, write an e2e test in the app's `e2e/` and run `mfw e2e`.
