/**
 * The core's queue of model work (#383): one queue per declared model, so the
 * work nobody waits on never takes a model from someone waiting for an
 * answer.
 *
 * Two kinds of work:
 * - **turn work**, never held back. A turn counts on the turn model from the
 *   moment the turn runner takes it until its answer is out (`holdTurn`); a
 *   model call made outside a background job (a plugin's own model during a
 *   turn, the embedding of `recall_verbatim`) counts on its model while it runs.
 * - **background work**, run in jobs (`job`) whose every model call is a step
 *   (`call`, or a model wrapped by `languageModel`/`embeddingModel`). A step
 *   starts only when turns and running steps leave a slot of the model's
 *   `capacity` free, and no more than `backgroundSlots` steps run at once; so
 *   a model with capacity 1 runs background work only while nobody is in a
 *   turn. Between two steps of a job, a turn that arrived goes first. Waiting
 *   steps start `soon` before `idle`, in the order they asked within one
 *   urgency.
 *
 * Which job a call belongs to travels with the async context
 * (`AsyncLocalStorage`), so code running in a job uses the same wrapped model
 * as any other: today's background code didn't change, only the model it's
 * given. `stop` drops the steps still waiting and refuses new ones.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { wrapEmbeddingModel, wrapLanguageModel, type EmbeddingModel, type LanguageModel } from "ai";
import type { MercuryEmbeddingHandle, MercuryModelHandle } from "@mercury-fw/plugin-types";
import type { TraceInput } from "../traces/tracer.ts";

/** How soon a job's work should run: `soon` (a correction, the archive's index, a title) goes before `idle` (captures, the nightly review). */
export type Urgency = "soon" | "idle";

/** The background jobs, as the traces name them: the core's own, and a plugin's as `<plugin>:<name>` (see `PluginRuntimeContext.job`). */
export type BackgroundJobName = "capture" | "correction" | "archive-index" | `${string}:${string}`;

/** A model the scheduler queues for: a declared handle. */
export type QueuedHandle = MercuryModelHandle | MercuryEmbeddingHandle;

/** What a step waiting for its slot was refused with once the scheduler stopped. */
export class DroppedError extends Error {
  constructor() {
    super("dropped: the background queue stopped before this step could run");
    this.name = "DroppedError";
  }
}

export type Scheduler = {
  /** Makes `handle`'s queue now, so a capacity or background slots that can't make one throw at the start. */
  declare(handle: QueuedHandle): void;
  /** Counts a turn on `handle`'s model until the returned release is called (calling it again does nothing). */
  holdTurn(handle: QueuedHandle): () => void;
  /** Runs `fn` as one background job: its model calls are steps, and one `background.job` event says how it went (none for a job done without a model call). */
  job<T>(meta: { job: BackgroundJobName; urgency: Urgency }, fn: () => Promise<T>): Promise<T>;
  /** Runs one model call on `handle`: a step of the current job, or turn work outside one. */
  call<T>(handle: QueuedHandle, fn: () => Promise<T>): Promise<T>;
  /** `model` with each of its calls going through `call` on `handle`. */
  languageModel(handle: MercuryModelHandle, model: LanguageModel): LanguageModel;
  /** `model` with each of its calls going through `call` on `handle`. */
  embeddingModel(handle: MercuryEmbeddingHandle, model: EmbeddingModel): EmbeddingModel;
  /** Drops the steps still waiting and refuses new ones; running steps and turn work go on. */
  stop(): void;
};

type Waiting = { urgency: Urgency; seq: number; start: () => void; drop: () => void };

type Queue = { name: string; capacity: number; backgroundSlots: number; turns: number; running: number; waiting: Waiting[] };

type JobState = { urgency: Urgency; models: string[]; steps: number; waitedMs: number; dropped: boolean };

/** Throws unless `handle`'s capacity and background slots can make a queue. */
function checkHandle(handle: QueuedHandle): { capacity: number; backgroundSlots: number } {
  const label = `model ${JSON.stringify(handle.name)}`;
  const { capacity } = handle;
  if (!Number.isInteger(capacity) || capacity < 1) {
    throw new Error(`${label}: capacity must be a whole number from 1 up, got ${capacity}`);
  }
  const backgroundSlots = handle.kind === "language" ? handle.backgroundSlots : 1;
  if (!Number.isInteger(backgroundSlots) || backgroundSlots < 1) {
    throw new Error(`${label}: backgroundSlots must be a whole number from 1 up, got ${backgroundSlots}`);
  }
  if (capacity === 1 && backgroundSlots !== 1) {
    throw new Error(`${label}: backgroundSlots must be 1 with capacity 1, got ${backgroundSlots}`);
  }
  if (capacity > 1 && backgroundSlots >= capacity) {
    throw new Error(`${label}: backgroundSlots must be below capacity (${capacity}), got ${backgroundSlots}`);
  }
  return { capacity, backgroundSlots };
}

/** Builds the instance's scheduler; `now` and `emit` are for the `background.job` events, `log` for the line each job dropped at stop gets. */
export function createScheduler(
  opts: { now?: () => number; emit?: (event: TraceInput) => void; log?: (line: string) => void } = {},
): Scheduler {
  const now = opts.now ?? Date.now;
  const queues = new Map<QueuedHandle, Queue>();
  const jobs = new AsyncLocalStorage<JobState>();
  let stopped = false;
  let seq = 0;

  const queueOf = (handle: QueuedHandle): Queue => {
    let queue = queues.get(handle);
    if (queue === undefined) {
      queue = { name: handle.name, ...checkHandle(handle), turns: 0, running: 0, waiting: [] };
      queues.set(handle, queue);
    }
    return queue;
  };

  const canStart = (queue: Queue) => queue.turns + queue.running < queue.capacity && queue.running < queue.backgroundSlots;

  /** Starts the waiting steps that fit now, `soon` first. */
  const pump = (queue: Queue) => {
    while (queue.waiting.length > 0 && canStart(queue)) {
      queue.waiting.sort((a, b) => (a.urgency === b.urgency ? a.seq - b.seq : a.urgency === "soon" ? -1 : 1));
      const next = queue.waiting.shift();
      queue.running++;
      next?.start();
    }
  };

  /** Resolves once a background step may run on `queue`; the caller then owns one running slot. */
  const acquire = (queue: Queue, urgency: Urgency): Promise<void> => {
    if (stopped) return Promise.reject(new DroppedError());
    if (queue.waiting.length === 0 && canStart(queue)) {
      queue.running++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      queue.waiting.push({ urgency, seq: seq++, start: resolve, drop: () => reject(new DroppedError()) });
    });
  };

  const holdTurn = (handle: QueuedHandle): (() => void) => {
    const queue = queueOf(handle);
    queue.turns++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      queue.turns--;
      pump(queue);
    };
  };

  const call = async <T>(handle: QueuedHandle, fn: () => Promise<T>): Promise<T> => {
    const queue = queueOf(handle);
    const job = jobs.getStore();
    if (job === undefined) {
      const release = holdTurn(handle);
      try {
        return await fn();
      } finally {
        release();
      }
    }
    const asked = now();
    try {
      await acquire(queue, job.urgency);
    } catch (err) {
      if (err instanceof DroppedError) job.dropped = true;
      throw err;
    }
    job.waitedMs += now() - asked;
    job.steps++;
    if (!job.models.includes(queue.name)) job.models.push(queue.name);
    try {
      return await fn();
    } finally {
      queue.running--;
      pump(queue);
    }
  };

  return {
    declare: (handle) => void queueOf(handle),
    holdTurn,
    call,
    async job(meta, fn) {
      const state: JobState = { urgency: meta.urgency, models: [], steps: 0, waitedMs: 0, dropped: false };
      const startedAt = now();
      // A job done without a model call (no correction to look for, a title already there) isn't worth an event.
      const report = (outcome: "done" | "failed" | "dropped") => {
        if (outcome === "done" && state.steps === 0) return;
        if (outcome === "dropped") (opts.log ?? console.error)(`[queue] ${meta.job} dropped: the agent stopped before it could run`);
        opts.emit?.({
          kind: "background.job",
          job: meta.job,
          urgency: meta.urgency,
          models: state.models,
          steps: state.steps,
          waitedMs: state.waitedMs,
          ms: now() - startedAt,
          outcome,
        });
      };
      try {
        const result = await jobs.run(state, fn);
        report(state.dropped ? "dropped" : "done");
        return result;
      } catch (err) {
        report(state.dropped || err instanceof DroppedError ? "dropped" : "failed");
        throw err;
      }
    },
    languageModel(handle, model) {
      queueOf(handle);
      return wrapLanguageModel({
        model: model as Parameters<typeof wrapLanguageModel>[0]["model"],
        middleware: {
          wrapGenerate: ({ doGenerate }) => call(handle, async () => doGenerate()),
          wrapStream: ({ doStream }) => streamStep(handle, doStream),
        },
      });
    },
    embeddingModel(handle, model) {
      queueOf(handle);
      return wrapEmbeddingModel({
        model: model as Parameters<typeof wrapEmbeddingModel>[0]["model"],
        middleware: { wrapEmbed: ({ doEmbed }) => call(handle, async () => doEmbed()) },
      });
    },
    stop() {
      stopped = true;
      for (const queue of queues.values()) {
        const dropped = queue.waiting.splice(0);
        for (const step of dropped) step.drop();
      }
    },
  };

  /**
   * A streamed call as one call: its slot is held until the stream ends,
   * errors or is cancelled, not only until the call returns its stream.
   */
  function streamStep<R extends { stream: ReadableStream<unknown> }>(handle: QueuedHandle, doStream: () => PromiseLike<R>): Promise<R> {
    return new Promise<R>((resolveResult, rejectResult) => {
      call(handle, async () => {
        const r = await doStream();
        await new Promise<void>((end) => {
          const reader = r.stream.getReader();
          let ended = false;
          const finish = () => {
            if (!ended) {
              ended = true;
              end();
            }
          };
          const stream = new ReadableStream<unknown>({
            async pull(controller) {
              try {
                const { done, value } = await reader.read();
                if (done) {
                  controller.close();
                  finish();
                } else {
                  controller.enqueue(value);
                }
              } catch (err) {
                controller.error(err);
                finish();
              }
            },
            async cancel(reason) {
              finish();
              await reader.cancel(reason);
            },
          });
          resolveResult({ ...r, stream });
        });
      }).catch(rejectResult);
    });
  }
}
