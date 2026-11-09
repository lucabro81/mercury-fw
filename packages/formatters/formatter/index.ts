/**
 * The formatter: turns the structured lists a data plugin hands to the user
 * (its `display` channel) into text, by applying a rule the instance writes in
 * its own config. It holds no format knowledge of its own — every rule comes
 * from the config, keyed by the display's kind — and it knows no plugin: a data
 * plugin declares the kinds it emits as a type, which is what keeps the
 * config's keys and item shapes checked at compile time.
 *
 * - `formatter(rules)` builds a `DisplayHandler` from a `kind → rule` map.
 * - `formatterPlugin(plugin, handler)` wraps a data plugin so every display
 *   its tools return goes through the handler, a CLI tool's or a typed one's
 *   alike; everything else the plugin contributes passes through untouched.
 */
import type { ExecutableTool, Plugin, PluginRuntimeContributions, ToolDisplay, Translate } from "@mercury-fw/plugin-types";

/** What a handler renders one display into: the single text block shown to the
 * user, and `always` when the display is the answer itself, shown without the
 * model calling `present`. */
export type RenderedDisplay = { text: string; always?: true };

/** Renders one display, in the turn's language (`t`), or returns `undefined`
 * when there is nothing to show (no rule for its kind, or an empty list with no
 * empty text). */
export type DisplayHandler = (display: ToolDisplay, t: Translate) => RenderedDisplay | undefined;

/** How one kind of list is rendered: the line for each item, or that plus the
 * text to show when the list is empty and whether the display is always shown
 * (`always`: the answer itself, e.g. a link the person asked for, appended
 * without the model calling `present`). The texts may use `t`, the texts of
 * the person the turn is for (an app's own keys in its language files). */
export type FormatterRule<T> =
  | ((item: T, t: Translate) => string)
  | { item: (item: T, t: Translate) => string; empty?: string | ((t: Translate) => string); always?: true };

/** Items are rendered one per block, separated by a blank line. */
const ITEM_SEPARATOR = "\n\n";

/**
 * Builds a handler from the instance's rules. `D` is the data plugin's map of
 * the kinds it emits to their item shapes (e.g. `JiraDisplays`), so a key it
 * doesn't declare, or a rule for the wrong item shape, fails the typecheck.
 * Every rule is optional: a kind without one has nothing to show.
 */
export function formatter<D>(rules: { [K in keyof D]?: FormatterRule<D[K]> }): DisplayHandler {
  const byKind = rules as Record<string, FormatterRule<unknown> | undefined>;
  return (display, t) => {
    const rule = byKind[display.type];
    if (rule === undefined) {
      return undefined;
    }
    const { item, empty, always } = typeof rule === "function" ? { item: rule, empty: undefined, always: undefined } : rule;
    const text =
      display.items.length === 0
        ? typeof empty === "function"
          ? empty(t)
          : empty
        : display.items.map((i) => item(i, t)).join(ITEM_SEPARATOR);
    if (text === undefined) {
      return undefined;
    }
    return always ? { text, always } : { text };
  };
}

/** A tool's output carrying a display to render: an ok result (`ok: true`)
 * with a top-level `display`. */
type DisplayOutput = Record<string, unknown> & { ok: true; display: ToolDisplay };

/** Whether `output` is an ok result with a `display` (see `DisplayOutput`). */
function hasDisplay(output: unknown): output is DisplayOutput {
  if (typeof output !== "object" || output === null) return false;
  const o = output as Record<string, unknown>;
  const display = o.display as ToolDisplay | undefined;
  return o.ok === true && typeof display === "object" && display !== null && Array.isArray(display.items);
}

/** Applies `handler` to an ok output's display. A rendered block replaces the
 * structured items (marked `always` when the handler says so); an empty list
 * with nothing to show drops the display; a non-empty list with no rule stays
 * structured (so it isn't shown) and is reported through `log`. Any other
 * output is returned as it is, without calling the handler. */
function renderDisplay(output: unknown, handler: DisplayHandler, t: Translate, log: (m: string) => void, pluginName: string): unknown {
  if (!hasDisplay(output)) {
    return output;
  }
  const rendered = handler(output.display, t);
  if (rendered !== undefined) {
    const display: ToolDisplay = { type: output.display.type, items: [rendered.text] };
    if (rendered.always) display.always = true;
    return { ...output, display };
  }
  if (output.display.items.length === 0) {
    const { display: _dropped, ...rest } = output;
    return rest;
  }
  log(`[formatter] no rule for "${output.display.type}" lists from plugin "${pluginName}" — list not shown`);
  return output;
}

/**
 * Wraps `plugin` so the displays its tools return are rendered through
 * `handler`. Returns a plugin identical to `plugin` except for a `build` that
 * runs the inner `build` (passing the runtime context straight through) and
 * wraps its `sessionTools` factory: each tool it builds keeps every field but
 * `execute`, whose output goes through the handler with the turn's texts. A
 * CLI tool's display (attached by its post-processor) and a typed tool's take
 * the same path; the post-processor itself is left as it is.
 */
export function formatterPlugin(plugin: Plugin, handler: DisplayHandler): Plugin {
  return {
    ...plugin,
    build: (ctx) => {
      const inner = plugin.build ? plugin.build(ctx) : {};
      const factory = inner.sessionTools;
      if (factory === undefined) {
        return inner;
      }
      const sessionTools: PluginRuntimeContributions["sessionTools"] = (sctx, postProcess) => {
        const tools = factory(sctx, postProcess);
        const wrapped: typeof tools = {};
        for (const [name, tool] of Object.entries(tools)) {
          const { execute } = tool;
          wrapped[name] =
            execute === undefined
              ? tool
              : ({
                  ...tool,
                  execute: async (input: unknown, options: unknown) =>
                    renderDisplay(
                      await (execute as (i: unknown, o: unknown) => unknown)(input, options),
                      handler,
                      sctx.t,
                      ctx.log,
                      plugin.name,
                    ),
                } as ExecutableTool);
        }
        return wrapped;
      };
      return { ...inner, sessionTools };
    },
  };
}
