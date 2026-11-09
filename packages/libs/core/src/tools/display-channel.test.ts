/**
 * Tests for the core's display channel: every plugin tool's output loses its
 * `display` before the model sees it, a rendered one is stashed and handed
 * back as a `displayRef`, and one the instance shows always is marked `shown`.
 * #375: a typed tool's display used to reach the model's context as it was;
 * only the CLI engine stashed and stripped.
 */
import { describe, expect, it } from "bun:test";
import type { Tool } from "ai";
import { withDisplayChannel } from "./display-channel.ts";

type Stashed = { artifact: string; label: string; show: boolean };

/** A stash that records what it got and mints `d1`, `d2`, … */
function recordingStash() {
  const stashed: Stashed[] = [];
  const stash = (artifact: string, label: string, opts: { show: boolean }) => {
    stashed.push({ artifact, label, show: opts.show });
    return `d${stashed.length}`;
  };
  return { stashed, stash };
}

const callOptions = { toolCallId: "c1", messages: [] };

/** Wraps a single tool `find` returning `output`, runs it with `input`. */
async function run(output: unknown, input: unknown = { query: "q" }) {
  const { stashed, stash } = recordingStash();
  const tools = withDisplayChannel({ find: { description: "Finds.", execute: async () => output } as unknown as Tool }, stash);
  const result = await (tools.find!.execute as (i: unknown, o: unknown) => Promise<unknown>)(input, callOptions);
  return { result, stashed };
}

describe("withDisplayChannel", () => {
  it("stashes a rendered display and hands the model its ref instead", async () => {
    const { result, stashed } = await run({ ok: true, query: "q", display: { type: "link", items: ["https://x/?q=a%20b"] } });

    expect(result).toEqual({ ok: true, query: "q", displayRef: "d1" });
    expect(stashed).toEqual([{ artifact: "https://x/?q=a%20b", label: 'find {"query":"q"} (1 item)', show: false }]);
  });

  it("joins several rendered items one blank line apart, and counts them", async () => {
    const { stashed } = await run({ ok: true, display: { type: "list", items: ["A", "B"] } });
    expect(stashed).toEqual([{ artifact: "A\n\nB", label: 'find {"query":"q"} (2 items)', show: false }]);
  });

  // #376: the instance's rule says this kind is the answer itself.
  it("shows a display marked always at finalize, and tells the model it's shown", async () => {
    const { result, stashed } = await run({ ok: true, display: { type: "link", items: ["https://x"], always: true } });

    expect(result).toEqual({ ok: true, displayRef: "d1", shown: true });
    expect(stashed).toEqual([{ artifact: "https://x", label: 'find {"query":"q"} (1 item)', show: true }]);
  });

  it("strips a display still structured (no rule rendered it), with nothing to stash", async () => {
    const { result, stashed } = await run({ ok: true, data: 1, display: { type: "list", items: [{ id: "A" }] } });
    expect(result).toEqual({ ok: true, data: 1 });
    expect(stashed).toEqual([]);
  });

  it("strips a display from a failed result too, never stashing it", async () => {
    const { result, stashed } = await run({ ok: false, error: "boom", display: { type: "list", items: ["A"] } });
    expect(result).toEqual({ ok: false, error: "boom" });
    expect(stashed).toEqual([]);
  });

  it("leaves an output with no display, or not an object, as it is", async () => {
    const plain = { ok: true, data: { n: 1 } };
    expect((await run(plain)).result).toBe(plain);
    expect((await run("text")).result).toBe("text");
    expect((await run(null)).result).toBe(null);
  });

  it("cuts a long input in the label, keeping the count", async () => {
    const { stashed } = await run({ ok: true, display: { type: "list", items: ["A"] } }, { query: "x".repeat(500) });
    const label = stashed[0]!.label;
    expect(label.length).toBeLessThanOrEqual(200);
    expect(label.startsWith('find {"query":"xxx')).toBe(true);
    expect(label.endsWith("… (1 item)")).toBe(true);
  });

  it("hands the tool the call's input and options, and keeps its other fields", async () => {
    let received: unknown[] = [];
    const toModelOutput = () => ({ type: "text" as const, value: "x" });
    const bare = { description: "No execute." } as unknown as Tool;
    const { stash } = recordingStash();
    const tools = withDisplayChannel(
      {
        find: { description: "Finds.", toModelOutput, execute: async (...a: unknown[]) => ((received = a), { ok: true }) } as unknown as Tool,
        bare,
      },
      stash,
    );
    await (tools.find!.execute as (i: unknown, o: unknown) => Promise<unknown>)({ query: "x" }, callOptions);

    expect(received).toEqual([{ query: "x" }, callOptions]);
    expect(tools.find!.description).toBe("Finds.");
    expect(tools.find!.toModelOutput).toBe(toModelOutput);
    expect(tools.bare).toBe(bare);
  });
});
