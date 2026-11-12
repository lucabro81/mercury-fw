/**
 * Tests for the core's queue of model work (#383): turns are never held back,
 * work nobody waits on runs a model call at a time in the slots turns leave
 * free, `soon` before `idle`, and a stop drops what's still waiting. Every
 * wait here is a promise the test resolves itself: no timers, no wall clock.
 */
import { describe, expect, test } from "bun:test";
import { createScheduler, DroppedError } from "./scheduler.ts";
import { ollamaEmbedding, ollamaModel } from "./models.ts";
import { convertArrayToReadableStream, convertReadableStreamToArray, MockEmbeddingModelV4, MockLanguageModelV4 } from "ai/test";

/** A promise the test settles by hand. */
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Lets every already-settled promise's continuations run. */
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

/** A step on `handle` inside a job of its own, recording when it starts; it ends when the returned `finish` is called. */
function backgroundStep(
  scheduler: ReturnType<typeof createScheduler>,
  handle: Parameters<ReturnType<typeof createScheduler>["call"]>[0],
  label: string,
  started: string[],
  urgency: "soon" | "idle" = "idle",
) {
  const done = deferred();
  const result = scheduler.job({ job: "capture", urgency }, () =>
    scheduler.call(handle, async () => {
      started.push(label);
      await done.promise;
      return label;
    }),
  );
  return { finish: () => done.resolve(), result };
}

describe("scheduler: one slot (a model served one request at a time)", () => {
  test("background work runs at once when nobody is in a turn", async () => {
    const scheduler = createScheduler();
    const model = ollamaModel("qwen");
    const started: string[] = [];
    const step = backgroundStep(scheduler, model, "a", started);
    await flush();
    expect(started).toEqual(["a"]);
    step.finish();
    expect(await step.result).toBe("a");
  });

  test("it waits while a turn runs or waits, and starts once the turn ends", async () => {
    const scheduler = createScheduler();
    const model = ollamaModel("qwen");
    const started: string[] = [];
    const release = scheduler.holdTurn(model);
    const step = backgroundStep(scheduler, model, "a", started);
    await flush();
    expect(started).toEqual([]);
    release();
    await flush();
    expect(started).toEqual(["a"]);
    step.finish();
    await step.result;
  });

  test("a turn arriving mid-job goes before the job's next step", async () => {
    const scheduler = createScheduler();
    const model = ollamaModel("qwen");
    const order: string[] = [];
    const first = deferred();
    const job = scheduler.job({ job: "review", urgency: "idle" }, async () => {
      await scheduler.call(model, async () => {
        order.push("step 1");
        await first.promise;
      });
      await scheduler.call(model, async () => {
        order.push("step 2");
      });
    });
    await flush();
    expect(order).toEqual(["step 1"]);
    // The turn isn't held back: it counts at once, and the next step waits for it.
    const release = scheduler.holdTurn(model);
    order.push("turn");
    first.resolve();
    await flush();
    expect(order).toEqual(["step 1", "turn"]);
    release();
    await job;
    expect(order).toEqual(["step 1", "turn", "step 2"]);
  });

  test("two turns: background waits for both", async () => {
    const scheduler = createScheduler();
    const model = ollamaModel("qwen");
    const started: string[] = [];
    const a = scheduler.holdTurn(model);
    const b = scheduler.holdTurn(model);
    const step = backgroundStep(scheduler, model, "x", started);
    a();
    await flush();
    expect(started).toEqual([]);
    b();
    await flush();
    expect(started).toEqual(["x"]);
    step.finish();
    await step.result;
  });

  test("releasing a turn twice counts it once", async () => {
    const scheduler = createScheduler();
    const model = ollamaModel("qwen");
    const started: string[] = [];
    const a = scheduler.holdTurn(model);
    const b = scheduler.holdTurn(model);
    a();
    a();
    const step = backgroundStep(scheduler, model, "x", started);
    await flush();
    expect(started).toEqual([]);
    b();
    await flush();
    expect(started).toEqual(["x"]);
    step.finish();
    await step.result;
  });

  test("background steps run one at a time", async () => {
    const scheduler = createScheduler();
    const model = ollamaModel("qwen");
    const started: string[] = [];
    const a = backgroundStep(scheduler, model, "a", started);
    const b = backgroundStep(scheduler, model, "b", started);
    await flush();
    expect(started).toEqual(["a"]);
    a.finish();
    await flush();
    expect(started).toEqual(["a", "b"]);
    b.finish();
    await Promise.all([a.result, b.result]);
  });
});

describe("scheduler: several slots", () => {
  test("capacity 8, 2 for background: background never goes past 2, and six turns always fit", async () => {
    const scheduler = createScheduler();
    const model = ollamaModel("gemma", { capacity: 8, backgroundSlots: 2 });
    const started: string[] = [];
    const steps = ["a", "b", "c", "d"].map((label) => backgroundStep(scheduler, model, label, started));
    await flush();
    expect(started).toEqual(["a", "b"]);
    // Six turns fit in the slots left beside the two steps: none of them waits.
    const turns = Array.from({ length: 6 }, () => scheduler.holdTurn(model));
    steps[0]!.finish();
    await flush();
    expect(started).toEqual(["a", "b", "c"]);
    // A seventh turn takes the slot a finished step leaves: the next one waits.
    turns.push(scheduler.holdTurn(model));
    steps[1]!.finish();
    await flush();
    expect(started).toEqual(["a", "b", "c"]);
    turns[0]!();
    await flush();
    expect(started).toEqual(["a", "b", "c", "d"]);
    for (const release of turns) release();
    for (const step of steps) step.finish();
    await Promise.all(steps.map((s) => s.result));
  });

  test("background fills only what turns leave free", async () => {
    const scheduler = createScheduler();
    const model = ollamaModel("gemma", { capacity: 4, backgroundSlots: 2 });
    const started: string[] = [];
    const turns = [scheduler.holdTurn(model), scheduler.holdTurn(model), scheduler.holdTurn(model)];
    const a = backgroundStep(scheduler, model, "a", started);
    const b = backgroundStep(scheduler, model, "b", started);
    await flush();
    expect(started).toEqual(["a"]);
    turns[0]!();
    await flush();
    expect(started).toEqual(["a", "b"]);
    for (const release of turns) release();
    a.finish();
    b.finish();
    await Promise.all([a.result, b.result]);
  });
});

describe("scheduler: urgency", () => {
  test("soon goes before idle; the same urgency keeps its order", async () => {
    const scheduler = createScheduler();
    const model = ollamaModel("qwen");
    const started: string[] = [];
    const release = scheduler.holdTurn(model);
    const steps = [
      backgroundStep(scheduler, model, "idle 1", started, "idle"),
      backgroundStep(scheduler, model, "soon 1", started, "soon"),
      backgroundStep(scheduler, model, "idle 2", started, "idle"),
      backgroundStep(scheduler, model, "soon 2", started, "soon"),
    ];
    release();
    for (let i = 0; i < steps.length; i++) {
      await flush();
      expect(started).toHaveLength(i + 1);
      steps.find((s, j) => started[i] === ["idle 1", "soon 1", "idle 2", "soon 2"][j])!.finish();
    }
    expect(started).toEqual(["soon 1", "soon 2", "idle 1", "idle 2"]);
    await Promise.all(steps.map((s) => s.result));
  });

  test("a soon job still waits for turns", async () => {
    const scheduler = createScheduler();
    const model = ollamaModel("qwen");
    const started: string[] = [];
    const release = scheduler.holdTurn(model);
    const step = backgroundStep(scheduler, model, "title", started, "soon");
    await flush();
    expect(started).toEqual([]);
    release();
    await flush();
    expect(started).toEqual(["title"]);
    step.finish();
    await step.result;
  });
});

describe("scheduler: models are queued apart", () => {
  test("a turn on one model doesn't hold background work on another", async () => {
    const scheduler = createScheduler();
    const big = ollamaModel("big");
    const small = ollamaModel("small");
    const started: string[] = [];
    const release = scheduler.holdTurn(big);
    const step = backgroundStep(scheduler, small, "on small", started);
    await flush();
    expect(started).toEqual(["on small"]);
    release();
    step.finish();
    await step.result;
  });

  test("the same handle in two roles is one queue", async () => {
    const scheduler = createScheduler();
    const main = ollamaModel("qwen");
    const started: string[] = [];
    const release = scheduler.holdTurn(main);
    const step = backgroundStep(scheduler, main, "x", started);
    await flush();
    expect(started).toEqual([]);
    release();
    step.finish();
    await step.result;
  });

  test("an embedding model has its own queue", async () => {
    const scheduler = createScheduler();
    const embedding = ollamaEmbedding("nomic");
    const started: string[] = [];
    const a = backgroundStep(scheduler, embedding, "a", started);
    const b = backgroundStep(scheduler, embedding, "b", started);
    await flush();
    expect(started).toEqual(["a"]);
    a.finish();
    await flush();
    expect(started).toEqual(["a", "b"]);
    b.finish();
    await Promise.all([a.result, b.result]);
  });
});

describe("scheduler: a call outside a job is turn work", () => {
  test("it never waits, and background waits for it", async () => {
    const scheduler = createScheduler();
    const own = ollamaModel("query-writer");
    const started: string[] = [];
    const turnCall = deferred();
    const call = scheduler.call(own, async () => {
      started.push("turn call");
      await turnCall.promise;
    });
    const step = backgroundStep(scheduler, own, "bg", started);
    await flush();
    expect(started).toEqual(["turn call"]);
    turnCall.resolve();
    await call;
    await flush();
    expect(started).toEqual(["turn call", "bg"]);
    step.finish();
    await step.result;
  });

  test("a turn call runs even while background fills the model", async () => {
    const scheduler = createScheduler();
    const own = ollamaModel("query-writer");
    const started: string[] = [];
    const step = backgroundStep(scheduler, own, "bg", started);
    await flush();
    await scheduler.call(own, async () => {
      started.push("turn call");
    });
    expect(started).toEqual(["bg", "turn call"]);
    step.finish();
    await step.result;
  });
});

describe("scheduler: failures and stop", () => {
  test("a failing step frees its slot, ends its job, and the others go on", async () => {
    const scheduler = createScheduler();
    const model = ollamaModel("qwen");
    const started: string[] = [];
    const failing = scheduler.job({ job: "title", urgency: "soon" }, () =>
      scheduler.call(model, async () => {
        throw new Error("model down");
      }),
    );
    const other = backgroundStep(scheduler, model, "after", started);
    await expect(failing).rejects.toThrow("model down");
    await flush();
    expect(started).toEqual(["after"]);
    other.finish();
    await other.result;
  });

  test("stop drops the steps still waiting and refuses new ones; the running one finishes", async () => {
    const scheduler = createScheduler();
    const model = ollamaModel("qwen");
    const started: string[] = [];
    const running = backgroundStep(scheduler, model, "running", started);
    const waiting = backgroundStep(scheduler, model, "waiting", started);
    await flush();
    scheduler.stop();
    await expect(waiting.result).rejects.toBeInstanceOf(DroppedError);
    running.finish();
    expect(await running.result).toBe("running");
    const late = backgroundStep(scheduler, model, "late", started);
    await expect(late.result).rejects.toBeInstanceOf(DroppedError);
    expect(started).toEqual(["running"]);
  });

  test("turn calls still run after stop", async () => {
    const scheduler = createScheduler();
    const model = ollamaModel("qwen");
    scheduler.stop();
    expect(await scheduler.call(model, async () => "answered")).toBe("answered");
  });
});

describe("scheduler: the background.job event", () => {
  test("one event per job: its name, urgency, models, steps, the time spent waiting and in all", async () => {
    let clock = 0;
    const events: Array<Record<string, unknown>> = [];
    const scheduler = createScheduler({ now: () => clock, emit: (event) => events.push(event) });
    const model = ollamaModel("qwen");
    const embedding = ollamaEmbedding("nomic");
    const release = scheduler.holdTurn(model);
    const job = scheduler.job({ job: "capture", urgency: "idle" }, async () => {
      await scheduler.call(model, async () => {
        clock += 300;
      });
      await scheduler.call(embedding, async () => {
        clock += 20;
      });
    });
    clock += 1000;
    release();
    await job;
    expect(events).toEqual([
      { kind: "background.job", job: "capture", urgency: "idle", models: ["qwen", "nomic"], steps: 2, waitedMs: 1000, ms: 1320, outcome: "done" },
    ]);
  });

  // #387: a plugin's job is named after the plugin.
  test("a plugin's job is reported under its own name", async () => {
    const events: Array<Record<string, unknown>> = [];
    const scheduler = createScheduler({ now: () => 0, emit: (event) => events.push(event) });
    const model = ollamaModel("qwen");
    await scheduler.job({ job: "memo:index", urgency: "idle" }, () => scheduler.call(model, async () => {}));
    expect(events.map((e) => e.job)).toEqual(["memo:index"]);
  });

  // #383: the turn's corrections, or a title that already exists, often need no model call: every turn would add an empty event.
  test("a job done without a model call reports nothing", async () => {
    const events: Array<Record<string, unknown>> = [];
    const scheduler = createScheduler({ emit: (event) => events.push(event) });
    await scheduler.job({ job: "correction", urgency: "soon" }, async () => "nothing to correct");
    expect(events).toEqual([]);
  });

  test("failed and dropped jobs say so", async () => {
    const events: Array<Record<string, unknown>> = [];
    const scheduler = createScheduler({ now: () => 0, emit: (event) => events.push(event) });
    const model = ollamaModel("qwen");
    await scheduler
      .job({ job: "title", urgency: "soon" }, () =>
        scheduler.call(model, async () => {
          throw new Error("down");
        }),
      )
      .catch(() => {});
    const release = scheduler.holdTurn(model);
    const dropped = scheduler.job({ job: "review", urgency: "idle" }, () => scheduler.call(model, async () => {})).catch(() => {});
    await flush();
    scheduler.stop();
    await dropped;
    release();
    expect(events.map((e) => [e.job, e.outcome, e.steps])).toEqual([
      ["title", "failed", 1],
      ["review", "dropped", 0],
    ]);
  });

  test("each dropped job gets a log line", async () => {
    const lines: string[] = [];
    const scheduler = createScheduler({ log: (line) => lines.push(line) });
    const model = ollamaModel("qwen");
    const release = scheduler.holdTurn(model);
    const job = scheduler.job({ job: "review", urgency: "idle" }, () => scheduler.call(model, async () => {})).catch(() => {});
    await flush();
    scheduler.stop();
    await job;
    release();
    expect(lines).toEqual(["[queue] review dropped: the agent stopped before it could run"]);
  });

  test("a job that swallowed a dropped step is still dropped", async () => {
    const events: Array<Record<string, unknown>> = [];
    const scheduler = createScheduler({ emit: (event) => events.push(event) });
    const model = ollamaModel("qwen");
    const release = scheduler.holdTurn(model);
    const job = scheduler.job({ job: "capture", urgency: "idle" }, async () => {
      await scheduler.call(model, async () => {}).catch(() => {});
    });
    await flush();
    scheduler.stop();
    await job;
    release();
    expect(events[0]?.outcome).toBe("dropped");
  });
});

describe("scheduler: a handle that didn't come from ollamaModel", () => {
  test("its capacity and background slots are checked where its queue is made", () => {
    const scheduler = createScheduler();
    const bad = { provider: "ollama", kind: "language", name: "x", settings: {}, capacity: 0, backgroundSlots: 1 } as const;
    expect(() => scheduler.holdTurn(bad)).toThrow('model "x": capacity must be a whole number from 1 up, got 0');
    const tooMany = { ...bad, capacity: 4, backgroundSlots: 4 };
    expect(() => scheduler.holdTurn(tooMany)).toThrow('model "x": backgroundSlots must be below capacity (4), got 4');
  });
});

describe("scheduler: wrapped models", () => {
  type Callable = { doGenerate: (o: unknown) => Promise<unknown>; doStream: (o: unknown) => Promise<{ stream: ReadableStream<unknown> }> };

  test("a wrapped model's call inside a job is a step: it waits for the turn", async () => {
    const scheduler = createScheduler();
    const handle = ollamaModel("qwen");
    const calls: string[] = [];
    const raw = new MockLanguageModelV4({
      doGenerate: async () => {
        calls.push("generate");
        return { marker: true } as never;
      },
    });
    const wrapped = scheduler.languageModel(handle, raw) as unknown as Callable;
    const release = scheduler.holdTurn(handle);
    const job = scheduler.job({ job: "title", urgency: "soon" }, () => wrapped.doGenerate({ prompt: [] }));
    await flush();
    expect(calls).toEqual([]);
    release();
    expect(await job).toEqual({ marker: true });
    expect(calls).toEqual(["generate"]);
  });

  test("a streamed step keeps its slot until its stream ends", async () => {
    const scheduler = createScheduler();
    const handle = ollamaModel("qwen");
    const started: string[] = [];
    const raw = new MockLanguageModelV4({
      doStream: async () => ({ stream: convertArrayToReadableStream(["a", "b"]) }) as never,
    });
    const wrapped = scheduler.languageModel(handle, raw) as unknown as Callable;
    const streamed = await scheduler.job({ job: "review", urgency: "idle" }, () => wrapped.doStream({ prompt: [] }));
    const next = backgroundStep(scheduler, handle, "next", started);
    await flush();
    expect(started).toEqual([]);
    expect(await convertReadableStreamToArray(streamed.stream)).toEqual(["a", "b"]);
    await flush();
    expect(started).toEqual(["next"]);
    next.finish();
    await next.result;
  });

  test("a streamed step cancelled early frees its slot", async () => {
    const scheduler = createScheduler();
    const handle = ollamaModel("qwen");
    const started: string[] = [];
    const raw = new MockLanguageModelV4({
      doStream: async () => ({ stream: convertArrayToReadableStream(["a", "b"]) }) as never,
    });
    const wrapped = scheduler.languageModel(handle, raw) as unknown as Callable;
    const streamed = await scheduler.job({ job: "review", urgency: "idle" }, () => wrapped.doStream({ prompt: [] }));
    const next = backgroundStep(scheduler, handle, "next", started);
    await streamed.stream.cancel();
    await flush();
    expect(started).toEqual(["next"]);
    next.finish();
    await next.result;
  });

  test("a wrapped embedding model's call inside a job is a step on its own queue", async () => {
    const scheduler = createScheduler();
    const handle = ollamaEmbedding("nomic");
    const raw = new MockEmbeddingModelV4({ doEmbed: async () => ({ embeddings: [[1, 2]] }) as never });
    const wrapped = scheduler.embeddingModel(handle, raw) as unknown as { doEmbed: (o: unknown) => Promise<unknown> };
    const release = scheduler.holdTurn(handle);
    let done = false;
    const job = scheduler.job({ job: "capture", urgency: "idle" }, () => wrapped.doEmbed({ values: ["x"] })).then((r) => {
      done = true;
      return r;
    });
    await flush();
    expect(done).toBe(false);
    release();
    expect(await job).toEqual({ embeddings: [[1, 2]] });
  });
});
