# @mercury-fw/plugin-types

## 0.53.1

## 0.53.0

### Minor Changes

- 56e4ed5: - A plugin can act as no one (`actsAs: "anyone"`): for a public service with no login, such as web search. It is offered to everyone (still within `access.plugins`), never with a variant acting as Mercury, and the operator gets it under its own names.
  - The tools of such a plugin get the turn's `person` all the same (the operator's key on the terminal), to keep what belongs to each person; they can't start a login.
  - An older core reads `"anyone"` as `"mercury"`: the plugin is offered only to whoever may make Mercury act as itself.
- c83b129: - New plugin `@mercury-fw/plugin-web-search`: `web_search` through a backend package of the app's choice, and `web_fetch` to read a page and hand the model its title and text.
  - A page is read right away only on a host the instance allows (`allowedHosts`) or the person allowed; for any other host the person chooses between reading that page only and allowing the host for good (their own list, kept in the plugin's folder), and the page goes back to the model either way.
  - Internal addresses are never read, redirects included, and only HTML and plain text are, up to 2 MB and 20,000 characters.
  - An answer built on pages ends with the list of the pages read (`Fonti:`).
  - A post-turn guard's `shouldRun` gets the turn's steps as a second argument.

## 0.52.0

### Minor Changes

- 678c1cc: - A plugin gets a folder of its own on the vault's volume, `PluginRuntimeContext.dataDir` (`<vault>/.mercury/plugins/<name>/`), created by the core before `build()`: data it keeps there survives a restart, and never reaches the model or the wiki.
  - A plugin whose name isn't a safe folder name, or whose folder can't be created, gets none (the core logs why) and loads anyway.

## 0.51.0

### Minor Changes

- b2f8cfb: - A confirmation can offer several choices (for example "only this time" / "always for this host"): a plugin tool stages them with the new `stageChoices` of `SessionToolContext`, and gets one token per choice. The person takes one; the others die with it, and they all expire together.
  - The paper-trail note of a group of choices is one, under its first token, and says which choice was taken.
  - `detectPendingConfirmation` returns the `choices` a staging offers; a plain staging is one choice labelled `Conferma`.
  - A confirmed action can hand its result back to the model (`resume` on a choice): instead of showing the person the raw result, the channel resumes the turn and the model answers on it, the result reaching it as the tool result of the call that staged it, never stored in the history.
  - A resumed turn answers the person who confirmed even in a shared space, and the line standing for the confirmation isn't archived as something they said. A result nobody resumes within five minutes (the life of a confirmation token) is forgotten, and a restart loses it.
  - `InboundTurn.resumeAfterConfirm` and `RESUME_AFTER_CONFIRM` (channel contract) carry the resumed turn; `ConfirmOutcome` has a `resume` status.
  - Terminal: every choice is printed on its own line with its token; a confirmation that resumes runs the turn again.
  - Google Chat: the confirmation card has one button per choice; a typed token or a clicked choice that resumes runs the turn again, in the session's queue. The channel now needs channel-types 0.51.0 or later.
  - HTTP: the `pending` event carries `choices`; a token sent to `POST /turn` that resumes streams the model's answer on the same request; `POST /confirm` answers `resume: true`, and `POST /turn { resume: true, conversationId }` runs that turn. The channel now needs channel-types 0.51.0 or later.

## 0.50.4

## 0.50.3

## 0.50.2

## 0.50.1

## 0.50.0

### Minor Changes

- ae495c7: - The model is told, at the end of every prompt, which lists it already showed in the conversation: each one's ref and the command that built it, never the list itself. It can show one again with `present`, or run the command again for fresh data, instead of retyping it from memory.
  - A list shown in a conversation stays available for `present` as long as the conversation, previously five minutes, at most the ten most recent per conversation.
  - `stashDisplay` takes an optional label, and the cli-engine passes the command that built the list with its number of items.
  - The jira skill points to the lists already shown, and keeps a new search for fresh data.

## 0.49.1

## 0.49.0

## 0.48.0

### Minor Changes

- 62bb3a3: - `persona.name` is the assistant's name, Mercury when left out. A name that's blank, longer than 40 characters or on more than one line stops the app at startup.
  - Every text the model reads refers to the name as `{{assistant}}`, and the core puts the persona's name there: the persona's identity and tone, the system prompt, plugin fragments, skills and tool descriptions. The model no longer takes "Mercury" for its own name when the app calls its assistant something else.
  - Where the one acting is the system around the model, the texts say "the system" or "this instance" instead of Mercury: the wiki tools, the cli-engine's errors, the jira skill and its issue lists.
  - Plugins get `assistantName` in their `build()` context, and channels in their runtime context, for texts they build while running. The login messages, the linking reply and the HTTP login page name the assistant that way.
  - The tools a person runs as the assistant itself are `<tool>AsSelf`, previously `<tool>AsMercury`. The `mercury.act-as-self` roles are unchanged.
  - `mfw create` writes the assistant's name as `persona.name`, with `persona/identity.md` and `persona/tone.md` referring to it. An existing app keeps working as it is: to rename its assistant everywhere, add `name` to its persona and write `{{assistant}}` in its persona files.

## 0.47.1

## 0.47.0

## 0.46.1

## 0.46.0

## 0.45.0

## 0.44.1

## 0.44.0

## 0.43.0

## 0.42.0

## 0.41.0

## 0.40.0

### Minor Changes

- 0739f77: A plugin acts as the person Mercury is talking to, who logs in to the service through Mercury.

  - Plugin contract version 4: a plugin declares `actsAs: "person" | "mercury"`, and one acting as the person contributes a `login`; its tools get the turn's `person` and `requireLogin` in their context.
  - A person is offered only the plugins acting as the person: their prompt fragments, skills and tools. A plugin acting as Mercury, or declaring nothing, is offered on the terminal only until people can be allowed to make Mercury act as itself; the startup log names it.
  - `createCliTool` adds `--user` with the person's id to every command, staged confirmations included, and when the CLI exits with code 3 (not logged in) returns their login instead. `createCliPersonLogin` builds a plugin's `login` on a CLI's two-step remote login. A failed `runCli` carries `exitCode`.
  - Channel contract version 4: channels get `logins` (`accept` a callback URL, `complete` a login) and `detectLoginRequired`.
  - The HTTP channel, with `HTTP_SURFACE_PUBLIC_URL` set, streams a `login` event with the link to open and takes the person back at `GET /login/callback`, public and protected by the single-use state.
  - `mercury.cliCredentials` can declare `userSetup`, run by `mfw credentials setup <plugin> --user-app`: the app people log in through, set up without logging anyone in.
  - plugin-jira and plugin-bitbucket act as the person, on CLIs 2.3.0: set up their people's app with `--user-app` and register `<HTTP_SURFACE_PUBLIC_URL>/login/callback` on it. Jira's skill now says `currentUser()` is the person.
  - plugin-atlassian-admin acts as Mercury, on CLI 0.2.0, whose `init` asks for the key without echoing it: until permissions exist it's available on the terminal only.
  - A third-party plugin needs `apiVersion: 4` to load, and `actsAs: "person"` with a `login` to be offered to people.

## 0.39.0

## 0.38.1

## 0.38.0

## 0.37.0

## 0.36.0

## 0.35.0

## 0.34.0

## 0.33.0

## 0.32.0

## 0.31.1

## 0.31.0

## 0.30.0

## 0.29.4

## 0.29.3

## 0.29.2

## 0.29.1

## 0.29.0

## 0.28.4

## 0.28.3

## 0.28.2

## 0.28.1

## 0.28.0

## 0.27.1

## 0.27.0

## 0.26.0

## 0.25.1

## 0.25.0
