/**
 * Tools a person runs with Mercury's own identity instead of theirs, which
 * takes `mercury.act-as-self` (see `offering.ts`). Their description says so,
 * since the model must use them only when the person explicitly asks; a
 * plugin acting as the person gets them as variants with other names, beside
 * the person's own. Every call is logged with who asked: the service only
 * ever sees Mercury.
 */
import type { Tool } from "ai";
import { truncateForDisplay } from "../router/tool-log.ts";

/** Appended to the name of a tool's variant acting as Mercury. */
export const AS_MERCURY_SUFFIX = "AsMercury";

/** Prefixed to the description of every tool acting as Mercury for a person (model-facing). */
export const AS_MERCURY_NOTE =
  "Runs with Mercury's own service identity, not the user's account: use it only when the user explicitly asks Mercury to act as itself.";

/** How much of a call's input the accountability log keeps. */
const MAX_LOGGED_INPUT = 500;

/** `tools`, acting as Mercury on `personKey`'s behalf: renamed when `rename`, described as such, every call logged. */
export function actingAsMercury(
  tools: Record<string, Tool>,
  opts: { plugin: string; personKey: string; rename: boolean; log: (msg: string) => void },
): Record<string, Tool> {
  const out: Record<string, Tool> = {};
  for (const [name, tool] of Object.entries(tools)) {
    const { execute } = tool;
    out[opts.rename ? `${name}${AS_MERCURY_SUFFIX}` : name] = {
      ...tool,
      description: `${AS_MERCURY_NOTE}${tool.description === undefined ? "" : ` ${tool.description}`}`,
      ...(execute === undefined
        ? {}
        : {
            execute: (input: unknown, options: unknown) => {
              opts.log(
                `[act-as-self] ${opts.personKey} ran ${name} of plugin "${opts.plugin}" as Mercury: ${truncateForDisplay(input, MAX_LOGGED_INPUT)}`,
              );
              return (execute as (i: unknown, o: unknown) => unknown)(input, options);
            },
          }),
    } as Tool;
  }
  return out;
}
