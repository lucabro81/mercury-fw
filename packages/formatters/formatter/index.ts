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
 *   its post-processor emits goes through the handler; everything else the
 *   plugin contributes passes through untouched.
 */
import type { Plugin, CliPostProcessor, CliResult, ToolDisplay, Translate } from "@mercury-fw/plugin-types";

/** Renders one display into the single text block shown to the user, in the
 * turn's language (`t`), or returns `undefined` when there is nothing to show
 * (no rule for its kind, or an empty list with no empty text). */
export type DisplayHandler = (display: ToolDisplay, t: Translate) => string | undefined;

/** How one kind of list is rendered: the line for each item, or that plus the
 * text to show when the list is empty. Both may use `t`, the texts of the
 * person the turn is for (an app's own keys in its language files). */
export type FormatterRule<T> =
  | ((item: T, t: Translate) => string)
  | { item: (item: T, t: Translate) => string; empty?: string | ((t: Translate) => string) };

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
    const { item, empty } = typeof rule === "function" ? { item: rule, empty: undefined } : rule;
    if (display.items.length === 0) {
      return typeof empty === "function" ? empty(t) : empty;
    }
    return display.items.map((i) => item(i, t)).join(ITEM_SEPARATOR);
  };
}

/** Applies `handler` to an ok result's display. A rendered block replaces the
 * structured items; an empty list with nothing to show drops the display; a
 * non-empty list with no rule stays structured (so it isn't shown) and is
 * reported through `log`. Non-ok results and results with no display are
 * returned as they are, without calling the handler. */
function renderDisplay(
  result: CliResult,
  handler: DisplayHandler,
  t: Translate,
  log: (m: string) => void,
  pluginName: string,
): CliResult {
  if (!result.ok || !result.display) {
    return result;
  }
  const text = handler(result.display, t);
  if (text !== undefined) {
    return { ...result, display: { ...result.display, items: [text] } };
  }
  if (result.display.items.length === 0) {
    const { display: _dropped, ...rest } = result;
    return rest;
  }
  log(`[formatter] no rule for "${result.display.type}" lists from plugin "${pluginName}" — list not shown`);
  return result;
}

/**
 * Wraps `plugin` so its post-processor's displays are rendered through
 * `handler`. Returns a plugin identical to `plugin` except for a `build` that
 * runs the inner `build` (passing the runtime context straight through) and
 * wraps the post-processor it contributes; the wrapped one flows to the
 * plugin's `sessionTools` factory, which the composition hands it to.
 */
export function formatterPlugin(plugin: Plugin, handler: DisplayHandler): Plugin {
  return {
    ...plugin,
    build: (ctx) => {
      const inner = plugin.build ? plugin.build(ctx) : {};
      const proc = inner.postProcess;
      const wrapped: CliPostProcessor | undefined = proc
        ? (cmd, result, t) => renderDisplay(proc(cmd, result, t), handler, t, ctx.log, plugin.name)
        : undefined;
      return { ...inner, postProcess: wrapped };
    },
  };
}
