---
"@mercury-fw/plugin-types": minor
"@mercury-fw/channel-types": minor
"@mercury-fw/core": minor
"@mercury-fw/kit": minor
"@mercury-fw/channel-http": minor
"@mercury-fw/directory-static": patch
---

- context layers declare knobs (`context.knobs`, `KnobSpec`: `boolean`, `integer`, `number`, `string`, `enum`); `req.knobs` holds each one's value in the person's profile, or its default
- a plugin whose knob spec contradicts itself isn't loaded
- a profile's `maxChars`, layer order and knobs can change while the instance runs, for people holding `mercury.context-admin`; kept in `context-settings.json` in the data folder, each change recorded in `context-changes.jsonl` and as a `context.changed` event
- channel contract: `ctx.contextAdmin` (`read`, `update`, `changes`), on an instance with a `context`
- channel-http: `GET /context`, `PATCH /context/profiles/{name}`, `GET /context/changes`
- directory-static: README names the `mercury.context-admin` role
