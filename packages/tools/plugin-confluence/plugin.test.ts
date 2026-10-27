import { describe, it, expect } from "bun:test";
import { PLUGIN_API_VERSION, type SessionToolContext, type Translate } from "@mercury-fw/plugin-types";
import { confluencePlugin, createConfluencePlugin, CONFLUENCE_CHILD_PAGES_SELECT, CONFLUENCE_PAGE_LIST_SELECT } from "./index.ts";

/**
 * The Confluence plugin's assembled module object: its static declaration
 * (name, description, skill, acting as the person) and its `build()`, which
 * validates its own allowlist and turns the runtime context into the
 * `confluenceCommand` tool, the list extractor and the tool's status
 * describer.
 */
const MODEL = {} as never; // build() only closes over the model; it never calls it
const noLog = () => {};
/** The turn's texts: the key and its params, so a test sees what was asked for. */
const echo: Translate = (key, params) => (params ? `${key} ${JSON.stringify(params)}` : key);

const sctx: SessionToolContext = {
  sessionKey: "s",
  t: echo,
  stageConfirmation: async () => "tok",
  stashDisplay: () => "d1",
  person: null,
  requireLogin: async () => ({ ok: false, error: "x" }),
};

describe("confluencePlugin", () => {
  it("says what it does, for the model", () => {
    expect(confluencePlugin.description).toBe("Searches and reads Confluence pages, their children and comments, and spaces.");
  });

  it("declares the compatible apiVersion, the confluence name and a confluence skill", () => {
    expect(confluencePlugin.apiVersion).toBe(PLUGIN_API_VERSION);
    expect(confluencePlugin.name).toBe("confluence");
    expect(confluencePlugin.systemPromptFragment).toBeUndefined();
    expect(confluencePlugin.skills).toHaveLength(1);
    const skill = confluencePlugin.skills![0]!;
    expect(skill.name).toBe("confluence");
    expect(skill.description.length).toBeGreaterThan(0);
    expect(skill.body).toContain("confluenceCommand");
  });

  it("builds a confluenceCommand tool and its status describer, and no guard", () => {
    const c = confluencePlugin.build!({ model: MODEL, env: {}, log: noLog });
    expect(Object.keys(c.sessionTools!(sctx, c.postProcess))).toEqual(["confluenceCommand"]);
    expect(c.toolStatusDescribers!.confluenceCommand!({ command: "confluence page search --cql X" }, echo)).toBe(
      'core.status.command {"binary":"confluence","command":"page search"}',
    );
    expect(c.toolStatusDescribers!.confluenceCommand!({}, echo)).toBe("core.status.command-unknown");
    expect(c.postTurnGuards ?? []).toEqual([]);
  });

  it("needs no environment variable: the links come from the CLI", () => {
    expect(() => confluencePlugin.build!({ model: MODEL, env: {}, log: noLog })).not.toThrow();
  });

  it("contributes the list extractor as its post-processor", () => {
    const c = confluencePlugin.build!({ model: MODEL, env: {}, log: noLog });
    expect(
      c.postProcess!({ binary: "confluence", args: ["page", "search"], prefix: ["page", "search"] }, { ok: true, data: { results: [] } }, echo),
    ).toEqual({ ok: true, data: { results: [], pageCount: 0 }, display: { type: "page-list", items: [] } });
  });

  it("acts as the person: runs their commands with --user, and asks for their login when the CLI says they aren't logged in", async () => {
    expect(confluencePlugin.actsAs).toBe("person");
    const runs: string[][] = [];
    const plugin = createConfluencePlugin({
      runCliFn: async (_binary, args) => {
        runs.push(args);
        return args[0] === "doctor"
          ? { ok: true, data: {} }
          : { ok: false, error: "confluence exited with code 3: user static:alice is not logged in", exitCode: 3 };
      },
    });
    const c = plugin.build!({ model: MODEL, env: {}, log: noLog });
    const login = { ok: false as const, loginRequired: true as const, service: "confluence", authorizeUrl: "https://auth", error: "log in" };
    const tool = c.sessionTools!({ ...sctx, person: { key: "static:alice" }, requireLogin: async () => login }, c.postProcess).confluenceCommand!;
    await tool.execute!({ command: "confluence doctor" }, {} as never);
    expect(runs).toEqual([["doctor", "--user", "static:alice"]]);
    expect(await tool.execute!({ command: "confluence page get 1 --select title" }, {} as never)).toEqual(login);
  });

  it("starts the person's login with Mercury's callback as the redirect URI, and finishes it with the code and the state", async () => {
    const calls: string[][] = [];
    const plugin = createConfluencePlugin({
      runCliFn: async (_binary, args) => {
        calls.push(args);
        return args.includes("--remote")
          ? { ok: true, data: { authorize_url: "https://auth.atlassian.com/authorize?x", state: "st" } }
          : { ok: true, data: {} };
      },
    });
    const login = plugin.build!({ model: MODEL, env: {}, log: noLog }).login!;
    expect(await login.start("static:alice", "https://mercury.example.com/login/callback")).toEqual({
      ok: true,
      authorizeUrl: "https://auth.atlassian.com/authorize?x",
      state: "st",
    });
    expect(await login.complete("static:alice", "the-code", "st")).toEqual({ ok: true });
    expect(calls).toEqual([
      ["auth", "login", "--user", "static:alice", "--remote", "--redirect-uri", "https://mercury.example.com/login/callback"],
      ["auth", "login", "--user", "static:alice", "--code", "the-code", "--state", "st"],
    ]);
  });
});

describe("the confluence skill agrees with the CLI", () => {
  const body = confluencePlugin.skills![0]!.body;

  it("gives the exact selects the two lists are built from", () => {
    expect(body).toContain(`--select ${CONFLUENCE_PAGE_LIST_SELECT}`);
    expect(body).toContain(`--select ${CONFLUENCE_CHILD_PAGES_SELECT}`);
  });

  it("puts --select on every example of a command that requires it", () => {
    const examples = [...body.matchAll(/`(confluence (?:page (?:search|get|children|ancestors|comments)|space list)\b[^`]*)`/g)].map((m) => m[1]!);
    expect(examples.length).toBeGreaterThanOrEqual(6);
    for (const example of examples) expect(example).toContain("--select ");
  });

  // An instance can also have a plugin with a query language of its own: the
  // skill always says which one it means.
  it("calls the query language Confluence CQL, never bare CQL", () => {
    expect(body).toContain("Confluence CQL");
    expect(body.match(/(?<!Confluence )CQL/g)).toBeNull();
  });

  // Seen live: `space = IN` fails, IN being a reserved word of the language.
  it("quotes space keys, and says why", () => {
    expect(body).toContain('space = "ENG"');
    expect(body).not.toMatch(/space ?= ?[A-Z~]/);
    expect(body).toContain("reserved");
  });

  it("pages with nextCursor and --start, and reads pageCount", () => {
    expect(body).toContain("nextCursor");
    expect(body).toContain("--start");
    expect(body).toContain("pageCount");
  });

  it("shows lists through present, and leaves the login link to the channel", () => {
    expect(body).toContain("displayRef");
    expect(body).toContain("`present`");
    expect(body).toContain("Never write a login link yourself");
  });

  it("reads pages as Markdown, never storage", () => {
    expect(body).toContain("body.markdown.value");
    expect(body).not.toContain("--body-format storage");
  });

  // Seen live: a page's `_links.webui` is relative to the site, so an answer
  // built on it has no link anyone can open; `link` is absolute.
  it("asks page get for the page's absolute link, not _links.webui", () => {
    expect(body).toContain("`confluence page get 123456 --select title,body.markdown.value,link`");
    expect(body).not.toContain("_links.webui");
  });

  it("names no command the plugin doesn't allow", () => {
    for (const forbidden of ["page create", "page update", "page delete", "template ", "auth login", "confluence init"]) {
      expect(body).not.toContain(forbidden);
    }
  });
});

describe("confluencePlugin's texts for the model", () => {
  it("never name Mercury", () => {
    const c = confluencePlugin.build!({ model: MODEL, env: {}, log: noLog });
    const texts = [
      confluencePlugin.description,
      ...(confluencePlugin.skills ?? []).flatMap((s) => [s.description, s.body]),
      ...Object.values(c.sessionTools!(sctx, c.postProcess)).map((t) => (typeof t.description === "string" ? t.description : "")),
    ];
    for (const text of texts) expect(text).not.toContain("Mercury");
  });
});
