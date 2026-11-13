import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLUGIN_API_VERSION, type PluginRuntimeContext, type SessionToolContext } from "@mercury-fw/plugin-types";
import { wiki, WIKI_MESSAGES } from "./index.ts";

const tempDirs: string[] = [];
const savedEnv = process.env.WIKI_VAULT_PATH;

afterEach(async () => {
  while (tempDirs.length > 0) await rm(tempDirs.pop()!, { recursive: true, force: true });
  if (savedEnv === undefined) delete process.env.WIKI_VAULT_PATH;
  else process.env.WIKI_VAULT_PATH = savedEnv;
});

async function tempVault(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mercury-wiki-plugin-"));
  tempDirs.push(dir);
  return join(dir, "vault");
}

type DailyCall = { name: string; when: { at: string; timeZone?: string }; fn: () => void | Promise<void> };

/** A build context recording what the plugin asks of the core. */
function ctxWith() {
  const logs: string[] = [];
  const daily: DailyCall[] = [];
  const ctx = {
    model: {} as never,
    backgroundModel: {} as never,
    env: {},
    log: (m: string) => logs.push(m),
    daily: (name: string, when: DailyCall["when"], fn: DailyCall["fn"]) => daily.push({ name, when, fn }),
    job: async <T,>(_name: string, _urgency: string, fn: () => Promise<T>) => fn(),
  } as unknown as PluginRuntimeContext;
  return { ctx, logs, daily };
}

/** A turn's tool context for the person `key` (`null`: acting as nobody). */
function sessionCtx(key: string | null): SessionToolContext {
  return {
    sessionKey: "s",
    t: (k: string) => k,
    stageConfirmation: async () => "tok",
    stashDisplay: () => "ref",
    person: key === null ? null : { key },
  } as unknown as SessionToolContext;
}

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

describe("wiki", () => {
  it("is a plugin acting as no one, describing its tools to the model", async () => {
    const plugin = wiki({ vaultPath: await tempVault() });
    expect(plugin.apiVersion).toBe(PLUGIN_API_VERSION);
    expect(plugin.name).toBe("wiki");
    expect(plugin.actsAs).toBe("anyone");
    expect(plugin.description.length).toBeGreaterThan(0);
    expect(plugin.messages).toEqual(WIKI_MESSAGES);
    for (const tool of ["list_files", "read_file", "grep", "write_file", "promote_note"]) {
      expect(plugin.systemPromptFragment).toContain(tool);
    }
    expect(plugin.systemPromptFragment).not.toContain("resolve_reference");
  });

  // #222: a tool text naming Mercury made the model take that for its own name.
  it("never names Mercury in what the model reads", async () => {
    const plugin = wiki({ vaultPath: await tempVault() });
    expect(plugin.systemPromptFragment).not.toContain("Mercury");
    const { ctx } = ctxWith();
    const tools = (await plugin.build!(ctx)).sessionTools!(sessionCtx("static:alice"));
    for (const [name, t] of Object.entries(tools)) {
      expect({ name, description: t.description ?? "" }).not.toEqual(
        expect.objectContaining({ description: expect.stringContaining("Mercury") }),
      );
    }
  });

  it("takes the vault from WIKI_VAULT_PATH when vaultPath isn't given", async () => {
    const vault = await tempVault();
    process.env.WIKI_VAULT_PATH = vault;
    const { ctx } = ctxWith();
    await wiki().build!(ctx);
    expect(await exists(join(vault, ".git"))).toBe(true);
  });

  it("stops the start without a vault: no vaultPath and no WIKI_VAULT_PATH", () => {
    delete process.env.WIKI_VAULT_PATH;
    expect(() => wiki()).toThrow("WIKI_VAULT_PATH");
    process.env.WIKI_VAULT_PATH = "";
    expect(() => wiki()).toThrow("WIKI_VAULT_PATH");
  });

  it("sets the vault up when it's built: a git repository with its folders and index", async () => {
    const vault = await tempVault();
    const { ctx } = ctxWith();
    await wiki({ vaultPath: vault }).build!(ctx);
    expect(await exists(join(vault, ".git"))).toBe(true);
    expect(await exists(join(vault, "curated"))).toBe(true);
    expect(await exists(join(vault, "raw"))).toBe(true);
  });

  it("gives each person their wiki tools, and none to a turn acting as nobody", async () => {
    const { ctx } = ctxWith();
    const built = await wiki({ vaultPath: await tempVault() }).build!(ctx);
    expect(Object.keys(built.sessionTools!(sessionCtx("static:alice"))).sort()).toEqual([
      "grep",
      "list_files",
      "promote_note",
      "read_file",
      "write_file",
    ]);
    expect(built.sessionTools!(sessionCtx(null))).toEqual({});
  });

  it("scopes the tools to the person: what one writes the other doesn't see", async () => {
    const { ctx } = ctxWith();
    const built = await wiki({ vaultPath: await tempVault() }).build!(ctx);
    const call = (tool: { execute?: unknown }, input: unknown) =>
      (tool.execute as (i: unknown, o: never) => Promise<Record<string, unknown>>)(input, {} as never);
    const alice = built.sessionTools!(sessionCtx("static:alice"));
    const bob = built.sessionTools!(sessionCtx("static:bob"));
    expect((await call(alice.write_file!, { path: "personal/notes/a.md", content: "Alice's" })).ok).toBe(true);
    expect(await call(alice.list_files!, {})).toEqual({ ok: true, files: ["personal/notes/a.md"] });
    expect(await call(bob.list_files!, {})).toEqual({ ok: true, files: [] });
  });

  it("labels its tools for the person, in their language", async () => {
    const { ctx } = ctxWith();
    const built = await wiki({ vaultPath: await tempVault() }).build!(ctx);
    const t = (key: string) => `<${key}>`;
    const describe = built.toolStatusDescribers!;
    expect(describe.list_files!({}, t as never)).toBe("<wiki.status.read>");
    expect(describe.read_file!({}, t as never)).toBe("<wiki.status.read>");
    expect(describe.grep!({}, t as never)).toBe("<wiki.status.search>");
    expect(describe.write_file!({}, t as never)).toBe("<wiki.status.write>");
    expect(describe.promote_note!({}, t as never)).toBe("<wiki.status.write>");
  });

  describe("the index layer", () => {
    it("is built once per session, with the index's content", async () => {
      const vault = await tempVault();
      const { ctx } = ctxWith();
      const built = await wiki({ vaultPath: vault }).build!(ctx);
      await writeFile(join(vault, "index.md"), "- [[standards/jira-fields]] — custom field conventions\n");
      expect(built.context!.scope).toBe("session");
      expect(await built.context!.build({} as never)).toEqual(["Wiki index:\n- [[standards/jira-fields]] — custom field conventions"]);
    });

    it("adds nothing when the index is empty", async () => {
      const vault = await tempVault();
      const { ctx } = ctxWith();
      const built = await wiki({ vaultPath: vault }).build!(ctx);
      await writeFile(join(vault, "index.md"), "  \n");
      expect(await built.context!.build({} as never)).toEqual([]);
    });
  });

  describe("the nightly review", () => {
    it("runs every day at 03:00 in the instance's time zone by default", async () => {
      const { ctx, daily } = ctxWith();
      await wiki({ vaultPath: await tempVault() }).build!(ctx);
      expect(daily.map((d) => [d.name, d.when])).toEqual([["review", { at: "03:00" }]]);
    });

    it("runs at the time and in the time zone given", async () => {
      const { ctx, daily } = ctxWith();
      await wiki({ vaultPath: await tempVault(), review: { at: "22:30", timeZone: "Europe/Rome" } }).build!(ctx);
      expect(daily.map((d) => [d.name, d.when])).toEqual([["review", { at: "22:30", timeZone: "Europe/Rome" }]]);
    });

    // Review: the passes are wired here, in wiki(); a wrong root or the turn's
    // model in place of the background one passed every other test.
    it("runs each pass with something to do as a job, on the background model", async () => {
      const vault = await tempVault();
      const used: string[] = [];
      /** A model that records who called it and fails, ending the pass there. */
      const fakeModel = (id: string) => ({
        specificationVersion: "v3",
        provider: "fake",
        modelId: id,
        supportedUrls: {},
        doGenerate: async () => {
          used.push(id);
          throw new Error("stop here");
        },
        doStream: async () => {
          used.push(id);
          throw new Error("stop here");
        },
      });
      const { ctx, daily, logs } = ctxWith();
      const jobs: string[] = [];
      Object.assign(ctx, {
        model: fakeModel("turn"),
        backgroundModel: fakeModel("background"),
        job: async <T,>(name: string, urgency: string, fn: () => Promise<T>) => (jobs.push(`${name}:${urgency}`), fn()),
      });
      await wiki({ vaultPath: vault }).build!(ctx);
      await writeFile(join(vault, "raw", "pasted.md"), "a pasted note");
      await writeFile(join(vault, "curated", "standards", "orphan.md"), "---\nlast_updated: 2026-11-13\n---\n\nnot in the index\n");

      await daily[0]!.fn();

      expect(jobs).toEqual(["review-raw:idle", "review-index:idle", "review-contradictions:idle"]);
      expect(used).toEqual(["background", "background", "background"]);
      expect(logs.filter((l) => l.includes("pass failed"))).toHaveLength(3);
    });

    it("stops the start when the core refuses the review's time", async () => {
      const { ctx } = ctxWith();
      Object.assign(ctx, {
        daily: () => {
          throw new Error("daily: at must be HH:MM");
        },
      });
      await expect(wiki({ vaultPath: await tempVault(), review: { at: "25:99" } }).build!(ctx)).rejects.toThrow("HH:MM");
    });

    it("isn't scheduled with review: false", async () => {
      const { ctx, daily } = ctxWith();
      await wiki({ vaultPath: await tempVault(), review: false }).build!(ctx);
      expect(daily).toEqual([]);
    });
  });
});
