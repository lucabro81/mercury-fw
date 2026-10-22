---
"@mercury-fw/cli": minor
---

`mfw create` gives the app a place for plugins of its own: `plugins/<name>`, each a package, as a workspace of the app (`"workspaces": ["plugins/*"]` in `package.json`), listed in `dependencies` as `workspace:*` and declared in `mercury.config.ts`. A `bunfig.toml` keeps Bun's hoisted `node_modules`: with a workspaces key Bun would switch to its isolated linker, whose `node_modules` is made of links. The Dockerfile copies `bunfig.toml` with `package.json`, then `plugins/` before `bun install`, so a plugin's postinstall finds its own scripts, and puts on PATH the binaries a plugin's postinstall writes to its `bin/`, as it does for the framework's packages. `.dockerignore` leaves out every `node_modules`, a plugin's own included, and the binaries a plugin's postinstall wrote on the host. `package.json` gets a `test` script (`bun test`), which runs the plugins' tests too.

An existing app keeps working as it is. To give it the same place:

1. In `package.json`, add `"workspaces": ["plugins/*"]` and `"test": "bun test"` under `scripts`.
2. Add a `bunfig.toml` next to it:

   ```toml
   [install]
   linker = "hoisted"
   ```

3. In the `Dockerfile`, change `COPY --chown=mercury:mercury package.json bun.lock* ./` to `COPY --chown=mercury:mercury package.json bun.lock* bunfig.toml ./`, add `COPY --chown=mercury:mercury plugin[s] ./plugins/` right after `COPY --chown=mercury:mercury .pack[s] ./.packs/`, and replace the line `RUN find /app/node_modules -path '*/@mercury-fw/*/bin/*' -type f -exec ln -sf {} /usr/local/bin/ \;` with:

   ```dockerfile
   RUN mkdir -p /app/plugins \
     && find /app/node_modules/@mercury-fw /app/plugins -mindepth 3 -maxdepth 3 -path '*/bin/*' -type f -exec ln -sf {} /usr/local/bin/ \;
   ```

4. In `.dockerignore`, change `node_modules` to `**/node_modules` and add `plugins/*/bin`.
