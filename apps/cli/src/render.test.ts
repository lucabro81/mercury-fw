/**
 * `renderApp` turns the wizard's answers into the new app's files, with no I/O.
 * The generated config, manifest, env example and compose file are compared
 * byte-exact against goldens for representative selections (nothing, http +
 * jira, everything); the rest is checked for what depends on the selection.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { DEFAULT_PERSONA_TONE } from "@mercury-fw/core";
import { renderApp, type RenderInput } from "./render.ts";

const golden = (name: string): string =>
  readFileSync(new URL(`./__fixtures__/render/${name}.golden`, import.meta.url), "utf-8");

const versions: Record<string, string> = {
  "@mercury-fw/cli": "0.1.0",
  "@mercury-fw/core": "0.1.0",
  "@mercury-fw/formatter": "0.1.0",
  "@mercury-fw/channel-google-chat": "0.1.0",
  "@mercury-fw/channel-http": "0.1.0",
  "@mercury-fw/auth-oidc": "0.1.0",
  "@mercury-fw/auth-static": "0.1.0",
  "@mercury-fw/plugin-jira": "0.1.0",
  "@mercury-fw/plugin-bitbucket": "0.1.0",
  "@mercury-fw/plugin-atlassian-admin": "0.1.0",
  "@mercury-fw/plugin-zitadel": "0.1.0",
  "@mercury-fw/directory-static": "0.1.0",
  "@mercury-fw/plugin-web-search": "0.1.0",
  "@mercury-fw/web-search-searxng": "0.1.0",
  "@mercury-fw/plugin-confluence": "0.1.0",
};

const input = (over: Partial<RenderInput> = {}): RenderInput => ({
  name: "demo",
  assistantName: "Mercury",
  role: "an internal assistant",
  channels: [],
  plugins: [],
  versions,
  ...over,
});

const EMPTY = input();
const HTTP_JIRA = input({ channels: ["http"], plugins: ["jira"], auth: "static" });
const FULL = input({ channels: ["google-chat", "http"], plugins: ["jira", "bitbucket", "atlassian-admin", "zitadel"], auth: "oidc" });
const HTTP = input({ channels: ["http"], auth: "static" });
const WEB = input({ channels: ["http"], plugins: ["web-search"], auth: "static" });

/** Every file the template always writes, whatever was chosen. */
const ALWAYS = [
  ".dockerignore",
  ".env.example",
  ".gitignore",
  "Dockerfile",
  "README.md",
  "docker-compose.yml",
  "locales/en.json",
  "mercury.config.ts",
  "package.json",
  "src/index.ts",
  "src/repl.ts",
  "tsconfig.json",
];

describe("renderApp: files", () => {
  // #144: no generated entrypoint, the core links the CLI credentials
  // each plugin declares, so the files don't depend on the tool plugins.
  test("the same set of files whatever was chosen, plus what a chosen entry brings", () => {
    expect([...renderApp(WEB).keys()].sort()).toEqual([...ALWAYS, "searxng/settings.yml"].sort());
    for (const choice of [EMPTY, HTTP, HTTP_JIRA, FULL]) {
      expect([...renderApp(choice).keys()].sort()).toEqual(ALWAYS);
    }
  });

  test("every file ends with exactly one newline", () => {
    for (const [path, content] of renderApp(FULL)) {
      expect(content.endsWith("\n"), path).toBe(true);
      expect(content.endsWith("\n\n"), path).toBe(false);
    }
  });
});

describe("renderApp: Dockerfile", () => {
  test("http + jira: the template as it is, starting the service directly", () => {
    expect(renderApp(HTTP_JIRA).get("Dockerfile")).toBe(golden("http-jira.Dockerfile"));
  });

  // #131: mfw local-packages puts tarballs in .packs/, which the image needs
  // before bun install, and git doesn't.
  test("copies .packs/ before installing, and git ignores it with the e2e results", () => {
    const dockerfile = renderApp(HTTP).get("Dockerfile") ?? "";
    const packs = dockerfile.indexOf("COPY --chown=mercury:mercury .pack[s] ./.packs/\n");
    expect(packs).toBeGreaterThan(-1);
    expect(packs).toBeLessThan(dockerfile.indexOf("RUN bun install --production"));
    const gitignore = renderApp(HTTP).get(".gitignore") ?? "";
    expect(gitignore.split("\n")).toEqual(expect.arrayContaining([".packs/", "e2e/results/"]));
  });

  // #147: a local plugin is a workspace under plugins/. The whole folder goes
  // in before bun install, since the workspace has to be there to resolve and
  // a plugin's postinstall runs a script of its own; skipped when the app has
  // none, like .packs/.
  test("copies plugins/ before installing", () => {
    const dockerfile = renderApp(HTTP).get("Dockerfile") ?? "";
    expect(dockerfile).toContain("COPY --chown=mercury:mercury plugin[s] ./plugins/\nRUN bun install --production");
  });

  // #147 + #337: a workspace plugin is linked into node_modules, not installed
  // under @mercury-fw/, so its postinstall's binaries are looked for in
  // plugins/ too. -L follows Bun's isolated linker's symlinks into .bun/.
  test("puts on PATH the binaries of the framework's packages and of the app's plugins", () => {
    const dockerfile = renderApp(HTTP).get("Dockerfile") ?? "";
    expect(dockerfile).toContain(
      "RUN mkdir -p /app/plugins \\\n  && find -L /app/node_modules/@mercury-fw /app/plugins -mindepth 3 -maxdepth 3 -path '*/bin/*' -type f -exec ln -sf {} /usr/local/bin/ \\;\n",
    );
  });

  // #147: a plugin's own node_modules and the binaries its postinstall wrote
  // on the host stay out of the build context: the image installs its own.
  test("leaves every node_modules and the plugins' downloaded binaries out of the build context", () => {
    const lines = (renderApp(HTTP).get(".dockerignore") ?? "").split("\n");
    expect(lines).toContain("**/node_modules");
    expect(lines).toContain("plugins/*/bin");
    expect(lines).not.toContain("node_modules");
  });

  // Review of #147: a plugin's downloaded binaries are install output, kept
  // out of the repository as well as out of the image.
  test("git ignores the binaries a plugin's postinstall writes", () => {
    const gitignore = renderApp(HTTP).get(".gitignore") ?? "";
    expect(gitignore.split("\n")).toContain("plugins/*/bin");
  });

  // #337: bunfig.toml is gone — the app installs with Bun's isolated linker
  // (the default with workspaces), and the PATH step above follows symlinks.
  test("does not copy bunfig.toml: the isolated linker is the default", () => {
    const dockerfile = renderApp(HTTP).get("Dockerfile") ?? "";
    expect(dockerfile).not.toContain("bunfig.toml");
  });

  // #271: the persona is in the config, there are no persona files to copy.
  test("copies the config and the sources, nothing for a persona", () => {
    const dockerfile = renderApp(HTTP).get("Dockerfile") ?? "";
    expect(dockerfile).toContain(
      "COPY --chown=mercury:mercury mercury.config.ts ./\nCOPY --chown=mercury:mercury locales ./locales\nCOPY --chown=mercury:mercury src ./src\n",
    );
    expect(dockerfile).not.toContain("persona");
    expect(dockerfile).not.toContain("markdown.d.ts");
  });

  test("whatever was chosen, the same Dockerfile", () => {
    const dockerfile = renderApp(HTTP).get("Dockerfile") ?? "";
    expect(dockerfile.endsWith('CMD ["bun", "src/index.ts"]\n')).toBe(true);
    expect(renderApp(FULL).get("Dockerfile")).toBe(dockerfile);
    expect(renderApp(EMPTY).get("Dockerfile")).toBe(dockerfile);
  });
});

// #279: a new app has the place for its languages from the start: an English
// file it can override texts in, in the config and in the image.
describe("renderApp: languages", () => {
  test("an empty English file, the config's i18n reading it, the image copying the folder", () => {
    const app = renderApp(EMPTY);
    expect(app.get("locales/en.json")).toBe("{}\n");
    const config = app.get("mercury.config.ts")!;
    expect(config).toContain('import en from "./locales/en.json";');
    expect(config).toContain("  i18n: { locales: { en } },");
    expect(app.get("Dockerfile")).toContain("COPY --chown=mercury:mercury locales ./locales\n");
    expect(app.get("README.md")).toContain("`locales/`");
  });

  // Review of #280: the scaffolded Jira rule's empty text was a fixed English
  // string; it's the app's own text, translatable like every other.
  test("a starting formatter rule's texts are the app's, in its English file", () => {
    const app = renderApp(HTTP_JIRA);
    expect(JSON.parse(app.get("locales/en.json")!)).toEqual({ "app.jira.no-issues": "No matching issues." });
    expect(app.get("mercury.config.ts")).toContain('"issue-list": { item: jiraIssueLine, empty: (t) => t("app.jira.no-issues") },');
  });

  test("the terminal gets the app's texts", () => {
    expect(renderApp(EMPTY).get("src/repl.ts")).toContain("  texts: app.texts,\n");
  });
});

describe("renderApp: mercury.config.ts", () => {
  test("nothing chosen: empty plugins and channels, persona only", () => {
    expect(renderApp(EMPTY).get("mercury.config.ts")).toBe(golden("empty.mercury.config.ts"));
  });

  test("http + jira: jira wrapped in the formatter with the example rule", () => {
    expect(renderApp(HTTP_JIRA).get("mercury.config.ts")).toBe(golden("http-jira.mercury.config.ts"));
  });

  test("everything, in catalog order whatever order it was chosen in", () => {
    const shuffled = input({ channels: ["http", "google-chat"], plugins: ["zitadel", "atlassian-admin", "jira", "bitbucket"], auth: "oidc" });
    expect(renderApp(FULL).get("mercury.config.ts")).toBe(golden("full.mercury.config.ts"));
    expect(renderApp(shuffled).get("mercury.config.ts")).toBe(golden("full.mercury.config.ts"));
  });

  // #358: every new app declares its package.json's version, which /version shows.
  test("declares the app's version from its package.json, whatever was chosen", () => {
    for (const chosen of [EMPTY, HTTP_JIRA, FULL]) {
      const config = renderApp(chosen).get("mercury.config.ts") ?? "";
      expect(config).toContain('import pkg from "./package.json";\n');
      expect(config).toContain("  version: pkg.version,\n});\n");
    }
  });

  // #360: how the app moves that number is its own business: no advice on it.
  test("the config's version comment gives no advice on moving the number", () => {
    const config = renderApp(EMPTY).get("mercury.config.ts") ?? "";
    expect(config).toContain(
      [
        "  // The app's version, from package.json: GET /version shows it next to the",
        "  // framework's, to anyone (no token). Mercury never changes it, and a new",
        "  // one shows once the app is rebuilt. Remove this line to show none.",
        "  version: pkg.version,",
      ].join("\n"),
    );
    expect(config).not.toContain("tooling");
  });

  test("a plugin chosen twice is imported and declared once", () => {
    const twice = input({ plugins: ["bitbucket", "bitbucket"] });
    const config = renderApp(twice).get("mercury.config.ts") ?? "";
    expect(config.split('from "@mercury-fw/plugin-bitbucket"').length - 1).toBe(1);
    expect(config).toContain("  plugins: [\n    bitbucketPlugin,\n  ],\n");
  });

  // #348: Confluence hands over two lists, so its plugin is wrapped with a
  // starting rule for each, and their empty texts are the app's.
  test("confluence: wrapped in the formatter with a rule for each of its lists", () => {
    const app = renderApp(input({ plugins: ["confluence"] }));
    const config = app.get("mercury.config.ts") ?? "";
    expect(config).toContain('import { confluencePlugin, type ConfluenceDisplays } from "@mercury-fw/plugin-confluence";\n');
    expect(config).toContain(
      [
        "/** One page in a Confluence search result: its title, its space in parentheses",
        " * when there is one, and its link on its own line. A starting point: change it",
        " * to change how Confluence search results read (each item also has an excerpt). */",
        'const confluencePageLine = (page: ConfluenceDisplays["page-list"]) =>',
        '  `${page.title}${page.space ? ` (${page.space})` : ""}${page.url ? `\\n${page.url}` : ""}`;',
        "",
        "/** One child of a Confluence page: its title, its type in brackets when it isn't",
        " * a page (a folder, a whiteboard), and its link on its own line when it has one. */",
        'const confluenceChildLine = (child: ConfluenceDisplays["child-pages"]) =>',
        '  `${child.title}${child.type && child.type !== "page" ? ` [${child.type}]` : ""}${child.url ? `\\n${child.url}` : ""}`;',
      ].join("\n"),
    );
    expect(config).toContain(
      [
        "    formatterPlugin(",
        "      confluencePlugin,",
        "      formatter<ConfluenceDisplays>({",
        '        "page-list": { item: confluencePageLine, empty: (t) => t("app.confluence.no-pages") },',
        '        "child-pages": { item: confluenceChildLine, empty: (t) => t("app.confluence.no-children") },',
        "      }),",
        "    ),",
      ].join("\n"),
    );
    expect(JSON.parse(app.get("locales/en.json")!)).toEqual({
      "app.confluence.no-pages": "No matching pages.",
      "app.confluence.no-children": "This page has no child pages.",
    });
    expect(JSON.parse(app.get("package.json")!).trustedDependencies).toContain("@mercury-fw/plugin-confluence");
    expect(app.get(".env.example")).not.toContain("CONFLUENCE");
  });

  test("without jira there is no formatter at all", () => {
    const config = renderApp(input({ plugins: ["bitbucket"] })).get("mercury.config.ts") ?? "";
    expect(config).not.toContain("formatter");
    expect(config).not.toContain("jiraIssueLine");
  });
});

// #337: the hoisted-linker workaround is gone — apps install with Bun's
// isolated linker, the default when workspaces are present.
describe("renderApp: bunfig.toml", () => {
  test("is not generated, whatever was chosen", () => {
    for (const choice of [EMPTY, HTTP_JIRA, FULL]) {
      expect(renderApp(choice).get("bunfig.toml")).toBeUndefined();
    }
  });
});

describe("renderApp: package.json", () => {
  test("http + jira: core, formatter and the chosen packages; the tool plugin trusted for its postinstall", () => {
    expect(renderApp(HTTP_JIRA).get("package.json")).toBe(golden("http-jira.package.json"));
  });

  // #147: the app's own plugins are workspaces under plugins/, and the app
  // runs their tests with its own. Plain `bun test` on purpose: it fails while
  // the app has no test at all, and an app without tests is worth noticing.
  test("whatever was chosen, plugins/* as workspaces and a test script", () => {
    for (const choice of [EMPTY, HTTP_JIRA, FULL]) {
      const pkg = JSON.parse(renderApp(choice).get("package.json") ?? "");
      expect(pkg.workspaces).toEqual(["plugins/*"]);
      expect(pkg.scripts.test).toBe("bun test");
    }
  });

  test("nothing chosen: only the core, no trustedDependencies", () => {
    const pkg = JSON.parse(renderApp(EMPTY).get("package.json") ?? "");
    expect(pkg.dependencies).toEqual({ "@mercury-fw/core": "^0.1.0" });
    expect(pkg.trustedDependencies).toBeUndefined();
  });

  // Regression (#94): a Google Chat app's install reported protobufjs's
  // postinstall (pulled in by @google-cloud/pubsub) as blocked, since only
  // the tool plugins were trusted.
  test("every tool plugin is trusted (it downloads its CLI at install), plus what a chosen entry needs: protobufjs for Google Chat", () => {
    const pkg = JSON.parse(renderApp(FULL).get("package.json") ?? "");
    expect(pkg.trustedDependencies).toEqual([
      "@mercury-fw/plugin-atlassian-admin",
      "@mercury-fw/plugin-bitbucket",
      "@mercury-fw/plugin-jira",
      "@mercury-fw/plugin-zitadel",
      "protobufjs",
    ]);
  });

  test("Google Chat with no tool plugin still trusts protobufjs, and nothing else", () => {
    const pkg = JSON.parse(renderApp(input({ channels: ["google-chat"] })).get("package.json") ?? "");
    expect(pkg.trustedDependencies).toEqual(["protobufjs"]);
  });

  test("a package with no known version fails instead of writing a broken range", () => {
    const { ["@mercury-fw/plugin-jira"]: _dropped, ...partial } = versions;
    expect(() => renderApp(input({ plugins: ["jira"], versions: partial }))).toThrow("@mercury-fw/plugin-jira");
  });
});

describe("renderApp: .env.example", () => {
  test("http + jira: core vars, then each chosen entry's vars", () => {
    expect(renderApp(HTTP_JIRA).get(".env.example")).toBe(golden("http-jira.env-example"));
  });

  test("nothing chosen: core vars only", () => {
    const env = renderApp(EMPTY).get(".env.example") ?? "";
    expect(env).toContain("OLLAMA_HOST=");
    expect(env).not.toContain("# ---");
  });

  // #142: MERCURY_CLIS repeated the config, and a plugin missing from it
  // was skipped silently.
  test("no MERCURY_CLIS: declaring a plugin is what enables it", () => {
    const env = renderApp(FULL).get(".env.example") ?? "";
    expect(env).not.toContain("MERCURY_CLIS");
    expect(env).toContain("# --- google-chat\n");
  });

  // #174: a CLI's login never travels in the env file: mfw credentials setup
  // writes it onto the volume from inside the container.
  test("no CLI credentials in the env file", () => {
    const env = renderApp(FULL).get(".env.example") ?? "";
    expect(env).not.toContain("CONFIG_TAR_B64");
    expect(env).not.toContain("# --- bitbucket");
    expect(env).not.toContain("# --- atlassian-admin");
  });
});

describe("renderApp: docker-compose.yml", () => {
  test("everything: volumes named after the app, CLI credentials volume included", () => {
    expect(renderApp(FULL).get("docker-compose.yml")).toBe(golden("full.docker-compose.yml"));
  });

  // #144: a plugin with a CLI added after the scaffold finds its volume there.
  test("no tool plugin: the CLI credentials volume all the same", () => {
    const compose = renderApp(HTTP).get("docker-compose.yml") ?? "";
    expect(compose).toContain("      - cli-credentials:/home/mercury/.config\n");
    expect(compose).toContain("name: demo_cli-credentials");
    expect(compose).toContain("name: demo_wiki-vault");
  });

  // Regression (#105): the HTTP surface listened inside the container only,
  // nothing published its port, so it was unreachable from outside.
  test("HTTP channel: the service publishes HTTP_SURFACE_PORT (4100 when unset) on the host", () => {
    const compose = renderApp(HTTP).get("docker-compose.yml") ?? "";
    expect(compose).toContain(
      ['    ports:', '      - "${HTTP_SURFACE_PORT:-4100}:${HTTP_SURFACE_PORT:-4100}"'].join("\n"),
    );
  });

  test("no HTTP channel: no port published", () => {
    const compose = renderApp(input({ channels: ["google-chat"] })).get("docker-compose.yml") ?? "";
    expect(compose).not.toContain("ports:");
  });
});

/**
 * Runs the config `renderApp` wrote for a selection with no plugins and no
 * channels, returning what it hands to `defineMercuryConfig`: the persona is
 * checked as the core gets it, not as text.
 */
function evaluatedConfig(config: string): { persona: { name: string; identity: string; tone: string } } {
  // The imports are dropped: the language file's stands in as the empty file it
  // is, the package.json's as a manifest with a version.
  const body = `const en = {};\nconst pkg = { version: "0.1.0" };\n${config.replace(/^import .*$/gm, "").replace("export default defineMercuryConfig(", "return (")}`;
  return new Function(body)();
}

describe("renderApp: persona", () => {
  // #271: the persona was split over persona.name in the config and two
  // Markdown files referring to it, imported through a markdown.d.ts and
  // copied by the Dockerfile. It's all in the config now.
  test("the whole persona is in the config: the name once, the role in identity, the core's tone with the name in it", () => {
    const files = renderApp(input({ assistantName: "Hermes", role: "the platform team's release assistant" }));
    expect(evaluatedConfig(files.get("mercury.config.ts") ?? "").persona).toEqual({
      name: "Hermes",
      identity: "You are Hermes, the platform team's release assistant.",
      tone: DEFAULT_PERSONA_TONE.replaceAll("{{assistant}}", "Hermes"),
    });
  });

  test("the name is written once and referred to: no placeholder, no other copy of it", () => {
    const config = renderApp(input({ assistantName: "Hermes" })).get("mercury.config.ts") ?? "";
    expect(config).toContain('const name = "Hermes";\n');
    expect(config.match(/Hermes/g)).toHaveLength(1);
    expect(config).not.toContain("{{assistant}}");
  });

  test("the tone is written line by line, not as one long string", () => {
    const config = renderApp(input({ assistantName: "Hermes" })).get("mercury.config.ts") ?? "";
    expect(config).toContain('    tone: [\n      "DO:",\n      "- Answer directly, in plain text only.",\n');
    expect(config).toContain("      `- DON'T introduce yourself as ${name} unless asked; the user already knows who you are.`,\n");
    expect(config).toContain('    ].join("\\n"),\n');
  });

  // The name is a string literal and the role sits in a template literal:
  // quotes, backslashes, backticks and "$" patterns land as typed.
  test("a name or a role with quotes, backslashes, backticks or $ patterns lands verbatim", () => {
    const name = `A$&B$' "C" \\D`;
    const role = "a `release` helper for ${team} \\ \\` co";
    expect(evaluatedConfig(renderApp(input({ assistantName: name, role })).get("mercury.config.ts") ?? "").persona).toMatchObject({
      name,
      identity: `You are ${name}, ${role}.`,
    });
  });

  // Regression: a role typed as a sentence ended up with a doubled period.
  test("a role that already ends with a period doesn't get a second one", () => {
    const config = renderApp(input({ role: "a helper." })).get("mercury.config.ts") ?? "";
    expect(evaluatedConfig(config).persona.identity).toBe("You are Mercury, a helper.");
  });

  test("the default name and role reproduce the core's default persona", () => {
    expect(evaluatedConfig(renderApp(EMPTY).get("mercury.config.ts") ?? "").persona).toEqual({
      name: "Mercury",
      identity: "You are Mercury, an internal assistant.",
      tone: DEFAULT_PERSONA_TONE.replaceAll("{{assistant}}", "Mercury"),
    });
  });

  test("refuses a name the core would refuse", () => {
    expect(() => renderApp(input({ assistantName: "a".repeat(41) }))).toThrow("persona.name");
    expect(() => renderApp(input({ assistantName: "{{assistant}}" }))).toThrow("persona.name");
  });
});

describe("renderApp: README.md", () => {
  // #358: the README says what the config's version shows, and what it doesn't.
  // #360: how the app moves that number is its own business: no advice on it.
  test("the layout says the config's version is package.json's, shown to anyone, never changed by Mercury", () => {
    const readme = renderApp(EMPTY).get("README.md") ?? "";
    expect(readme).toContain(
      "Its `version` is the one in `package.json`, which the HTTP channel's `GET /version` shows to anyone, no token needed: Mercury never changes it, and a new one shows once the app is rebuilt. Remove the line to show none.\n",
    );
    expect(readme).not.toContain("Changesets");
  });

  // #271: the persona is in the config; the layout names no persona files.
  test("the layout puts the persona in mercury.config.ts, with no persona files", () => {
    const readme = renderApp(EMPTY).get("README.md") ?? "";
    expect(readme).toContain("- `mercury.config.ts`: what the app is made of (tool plugins, channels, how their lists read) and the assistant's persona: its name, who it is and how it answers. Edit them freely. ");
    expect(readme).not.toContain("persona/");
  });

  // #147: the layout says where the app's own plugins go, and that bun test
  // runs theirs.
  test("the layout puts the app's own plugins in plugins/, each a workspace", () => {
    const readme = renderApp(EMPTY).get("README.md") ?? "";
    expect(readme).toContain(
      "- `plugins/`: the app's own plugins, when it has any: each one a package in a folder of its own (`plugins/<name>`, a workspace), listed in `dependencies` as `workspace:*` and declared in `mercury.config.ts`. `bun run test` runs their tests.\n",
    );
  });

  // #337: bunfig.toml is gone from new apps; the layout no longer mentions it.
  test("the layout does not mention bunfig.toml", () => {
    const readme = renderApp(EMPTY).get("README.md") ?? "";
    expect(readme).not.toContain("bunfig.toml");
  });

  test("says how to get mfw once, globally, and how to do without", () => {
    const readme = renderApp(HTTP_JIRA).get("README.md") ?? "";
    expect(readme).toContain("bun add -g @mercury-fw/cli");
    expect(readme).toContain("`bunx mfw start`");
  });

  test("HTTP channel: says where the surface listens on the host, and how a caller authenticates", () => {
    const readme = renderApp(HTTP_JIRA).get("README.md") ?? "";
    expect(readme).toContain("## HTTP surface");
    expect(readme).toContain("`http://<host>:4100`");
    expect(readme).toContain("`HTTP_SURFACE_PORT`");
    expect(readme).toContain("`Authorization: Bearer <token>`");
    expect(readme).toContain("`static` (`@mercury-fw/auth-static`)");
    expect(readme).not.toContain("no authentication");
  });

  test("HTTP with oidc: names the oidc provider", () => {
    expect(renderApp(FULL).get("README.md") ?? "").toContain("`oidc` (`@mercury-fw/auth-oidc`)");
  });

  test("names the auth provider among what the app was scaffolded with, only when there is one", () => {
    expect(renderApp(HTTP_JIRA).get("README.md") ?? "").toContain("- Auth: static\n");
    expect(renderApp(EMPTY).get("README.md") ?? "").not.toContain("- Auth:");
  });

  test("no HTTP channel: no HTTP surface section", () => {
    expect(renderApp(input({ channels: ["google-chat"] })).get("README.md") ?? "").not.toContain("## HTTP surface");
  });

  test("names the app and what it was scaffolded with, and starts from installing it", () => {
    const readme = renderApp(HTTP_JIRA).get("README.md") ?? "";
    expect(readme.startsWith("# demo\n")).toBe(true);
    expect(readme).toContain("Channels: http");
    expect(readme).toContain("Tool plugins: jira");
    expect(readme).toContain("bun install\ncp .env.example .env\n");
    expect(readme).not.toContain("published");
  });

  test("runs the app through mfw, not raw docker commands", () => {
    const readme = renderApp(HTTP_JIRA).get("README.md") ?? "";
    expect(readme).toContain("bun install\ncp .env.example .env\nmfw start\nmfw repl\n");
    expect(readme).toContain("mfw --help");
    expect(readme).not.toContain("docker compose up");
    expect(readme).not.toContain("docker compose run --rm mercury bun run repl");
  });

  // #144: the section said every tool plugin runs a CLI with a login folder,
  // and listed them; a CLI is a feature of some plugins, from any author.
  test("explains, for any app and without naming plugins, how a plugin's CLI gets its login", () => {
    for (const choice of [EMPTY, HTTP_JIRA, FULL]) {
      const readme = renderApp(choice).get("README.md") ?? "";
      const section = readme.slice(readme.indexOf("## CLI credentials"));
      expect(section).toStartWith("## CLI credentials\n\nSome tool plugins run a CLI. When that CLI keeps its login in a folder");
      expect(section).toContain("\nmfw credentials setup <plugin>\nmfw credentials check <plugin>\n");
      expect(section).toContain("\nmfw credentials reset <plugin> [--user <key>]\n");
      expect(section).toContain("every environment sets up its own");
      expect(section).not.toContain("credentials set ");
      expect(section).not.toContain("unpack");
      expect(section).toContain("a folder under \`~/.config\`, or a path anywhere under the home");
      expect(section).toContain("A CLI that authenticates any other way isn't covered by this, and nothing guarantees it works in Mercury;");
      for (const name of ["jira", "bitbucket", "atlassian"]) expect(section).not.toContain(name);
    }
  });

  test("an empty selection says so instead of listing nothing", () => {
    const readme = renderApp(EMPTY).get("README.md") ?? "";
    expect(readme).toContain("Channels: none");
    expect(readme).toContain("Tool plugins: none");
  });
});

// #188: the directory decides who the people are and their roles; it's
// chosen on its own, with or without the HTTP channel.
describe("renderApp: directory", () => {
  test("the config declares it, imported from its package", () => {
    const config = renderApp(input({ directory: "static" })).get("mercury.config.ts") ?? "";
    expect(config).toContain('import { staticDirectory } from "@mercury-fw/directory-static";\n');
    expect(config).toContain("  directory: staticDirectory,\n");
  });

  test("its variables go in the env example, its package in the dependencies", () => {
    const app = renderApp(input({ directory: "zitadel" }));
    expect(app.get(".env.example")).toContain("# --- zitadel directory\n");
    expect(app.get(".env.example")).toContain("\nZITADEL_PROJECT_ID=\n");
    expect(JSON.parse(app.get("package.json") ?? "").dependencies).toMatchObject({ "@mercury-fw/plugin-zitadel": "^0.1.0" });
  });

  // The ZITADEL directory calls the zitadel CLI, which plugin-zitadel downloads
  // as it installs: Bun runs that only for a trusted package.
  test("a directory that ships a CLI is trusted for its install, even without its tools", () => {
    const pkg = JSON.parse(renderApp(input({ directory: "zitadel" })).get("package.json") ?? "");
    expect(pkg.trustedDependencies).toEqual(["@mercury-fw/plugin-zitadel"]);
  });

  test("the zitadel tools and directory together: both declared, the package once", () => {
    const app = renderApp(input({ plugins: ["zitadel"], directory: "zitadel" }));
    const config = app.get("mercury.config.ts") ?? "";
    expect(config).toContain("    zitadelPlugin,\n");
    expect(config).toContain("  directory: zitadelDirectory,\n");
    expect(JSON.parse(app.get("package.json") ?? "").trustedDependencies).toEqual(["@mercury-fw/plugin-zitadel"]);
  });

  test("the README says which directory", () => {
    expect(renderApp(input({ directory: "static" })).get("README.md")).toContain("- Directory: static\n");
  });

  test("no directory: nothing about one", () => {
    const app = renderApp(EMPTY);
    expect(app.get("mercury.config.ts")).not.toContain("directory");
    expect(app.get("README.md")).not.toContain("Directory:");
  });

  test("rejects an unknown directory, naming the valid ids", () => {
    expect(() => renderApp(input({ directory: "ldap" }))).toThrow('Unknown directory "ldap" (valid: static, zitadel)');
  });
});

describe("renderApp: validation", () => {
  test.each(["Demo", "my app", "@scope/demo", "", ".demo", "_demo", "a".repeat(215)])(
    "rejects the app name %p",
    (name) => {
      expect(() => renderApp(input({ name }))).toThrow("app name");
    },
  );

  test.each(["demo", "my-app", "app2", "acme.mercury", "a_b"])("accepts the app name %p", (name) => {
    expect(() => renderApp(input({ name }))).not.toThrow();
  });

  test("rejects an unknown channel or plugin, naming the valid ids", () => {
    expect(() => renderApp(input({ channels: ["slack"] }))).toThrow("google-chat, http");
    expect(() => renderApp(input({ plugins: ["http"] }))).toThrow("jira, bitbucket, atlassian-admin, zitadel");
  });

  // #37: the HTTP channel doesn't start without an auth provider, so an app
  // scaffolded with one and not the other would have a surface that never opens,
  // or a provider nothing uses.
  test("rejects the HTTP channel without an auth provider, and an auth provider without it", () => {
    expect(() => renderApp(input({ channels: ["http"] }))).toThrow(
      'The http channel needs an auth provider (valid: oidc, static)',
    );
    expect(() => renderApp(input({ channels: ["google-chat"], auth: "static" }))).toThrow(
      'The auth provider "static" goes with the http channel, which isn\'t chosen',
    );
  });

  test("rejects an unknown auth provider, naming the valid ids", () => {
    expect(() => renderApp(input({ channels: ["http"], auth: "saml" }))).toThrow('Unknown auth provider "saml" (valid: oidc, static)');
  });

  test("rejects a line break in the assistant name or role (each is one line of the persona)", () => {
    expect(() => renderApp(input({ assistantName: "Her\nmes" }))).toThrow("one line");
    expect(() => renderApp(input({ role: "a\nhelper" }))).toThrow("one line");
  });

  test("rejects an empty assistant name or role", () => {
    expect(() => renderApp(input({ assistantName: "  " }))).toThrow("assistant name");
    expect(() => renderApp(input({ role: "" }))).toThrow("role");
  });
});

describe("renderApp: web search", () => {
  test("the plugin built with the SearXNG backend from its env, and no allowed host to start with", () => {
    expect(renderApp(WEB).get("mercury.config.ts")).toBe(golden("web-search.mercury.config.ts"));
  });

  test("depends on the plugin and its backend; the plugin is trusted like every tool plugin, though it has no install script", () => {
    const manifest = JSON.parse(renderApp(WEB).get("package.json")!) as { dependencies: Record<string, string>; trustedDependencies?: string[] };
    expect(manifest.dependencies["@mercury-fw/plugin-web-search"]).toBe("^0.1.0");
    expect(manifest.dependencies["@mercury-fw/web-search-searxng"]).toBe("^0.1.0");
    expect(manifest.trustedDependencies).toEqual(["@mercury-fw/plugin-web-search"]);
  });

  test("a SearXNG service in the compose file, the app depending on it, nothing of it published on the host", () => {
    expect(renderApp(WEB).get("docker-compose.yml")).toBe(golden("web-search.docker-compose.yml"));
  });

  test("SearXNG's settings: JSON on, no limiter", () => {
    expect(renderApp(WEB).get("searxng/settings.yml")).toBe(golden("web-search.searxng-settings.yml"));
  });

  test("the env example says where SearXNG is and asks for its secret", () => {
    const env = renderApp(WEB).get(".env.example")!;
    expect(env).toContain("# --- web-search\n");
    expect(env).toContain("\nSEARXNG_URL=http://searxng:8080\n");
    expect(env).toContain("\nSEARXNG_SECRET=\n");
  });

  // Cold review of #194: an empty secret let SearXNG start with its default
  // key and exit, restarting forever, while every search said "can't be reached".
  test("the compose file refuses to start SearXNG without its secret, saying where to set it", () => {
    expect(renderApp(WEB).get("docker-compose.yml")).toContain(
      "      SEARXNG_SECRET: ${SEARXNG_SECRET:?set SEARXNG_SECRET in .env (see .env.example)}\n",
    );
  });

  test("an empty SEARXNG_URL falls back to the compose service too", () => {
    expect(renderApp(WEB).get("mercury.config.ts")).toContain('searxngBackend({ url: process.env.SEARXNG_URL || "http://searxng:8080" })');
  });

  test("the README names the variables to fill in before the first start, SearXNG's secret among them", () => {
    const readme = renderApp(WEB).get("README.md")!;
    expect(readme).toContain("Before `mfw start`, fill in the variables the chosen pieces require: `AUTH_STATIC_TOKENS`, `SEARXNG_SECRET`.");
  });

  test("without web search: no SearXNG service and no settings file", () => {
    expect(renderApp(FULL).get("docker-compose.yml")).not.toContain("searxng");
    expect(renderApp(FULL).has("searxng/settings.yml")).toBe(false);
  });
});
