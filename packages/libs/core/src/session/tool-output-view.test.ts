import { describe, expect, it } from "bun:test";
import { restoreStep } from "./tool-output-view.ts";
import type { StepInfo } from "./step-info.ts";

/**
 * A step as the AI SDK hands it over (`DefaultStepResult`): its own fields set
 * in the constructor, `toolCalls`, `toolResults` and `text` getters on the
 * class, read from `content`.
 */
class SdkLikeStep {
  stepNumber = 0;
  usage = { inputTokens: 120 };
  constructor(public content: Array<Record<string, unknown>>) {}
  get toolCalls() {
    return this.content.filter((p) => p.type === "tool-call");
  }
  get toolResults() {
    return this.content.filter((p) => p.type === "tool-result");
  }
  get text() {
    return this.content.filter((p) => p.type === "text").map((p) => p.text).join("");
  }
}

describe("restoreStep", () => {
  // Regression (#414): the step was spread (`{ ...step }`), which keeps an
  // object's own fields only: the AI SDK's getters (`toolCalls`, `text`)
  // vanished, and every turn with a conversation's view of tool outputs failed
  // on `step.toolCalls` being undefined.
  it("keeps every field of an AI SDK step, its getters included, with the tool results' outputs as the tools returned them", () => {
    const step = new SdkLikeStep([
      { type: "text", text: "Here." },
      { type: "tool-call", toolCallId: "c1", toolName: "fetch", input: { url: "u" } },
      { type: "tool-result", toolCallId: "c1", toolName: "fetch", output: { file: "outputs/1" } },
      { type: "tool-result", toolCallId: "c2", toolName: "other", output: "kept" },
    ]);
    const restored = restoreStep(step as unknown as StepInfo, new Map([["c1", { ok: true, data: "the whole page" }]])) as unknown as SdkLikeStep;

    expect(restored.toolCalls).toEqual([{ type: "tool-call", toolCallId: "c1", toolName: "fetch", input: { url: "u" } }]);
    expect(restored.toolResults).toEqual([
      { type: "tool-result", toolCallId: "c1", toolName: "fetch", output: { ok: true, data: "the whole page" } },
      { type: "tool-result", toolCallId: "c2", toolName: "other", output: "kept" },
    ]);
    expect(restored.content[2]).toEqual({ type: "tool-result", toolCallId: "c1", toolName: "fetch", output: { ok: true, data: "the whole page" } });
    expect(restored.text).toBe("Here.");
    expect(restored.stepNumber).toBe(0);
    expect(restored.usage).toEqual({ inputTokens: 120 });
    expect(JSON.parse(JSON.stringify(restored)).toolCalls).toHaveLength(1);
  });

  it("leaves the original step as it was", () => {
    const step = new SdkLikeStep([{ type: "tool-result", toolCallId: "c1", toolName: "fetch", output: { file: "outputs/1" } }]);
    restoreStep(step as unknown as StepInfo, new Map([["c1", "original"]]));
    expect(step.toolResults[0]!.output).toEqual({ file: "outputs/1" });
  });
});
