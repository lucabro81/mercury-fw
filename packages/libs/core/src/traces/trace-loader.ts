/**
 * Builds the trace sink an app declares as `traces` in `mercury.config.ts`
 * into the `Tracer` everything else emits through — the traces' sibling of
 * `router/auth-loader.ts`. It knows no sink: files, a database or a collector
 * live in their own packages.
 *
 * A level other than `meta` or `args` is a mistake in the config and stops
 * startup. Everything else is fail-soft: a sink written for another contract,
 * a `build()` that throws or a trace secret that can't be read leaves the
 * instance without traces, logged, and the instance starts anyway.
 */
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { TRACE_SINK_API_VERSION, type TraceSinkPlugin } from "@mercury-fw/channel-types";
import { loadTraceSecret } from "./trace-secret.ts";
import { createTracer, noopTracer, type TraceLevel, type Tracer } from "./tracer.ts";

/** What an app declares as `traces`: where events go, and how much they carry (`meta` when left out). */
export type MercuryTraces = { sink: TraceSinkPlugin; level?: TraceLevel };

/** The folder a sink gets: `traces/` in the data folder (`../data/data-dir.ts`). */
export function traceDir(dataPath: string): string {
  return resolve(dataPath, "traces");
}

/** The tracer for `traces`, or `noopTracer` when there's none or it can't be used (see the module comment). */
export async function loadTracer(
  traces: MercuryTraces | undefined,
  ctx: { env: Record<string, string | undefined>; log: (msg: string) => void; dataPath: string; now: () => number },
): Promise<Tracer> {
  if (traces === undefined) return noopTracer;
  const level = traces.level ?? "meta";
  if (level !== "meta" && level !== "args") {
    throw new Error(`traces.level must be "meta" or "args", not ${JSON.stringify(level)}`);
  }
  const { sink } = traces;
  if (sink.apiVersion !== TRACE_SINK_API_VERSION) {
    ctx.log(
      `trace sink "${sink.name}" not activated: apiVersion ${sink.apiVersion} ` +
        `incompatible with this core (supports ${TRACE_SINK_API_VERSION})`,
    );
    return noopTracer;
  }
  let secret: string;
  try {
    secret = await loadTraceSecret(ctx.dataPath);
  } catch (err) {
    ctx.log(`trace sink "${sink.name}": traces off, no trace secret: ${err instanceof Error ? err.message : String(err)}`);
    return noopTracer;
  }
  try {
    const dir = traceDir(ctx.dataPath);
    await mkdir(dir, { recursive: true });
    const built = sink.build({ env: ctx.env, log: ctx.log, dir });
    return createTracer({ sink: built, level, secret, now: ctx.now, log: ctx.log });
  } catch (err) {
    ctx.log(`trace sink "${sink.name}" failed to load: ${err instanceof Error ? err.message : String(err)}`);
    return noopTracer;
  }
}
