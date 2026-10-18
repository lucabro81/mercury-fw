/**
 * How the jira CLI (2.3.2) prints, for the fixtures the skill trainer answers
 * with: the `--select` projection, the refusals without it or past the
 * `--select-all` cap, the commands exempt from it, and the paging of a
 * search. Modelled on what the real CLI printed (see jira-cli.test.ts), so a
 * model trained here meets the same shapes, mistakes included, as in
 * production.
 */
import type { CliResult } from "@mercury-fw/plugin-types";
import type { FixtureCall } from "../../../../apps/skill-trainer/src/contract.ts";

/** The size above which `--select-all` is refused too. */
const SELECT_ALL_CAP = 30000;

/** A page of a search when `--max-results` isn't given (Jira's own default). */
const DEFAULT_PAGE_SIZE = 50;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

const isObject = (value: Json | undefined): value is JsonObject => typeof value === "object" && value !== null && !Array.isArray(value);

/** Copies the part of `src` that the path `segments` reaches into `dst`:
 * what exists of the path is kept, a missing step stops it, a null is kept
 * as null, an array is followed element by element. */
function copyPath(src: Json, segments: string[], dst: JsonObject): void {
  if (!isObject(src)) return;
  const [head, ...rest] = segments as [string, ...string[]];
  if (!(head in src)) return;
  const value = src[head] as Json;
  if (rest.length === 0 || value === null) {
    dst[head] = structuredClone(value);
    return;
  }
  if (Array.isArray(value)) {
    const target = Array.isArray(dst[head]) ? (dst[head] as Json[]) : value.map(() => ({}));
    value.forEach((element, i) => {
      if (isObject(target[i] as Json)) copyPath(element, rest, target[i] as JsonObject);
    });
    dst[head] = target;
    return;
  }
  if (!isObject(value)) return;
  const target = isObject(dst[head]) ? (dst[head] as JsonObject) : {};
  copyPath(value, rest, target);
  dst[head] = target;
}

/** `data` projected on the dot-notation `paths`, the way `--select` does it. */
export function select(data: unknown, paths: string[]): unknown {
  const project = (element: Json): JsonObject => {
    const out: JsonObject = {};
    for (const path of paths) copyPath(element, path.split("."), out);
    return out;
  };
  return Array.isArray(data) ? (data as Json[]).map(project) : project(data as Json);
}

/** The CLI's failure as `runCli` hands it over: exit 1, its stderr in the error. */
export const failure = (message: string): CliResult => ({ ok: false, exitCode: 1, error: `jira exited with code 1: ${message}` });

/** The top-level fields a refusal lists. */
const topLevel = (data: unknown) => (isObject(data as Json) ? Object.keys(data as JsonObject).sort().join(", ") : "");

/** What the CLI prints for `data` given the flags of `call`: in full for a
 * command `exempt` from `--select`, the projection with `--select`, everything
 * with `--select-all` up to the cap, a refusal otherwise. */
export function printed(data: unknown, call: FixtureCall, { exempt = false }: { exempt?: boolean } = {}): CliResult {
  if (exempt) return { ok: true, data };
  const paths = call.flags["--select"];
  if (typeof paths === "string") return { ok: true, data: select(data, paths.split(",")) };
  const bytes = Buffer.byteLength(JSON.stringify(data, null, 2));
  const retry = "Retry with --select and one or more dot-notation paths built from the fields above (e.g. --select fieldName or --select fieldName.nestedField)";
  if (call.flags["--select-all"] === true) {
    if (bytes <= SELECT_ALL_CAP) return { ok: true, data };
    return failure(
      `refusing to print the full ${bytes}-byte JSON response even with --select-all — it exceeds the ${SELECT_ALL_CAP}-byte cap and would likely flood the caller's context window. ` +
        `top-level fields: ${topLevel(data)}. ${retry} to narrow the response instead.`,
    );
  }
  return failure(
    `refusing to print the full ${bytes}-byte JSON response without --select — an omitted --select would likely flood the caller's context window. ` +
      `top-level fields: ${topLevel(data)}. ${retry}, or pass --select-all to explicitly confirm printing the unfiltered response.`,
  );
}

/** The page of `issues` that `call`'s `--max-results` and `--page-token` ask
 * for, shaped as a search response: `nextPageToken` only when more follow. */
export function page<T>(issues: T[], call: FixtureCall): { isLast: boolean; issues: T[]; nextPageToken?: string } {
  const size = Number(call.flags["--max-results"]) || DEFAULT_PAGE_SIZE;
  const token = call.flags["--page-token"];
  const offset = typeof token === "string" ? Number(Buffer.from(token, "base64").toString().replace(/^offset:/, "")) || 0 : 0;
  const slice = issues.slice(offset, offset + size);
  const next = offset + size;
  if (next >= issues.length) return { isLast: true, issues: slice };
  return { isLast: false, issues: slice, nextPageToken: Buffer.from(`offset:${next}`).toString("base64") };
}
