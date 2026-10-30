import { describe, it, expect } from "bun:test";
import { callMessages, callRecords, HISTORY_CALL_NOTE, SKILL_CALL_NOTE } from "./call-record.ts";
import type { StepInfo } from "./step-info.ts";

function step(
  toolCalls: StepInfo["toolCalls"],
  toolResults: StepInfo["toolResults"],
  content: StepInfo["content"] = [],
): StepInfo {
  return { toolCalls, toolResults, content };
}

function cli(id: string, command: string) {
  return { toolCallId: id, toolName: "confluenceCommand", input: { command } };
}

function out(id: string, output: unknown, toolName = "confluenceCommand") {
  return { toolCallId: id, toolName, output };
}

// These records are what the next turns see of this one's tool calls: without
// them the history shows only plain-text answers, and the model learns to stop
// calling tools and to invent the data instead (#351).
describe("callRecords", () => {
  it("records every call of every step, in order, with what it ran and how it went", () => {
    const steps = [
      step([{ toolCallId: "1", toolName: "read_skill", input: { name: "confluence" } }], [out("1", { ok: true, data: "the skill" }, "read_skill")]),
      step(
        [cli("2", "confluence page search --cql 'text ~ \"docker\"' --select results.content.id")],
        [out("2", { ok: true, data: { results: [{ id: "1" }, { id: "2" }, { id: "3" }] }, displayRef: "d1" })],
      ),
      step([{ toolCallId: "3", toolName: "present", input: { ref: "d1" } }], [out("3", { ok: true }, "present")]),
    ];
    expect(callRecords(steps)).toEqual([
      { toolName: "read_skill", input: { name: "confluence" }, result: { ok: true, ran: '{"name":"confluence"}' } },
      {
        toolName: "confluenceCommand",
        input: { command: "confluence page search --cql 'text ~ \"docker\"' --select results.content.id" },
        result: { ok: true, ran: "confluence page search --cql 'text ~ \"docker\"' --select results.content.id", results: 3, displayRef: "d1" },
      },
      { toolName: "present", input: { ref: "d1" }, result: { ok: true, ran: '{"ref":"d1"}' } },
    ]);
  });

  it("says found: false for a call that found nothing, so the model doesn't search again blindly", () => {
    const steps = [step([cli("1", "confluence page children 1103")], [out("1", { ok: true, data: { results: [] } })])];
    expect(callRecords(steps)[0]!.result).toEqual({ ok: true, ran: "confluence page children 1103", results: 0, found: false });
  });

  it("counts a result that is itself an array, a data array, or the first array field", () => {
    const records = callRecords([
      step(
        [cli("1", "a"), cli("2", "b"), cli("3", "c")],
        [out("1", [1, 2]), out("2", { ok: true, data: [1, 2, 3, 4] }), out("3", { ok: true, total: 9, files: ["x"], other: [1, 2] })],
      ),
    ]);
    expect(records.map((r) => r.result.results)).toEqual([2, 4, 1]);
  });

  it("leaves the count out when it can't be told: a page read, plain text, no array", () => {
    const records = callRecords([
      step(
        [cli("1", "confluence page get 1101"), cli("2", "confluence --help"), cli("3", "x")],
        [out("1", { ok: true, data: { id: "1101", title: "Deploy", body: "…" } }), out("2", { ok: true, data: "Usage: confluence" }), out("3", { ok: true })],
      ),
    ]);
    for (const r of records) {
      expect(r.result).not.toHaveProperty("results");
      expect(r.result).not.toHaveProperty("found");
    }
  });

  it("keeps the error of a call that failed, so the same rejected command isn't sent again", () => {
    const steps = [step([cli("1", "confluence page read 1101")], [out("1", { ok: false, error: "not permitted on this instance" })])];
    expect(callRecords(steps)[0]!.result).toEqual({ ok: false, ran: "confluence page read 1101", error: "not permitted on this instance" });
  });

  it("records a call that failed before running (a tool-error, no result) as failed, with its error", () => {
    const steps = [
      step([cli("1", "confluence page get")], [], [{ type: "tool-error", toolCallId: "1", error: new Error("invalid arguments") }]),
    ];
    expect(callRecords(steps)[0]!.result).toEqual({ ok: false, ran: "confluence page get", error: "invalid arguments" });
  });

  it("records a call with no result and no tool-error as failed, with no error text", () => {
    expect(callRecords([step([cli("1", "x")], [])])[0]!.result).toEqual({ ok: false, ran: "x" });
  });

  it("cuts what it ran and the error at 300 characters, and long input strings at 500", () => {
    const long = "a".repeat(800);
    const steps = [
      step(
        [{ toolCallId: "1", toolName: "write_file", input: { path: "n.md", content: long } }, cli("2", long)],
        [out("1", { ok: true }, "write_file"), out("2", { ok: false, error: long })],
      ),
    ];
    const [note, command] = callRecords(steps);
    expect(note!.input).toEqual({ path: "n.md", content: `${"a".repeat(500)}…` });
    expect(note!.result.ran.length).toBe(301);
    expect(note!.result.ran.endsWith("…")).toBe(true);
    expect(command!.input).toEqual({ command: `${"a".repeat(500)}…` });
    expect(command!.result.ran).toBe(`${"a".repeat(300)}…`);
    expect(command!.result.error).toBe(`${"a".repeat(300)}…`);
  });

  it("returns no records for a turn without tool calls", () => {
    expect(callRecords([])).toEqual([]);
    expect(callRecords([step([], [])])).toEqual([]);
  });
});

describe("callMessages", () => {
  it("turns records into the assistant's tool calls and a tool message of reduced results, ids from the prefix", () => {
    const records = callRecords([
      step(
        [cli("x", "confluence page children 1103"), { toolCallId: "y", toolName: "present", input: { ref: "d1" } }],
        [out("x", { ok: true, data: { results: [] } }), out("y", { ok: true }, "present")],
      ),
    ]);
    expect(callMessages(records, "history-4")).toEqual([
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: "history-4-0", toolName: "confluenceCommand", input: { command: "confluence page children 1103" } },
          { type: "tool-call", toolCallId: "history-4-1", toolName: "present", input: { ref: "d1" } },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "history-4-0",
            toolName: "confluenceCommand",
            output: { type: "json", value: { ok: true, ran: "confluence page children 1103", results: 0, found: false, note: HISTORY_CALL_NOTE } },
          },
          {
            type: "tool-result",
            toolCallId: "history-4-1",
            toolName: "present",
            output: { type: "json", value: { ok: true, ran: '{"ref":"d1"}', note: HISTORY_CALL_NOTE } },
          },
        ],
      },
    ]);
  });

  it("says, in the note, that the data isn't kept and how to get it again", () => {
    expect(HISTORY_CALL_NOTE).toBe(
      "Data not kept in the conversation history. Run the tool again for current data, or call recall_tool_calls for what it returned then.",
    );
  });

  it("returns nothing for no records", () => {
    expect(callMessages([], "history-0")).toEqual([]);
  });

  // The skill's text isn't in the history: with the generic note the model saw
  // its own read_skill call, took the skill for still loaded and didn't read it
  // again (13 later turns out of 120, against 90 before the calls were kept),
  // then guessed the commands the skill names (#356).
  it("gives a read_skill call the note that the skill must be read again, the other calls the generic one", () => {
    const records = callRecords([
      step(
        [{ toolCallId: "1", toolName: "read_skill", input: { name: "confluence" } }, cli("2", "confluence page comments 2101")],
        [out("1", { ok: true, data: "the skill" }, "read_skill"), out("2", { ok: true, data: { results: [] } })],
      ),
    ]);
    expect(callMessages(records, "history-2")[1]).toEqual({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "history-2-0",
          toolName: "read_skill",
          output: { type: "json", value: { ok: true, ran: '{"name":"confluence"}', note: SKILL_CALL_NOTE } },
        },
        {
          type: "tool-result",
          toolCallId: "history-2-1",
          toolName: "confluenceCommand",
          output: { type: "json", value: { ok: true, ran: "confluence page comments 2101", results: 0, found: false, note: HISTORY_CALL_NOTE } },
        },
      ],
    });
  });

  it("keeps the error of a failed read_skill, with the same note", () => {
    const records = callRecords([
      step([{ toolCallId: "1", toolName: "read_skill", input: { name: "nope" } }], [out("1", { ok: false, error: 'no skill named "nope"' }, "read_skill")]),
    ]);
    expect(callMessages(records, "history-0")[1]!.content).toEqual([
      {
        type: "tool-result",
        toolCallId: "history-0-0",
        toolName: "read_skill",
        output: { type: "json", value: { ok: false, ran: '{"name":"nope"}', error: 'no skill named "nope"', note: SKILL_CALL_NOTE } },
      },
    ]);
  });

  it("says, in the skill's note, that its text isn't kept and that it must be read again", () => {
    expect(SKILL_CALL_NOTE).toBe(
      "The skill's text is not kept in the conversation history: call read_skill again to load it before using its tools.",
    );
  });
});
