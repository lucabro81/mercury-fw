# __APP__

What a coding agent needs to work on this app. People read `README.md`; this file is for the assistant.

## What it is

An agent built on Mercury, a framework published on npm as `@mercury-fw/*`. The app declares what it's made of in `mercury.config.ts`, and `@mercury-fw/core` runs the rest: the turns, the tools, the memory. The framework's version is the one of `@mercury-fw/core` in `package.json`, and every `@mercury-fw/*` framework package moves with it. The documentation is at https://lucabro81.github.io/mercury-fw/.

The app runs in Docker, with Qdrant next to it: the image installs its own packages, and the model is reached at `OLLAMA_HOST`.

## Where things are

- `mercury.config.ts`: the composition. The persona, the models, the plugins (`plugins`), the channels people talk through (`channels`), who they are (`auth`, `directory`), what the model reads besides each message (`context`), where traces go (`traces`).
- `plugins/<name>`: the app's own plugins, each a package of its own (a workspace), listed in `package.json` as `workspace:*` and declared in `mercury.config.ts`.
- `locales/`: the texts people see, one file per language. `en.json` overrides the English ones; the app's own keys start with `app.`.
- `src/index.ts`: the service. `src/repl.ts`: a terminal conversation with the agent, for trying things out.
- `e2e/`: end-to-end tests against the real model (`*.e2e.ts`), when there are any. Their results go in `e2e/results/`, which git ignores.
- `Dockerfile`, `docker-compose.yml`: the image and the services.
- `.env.example`: every variable the app reads. The real values are in `.env`, which git ignores.

## The mfw command

`mfw` is Mercury's command-line tool. Run the app's own copy with `bunx mfw` from this folder (a global `mfw` hands the command over to it anyway), and use it instead of calling `docker compose` by hand:

- `bunx mfw start`, `bunx mfw restart`, `bunx mfw stop`: build and start the app, restart it after a change, stop it.
- `bunx mfw logs`: follow what the app logs, the first place to look when something doesn't load.
- `bunx mfw repl`: talk to the agent from the terminal.
- `bunx mfw plugin create <kind> <name>`: a new plugin of the app's own, with its tests (`bunx mfw plugin create --help` lists the kinds).
- `bunx mfw credentials setup <plugin>`: the login of a plugin's command-line tool, inside the container.
- `bunx mfw e2e`: the end-to-end tests, against the app's real model.

`bunx mfw --help` lists the rest. Outside the container: `bun run test` runs the plugins' tests, `bun run typecheck` checks the types.

## Do

- Start a new plugin with `bunx mfw plugin create`, and follow the `mercury-plugin` skill while writing it.
- Keep a plugin's tests next to its code, and run `bun run test` and `bun run typecheck` before committing.
- Read every setting and secret from the environment (`ctx.env` in a plugin), and add the variable to `.env.example`, empty when it's a secret.
- Put every irreversible action a tool takes behind the person's confirmation (`stageConfirmation`).
- Write what the model reads (descriptions, skills, prompt fragments) in English.
- When upgrading the framework, read its changelog for the steps an existing app has to take.

## Don't

- Don't run the app with `bun` on the host: it runs in Docker (`bunx mfw start`).
- Don't read, print or commit `.env`.
- Don't write a model's address or a service's URL in the code: they come from the environment.
- Don't edit anything under `node_modules`.
- Don't add an agent framework (LangChain and the like) on top: Mercury is one.
