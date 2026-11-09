/**
 * The user channel of every plugin tool, in one place: whatever a tool
 * returns, CLI or typed, its top-level `display` (see `ToolDisplay`) never
 * reaches the model. A display the formatter rendered (its items are text) is
 * stashed in the display store and replaced by a `displayRef` the model can
 * `present`; one the instance shows always (`display.always`) is stashed
 * already surfaced, and the model is told with `shown: true` that the person
 * sees it, so it writes only what goes around it. A display still structured
 * (no rule rendered it) has nothing to show and is just dropped.
 */
import type { Tool } from "ai";
import type { ToolDisplay } from "@mercury-fw/plugin-types";

/** Stashes a rendered display for the session, with what it is, and returns its ref. */
export type StashDisplay = (artifact: string, label: string, opts: { show: boolean }) => string;

/** Rendered items are shown one per block, separated by a blank line. */
const ITEM_SEPARATOR = "\n\n";
/** How much of a call's input the label keeps: the store cuts a label at 200, the count goes after it. */
const MAX_LABEL_INPUT = 150;

/** What the list is, so the model still knows a turn later: the tool, its input (cut), how many items. */
function labelFor(toolName: string, input: unknown, count: number): string {
  const json = JSON.stringify(input) ?? "";
  const shown = json.length > MAX_LABEL_INPUT ? `${json.slice(0, MAX_LABEL_INPUT - 1)}…` : json;
  return `${toolName} ${shown} (${count} ${count === 1 ? "item" : "items"})`;
}

/** `output` without its display, the display stashed when it's rendered and the result ok. */
function channel(output: unknown, toolName: string, input: unknown, stash: StashDisplay): unknown {
  if (typeof output !== "object" || output === null || !("display" in output)) return output;
  const { display, ...rest } = output as Record<string, unknown> & { display?: ToolDisplay };
  if (rest.ok !== true || !Array.isArray(display?.items)) return rest;
  const items = display.items.filter((i): i is string => typeof i === "string");
  if (items.length === 0) return rest;
  const show = display.always === true;
  const displayRef = stash(items.join(ITEM_SEPARATOR), labelFor(toolName, input, items.length), { show });
  return show ? { ...rest, displayRef, shown: true } : { ...rest, displayRef };
}

/** `tools`, each one's output going through the display channel; every other field, and a tool with no `execute`, as it is. */
export function withDisplayChannel(tools: Record<string, Tool>, stash: StashDisplay): Record<string, Tool> {
  const out: Record<string, Tool> = {};
  for (const [name, tool] of Object.entries(tools)) {
    const { execute } = tool;
    out[name] =
      execute === undefined
        ? tool
        : ({
            ...tool,
            execute: async (input: unknown, options: unknown) =>
              channel(await (execute as (i: unknown, o: unknown) => unknown)(input, options), name, input, stash),
          } as Tool);
  }
  return out;
}
