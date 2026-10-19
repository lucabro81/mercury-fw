---
"@mercury-fw/cli": patch
---

`mfw create` writes the whole persona inside `mercury.config.ts`: the assistant's name once, as a `const`, referred to by the identity and by the tone, which is written out in full, one string per line. There are no `persona/identity.md` and `persona/tone.md` files anymore, no `markdown.d.ts`, and the Dockerfile no longer copies them.

An existing app keeps working as it is. To move it to the new layout:

1. In `mercury.config.ts`, drop the two `import … from "./persona/…md"` lines, add `const name = "<the assistant's name>";` and set `persona: { name, identity: "…", tone: "…" }` with the text of the two files (`${name}` in a template literal where they say `{{assistant}}`, or keep `{{assistant}}`: the core still replaces it).
2. Delete `persona/` and `markdown.d.ts`.
3. In the `Dockerfile`, change `COPY --chown=mercury:mercury mercury.config.ts markdown.d.ts ./` to `COPY --chown=mercury:mercury mercury.config.ts ./` and delete `COPY --chown=mercury:mercury persona ./persona`.
