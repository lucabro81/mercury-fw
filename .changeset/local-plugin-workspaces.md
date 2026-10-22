---
"@mercury-fw/cli": minor
---

`mfw create` gives the app a place for plugins of its own: `plugins/<name>`, each a package, as a workspace of the app (`"workspaces": ["plugins/*"]` in `package.json`), listed in `dependencies` as `workspace:*` and declared in `mercury.config.ts`. The Dockerfile copies `plugins/` before `bun install`, so a plugin's postinstall finds its own scripts, and puts on PATH the binaries a plugin's postinstall writes to its `bin/`, as it does for the framework's packages. `.dockerignore` leaves out every `node_modules`, a plugin's own included. `package.json` gets a `test` script (`bun test`), which runs the plugins' tests too.

An existing app keeps working as it is. To give it the same place:

1. In `package.json`, add `"workspaces": ["plugins/*"]` and `"test": "bun test"` under `scripts`.
2. In the `Dockerfile`, add `COPY --chown=mercury:mercury plugin[s] ./plugins/` right after `COPY --chown=mercury:mercury .pack[s] ./.packs/`, and replace the line `RUN find /app/node_modules -path '*/@mercury-fw/*/bin/*' -type f -exec ln -sf {} /usr/local/bin/ \;` with:

   ```dockerfile
   RUN mkdir -p /app/plugins \
     && find /app/node_modules/@mercury-fw /app/plugins -mindepth 3 -maxdepth 3 -path '*/bin/*' -type f -exec ln -sf {} /usr/local/bin/ \;
   ```

3. In `.dockerignore`, change `node_modules` to `**/node_modules`.
