/**
 * The app commands as the docker compose calls they make, in order, from the
 * app's folder: the exact argv of each call, what a failing call does to the
 * rest, and the exit code that comes back.
 */
import { describe, expect, test } from "bun:test";
import { appCommands, terminalDeps, type AppDeps } from "./commands.ts";

const APP = { dir: "/apps/my-agent", name: "my-agent" };

/** Deps that record every call; `codes` are the exit codes of the successive
 * `run` calls (0 past the end), `captured` what each `capture` returns. */
function fake({
  codes = [],
  captured = {},
  answer = "",
}: { codes?: number[]; captured?: Record<string, string>; answer?: string } = {}) {
  const asked: string[] = [];
  const printed: string[] = [];
  const calls: Array<{ kind: "run" | "capture"; argv: string[]; cwd: string }> = [];
  const deps: AppDeps = {
    run: async (argv, { cwd }) => {
      calls.push({ kind: "run", argv, cwd });
      return codes.shift() ?? 0;
    },
    capture: async (argv, { cwd }) => {
      calls.push({ kind: "capture", argv, cwd });
      return captured[argv.join(" ")] ?? "";
    },
    ask: async (q) => {
      asked.push(q);
      return answer;
    },
    print: (line) => void printed.push(line),
    home: "/nonexistent-home",
  };
  return { deps, calls, asked, printed, runs: () => calls.filter((c) => c.kind === "run").map((c) => c.argv) };
}

describe("lifecycle", () => {
  test("start builds what changed and starts in the background", async () => {
    const f = fake();
    expect(await appCommands(APP, f.deps).start({ noCache: false })).toBe(0);
    expect(f.runs()).toEqual([["docker", "compose", "up", "-d", "--build"]]);
    expect(f.calls.every((c) => c.cwd === APP.dir)).toBe(true);
  });

  test("start --no-cache rebuilds from scratch, then starts", async () => {
    const f = fake();
    expect(await appCommands(APP, f.deps).start({ noCache: true })).toBe(0);
    expect(f.runs()).toEqual([
      ["docker", "compose", "build", "--no-cache"],
      ["docker", "compose", "up", "-d"],
    ]);
  });

  test("a failed build stops there, with its exit code", async () => {
    const f = fake({ codes: [17] });
    expect(await appCommands(APP, f.deps).start({ noCache: true })).toBe(17);
    expect(f.runs()).toEqual([["docker", "compose", "build", "--no-cache"]]);
  });

  test("restart recreates the containers even when nothing changed", async () => {
    const f = fake();
    await appCommands(APP, f.deps).restart({ noCache: false });
    expect(f.runs()).toEqual([["docker", "compose", "up", "-d", "--build", "--force-recreate"]]);
  });

  test("restart --no-cache", async () => {
    const f = fake();
    await appCommands(APP, f.deps).restart({ noCache: true });
    expect(f.runs()).toEqual([
      ["docker", "compose", "build", "--no-cache"],
      ["docker", "compose", "up", "-d", "--force-recreate"],
    ]);
  });

  test("stop", async () => {
    const f = fake();
    await appCommands(APP, f.deps).stop();
    expect(f.runs()).toEqual([["docker", "compose", "down"]]);
  });
});

describe("logs, repl, shell", () => {
  test("logs follows every service, or the one named", async () => {
    const f = fake();
    await appCommands(APP, f.deps).logs();
    await appCommands(APP, f.deps).logs("qdrant");
    expect(f.runs()).toEqual([
      ["docker", "compose", "logs", "-f"],
      ["docker", "compose", "logs", "-f", "qdrant"],
    ]);
  });

  test("repl opens the dev REPL in a one-off container", async () => {
    const f = fake();
    await appCommands(APP, f.deps).repl();
    expect(f.runs()).toEqual([["docker", "compose", "run", "--rm", "mercury", "bun", "run", "repl"]]);
  });

  test("shell joins the running service", async () => {
    const f = fake({ captured: { "docker compose ps --status running --services": "qdrant\nmercury\n" } });
    await appCommands(APP, f.deps).shell();
    expect(f.runs()).toEqual([["docker", "compose", "exec", "mercury", "bash"]]);
  });

  test("shell opens a one-off container when the service isn't running", async () => {
    const f = fake({ captured: { "docker compose ps --status running --services": "qdrant\n" } });
    await appCommands(APP, f.deps).shell();
    expect(f.runs()).toEqual([["docker", "compose", "run", "--rm", "mercury", "bash"]]);
  });
});

describe("vault and memory", () => {
  test("vault passes its subcommand and arguments to the core's vault CLI in a one-off container", async () => {
    const f = fake();
    await appCommands(APP, f.deps).vault(["write-curated", "curated/x.md", "--author", "luca"]);
    expect(f.runs()).toEqual([
      ["docker", "compose", "run", "--rm", "-T", "mercury", "bun", "node_modules/@mercury-fw/core/src/wiki/vault-cli.ts", "write-curated", "curated/x.md", "--author", "luca"],
    ]);
  });

  test("identity passes its subcommand and arguments to the core's account links CLI", async () => {
    const f = fake();
    await appCommands(APP, f.deps).identity(["link", "google-chat:users/1", "oidc:3123"]);
    expect(f.runs()).toEqual([
      ["docker", "compose", "run", "--rm", "-T", "mercury", "bun", "node_modules/@mercury-fw/core/src/identity/links-cli.ts", "link", "google-chat:users/1", "oidc:3123"],
    ]);
  });

  test("memory passes its subcommand and arguments to the core's memory CLI", async () => {
    const f = fake();
    await appCommands(APP, f.deps).memory(["read", "episodic_memory", "--limit", "5"]);
    expect(f.runs()).toEqual([
      ["docker", "compose", "run", "--rm", "-T", "mercury", "bun", "node_modules/@mercury-fw/core/src/memory/memory-cli.ts", "read", "episodic_memory", "--limit", "5"],
    ]);
  });

  test("the container's exit code comes back", async () => {
    const f = fake({ codes: [2] });
    expect(await appCommands(APP, f.deps).vault(["read", "missing.md"])).toBe(2);
  });
});

describe("reset", () => {
  const CONFIG = "docker compose config --no-interpolate --format json";
  const compose = JSON.stringify({
    services: { mercury: {}, qdrant: {} },
    volumes: {
      "wiki-vault": { name: "my-agent_wiki-vault" },
      "qdrant-data": { name: "my-agent_qdrant-data" },
    },
  });

  test("memory, confirmed with the app's name: Qdrant's volume goes, Qdrant comes back empty", async () => {
    const f = fake({ captured: { [CONFIG]: compose }, answer: "my-agent" });
    expect(await appCommands(APP, f.deps).reset("memory")).toBe(0);
    expect(f.asked).toEqual([
      "This deletes Layer-3 memory (every Qdrant collection) for good: volume my-agent_qdrant-data. Type the app's name (my-agent) to confirm: ",
    ]);
    expect(f.runs()).toEqual([
      ["docker", "compose", "stop", "qdrant"],
      ["docker", "compose", "rm", "-f", "qdrant"],
      ["docker", "volume", "rm", "my-agent_qdrant-data"],
      ["docker", "compose", "up", "-d", "qdrant"],
    ]);
  });

  test("wiki: the vault's volume goes, the app comes back with a fresh vault", async () => {
    const f = fake({ captured: { [CONFIG]: compose }, answer: "  my-agent\n" });
    expect(await appCommands(APP, f.deps).reset("wiki")).toBe(0);
    expect(f.runs()).toEqual([
      ["docker", "compose", "stop", "mercury"],
      ["docker", "compose", "rm", "-f", "mercury"],
      ["docker", "volume", "rm", "my-agent_wiki-vault"],
      ["docker", "compose", "up", "-d", "mercury"],
    ]);
  });

  test.each(["", "y", "yes", "My-Agent", "my-agen"])("answer %p: nothing is deleted, exit 1", async (answer) => {
    const f = fake({ captured: { [CONFIG]: compose }, answer });
    expect(await appCommands(APP, f.deps).reset("wiki")).toBe(1);
    expect(f.runs()).toEqual([]);
    expect(f.printed).toEqual(["Not confirmed: nothing deleted."]);
  });

  test("the volume name comes from the compose file, whatever it is", async () => {
    const custom = JSON.stringify({ volumes: { "qdrant-data": { name: "mercury_qdrant-data" } } });
    const f = fake({ captured: { [CONFIG]: custom }, answer: "my-agent" });
    await appCommands(APP, f.deps).reset("memory");
    expect(f.runs()).toContainEqual(["docker", "volume", "rm", "mercury_qdrant-data"]);
  });

  test("a compose file without that volume is an error before any question", async () => {
    const f = fake({ captured: { [CONFIG]: JSON.stringify({ volumes: {} }) }, answer: "my-agent" });
    await expect(appCommands(APP, f.deps).reset("wiki")).rejects.toThrow('no "wiki-vault" volume');
    expect(f.asked).toEqual([]);
    expect(f.runs()).toEqual([]);
  });

  // Regression: a step failing after the stop (the volume still in use, say)
  // left the service down with nothing but an exit code to show for it.
  test("a step failing after the stop says the service is down and how to bring it back", async () => {
    const f = fake({ captured: { [CONFIG]: compose }, answer: "my-agent", codes: [0, 0, 1] });
    expect(await appCommands(APP, f.deps).reset("memory")).toBe(1);
    expect(f.runs()).toHaveLength(3);
    expect(f.printed).toEqual(["The qdrant service was stopped and not restarted: mfw start brings it back."]);
  });

  test("a failed stop leaves nothing to say: nothing was stopped", async () => {
    const f = fake({ captured: { [CONFIG]: compose }, answer: "my-agent", codes: [1] });
    expect(await appCommands(APP, f.deps).reset("wiki")).toBe(1);
    expect(f.runs()).toHaveLength(1);
    expect(f.printed).toEqual([]);
  });

  // Regression: the running app sets up its Qdrant collections only when it
  // starts, so after a memory reset it wrote to collections that no longer
  // existed until someone restarted it.
  test("memory, with the app running: the app restarts too, to set up its collections again", async () => {
    const f = fake({
      captured: { [CONFIG]: compose, "docker compose ps --status running --services": "qdrant\nmercury\n" },
      answer: "my-agent",
    });
    expect(await appCommands(APP, f.deps).reset("memory")).toBe(0);
    expect(f.runs()).toEqual([
      ["docker", "compose", "stop", "qdrant"],
      ["docker", "compose", "rm", "-f", "qdrant"],
      ["docker", "volume", "rm", "my-agent_qdrant-data"],
      ["docker", "compose", "up", "-d", "qdrant"],
      ["docker", "compose", "restart", "mercury"],
    ]);
  });
});

describe("terminalDeps().ask", () => {
  // Regression: with stdin closed before an answer (`< /dev/null`, Ctrl+D, a
  // script), readline's question never settled and `mfw reset` hung forever.
  test("stdin closing without an answer counts as an empty answer", async () => {
    const { Readable, Writable } = await import("node:stream");
    const input = Readable.from([]);
    const output = new Writable({ write: (_chunk, _enc, done) => done() });
    const answer = await Promise.race([
      terminalDeps({ input, output }).ask("Type the app's name: "),
      Bun.sleep(2000).then(() => "TIMED OUT"),
    ]);
    expect(answer).toBe("");
  });

  test("a typed line is the answer", async () => {
    const { Readable, Writable } = await import("node:stream");
    const input = Readable.from(["my-agent\n"]);
    const output = new Writable({ write: (_chunk, _enc, done) => done() });
    expect(await terminalDeps({ input, output }).ask("Type the app's name: ")).toBe("my-agent");
  });
});
