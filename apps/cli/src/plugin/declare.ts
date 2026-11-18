/**
 * Declares a new plugin in the app: its package in `package.json`, and its
 * import and value in `mercury.config.ts`. The config is the app's own code,
 * edited by hand, so it's changed only where the place is found exactly once
 * and isn't taken (an `auth` already set stays as it is): otherwise nothing
 * is written there, and the lines to add come back for the user to place.
 * Text edits, no parser: the anchors are the ones a new app's config has.
 */
import { pluginKind, type PluginKind } from "./kinds.ts";

/** `manifest` (a `package.json`'s text) with `packageName` among its dependencies from the workspace, and trusted to run its postinstall when `trusted`. */
export function addToManifest(manifest: string, packageName: string, opts: { trusted: boolean }): string {
  const pkg = JSON.parse(manifest) as { dependencies?: Record<string, string>; trustedDependencies?: string[] };
  const dependencies = { ...pkg.dependencies, [packageName]: "workspace:*" };
  pkg.dependencies = Object.fromEntries(Object.entries(dependencies).sort(([a], [b]) => a.localeCompare(b)));
  if (opts.trusted) {
    pkg.trustedDependencies = [...new Set([...(pkg.trustedDependencies ?? []), packageName])].sort();
  }
  return `${JSON.stringify(pkg, null, 2)}\n`;
}

export type DeclareInput = { kind: PluginKind; exportName: string; packageName: string };

/** The config after declaring, whether it was changed, and the lines to add by hand when it wasn't. */
export type Declared = { text: string; written: boolean; lines: string[] };

/** Where the next top-level import goes: after the end of the last one, or `undefined` when there's none. */
function afterLastImport(config: string): number | undefined {
  let end: number | undefined;
  for (const match of config.matchAll(/^(?:import\s[^;]*?from\s+["'][^"']+["']|import\s+["'][^"']+["']);?[^\S\n]*$/gm)) {
    end = match.index + match[0].length;
  }
  return end;
}

/** The index of the `]` closing the list opened at `open`, skipping strings and nested brackets; `undefined` when it isn't closed. */
function closingBracket(text: string, open: number): number | undefined {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"' || c === "'" || c === "`") {
      // A string: jump past its closing quote, escapes included.
      for (i++; i < text.length && text[i] !== c; i++) if (text[i] === "\\") i++;
    } else if (c === "[" || c === "(" || c === "{") depth++;
    else if (c === "]" || c === ")" || c === "}") {
      depth--;
      if (depth === 0) return c === "]" ? i : undefined;
    }
  }
  return undefined;
}

/** `config` with `value` at the end of the `key: [...]` list, or `undefined` when the list isn't there exactly once. */
function appendToList(config: string, key: string, value: string): string | undefined {
  const matches = [...config.matchAll(new RegExp(`^[^\\S\\n]*${key}:\\s*\\[`, "gm"))];
  if (matches.length !== 1) return undefined;
  const open = matches[0]!.index + matches[0]![0].length - 1;
  const close = closingBracket(config, open);
  if (close === undefined) return undefined;
  const inside = config.slice(open + 1, close);
  // A comment in the list could take the comma meant for the new element, or hide a bracket: left to the user.
  if (/\/\/|\/\*/.test(inside)) return undefined;
  if (inside.trim() === "") return `${config.slice(0, open + 1)}${value}${config.slice(close)}`;
  if (inside.includes("\n")) {
    // One element per line: a line of its own, indented as the last element.
    const lineStart = config.lastIndexOf("\n", close) + 1;
    const lastElement = inside.trimEnd().split("\n").at(-1)!;
    const indent = /^\s*/.exec(lastElement)![0];
    const comma = inside.trimEnd().endsWith(",") ? "" : ",";
    const before = config.slice(0, open + 1) + inside.trimEnd() + comma;
    return `${before}\n${indent}${value},\n${config.slice(lineStart)}`;
  }
  const trimmed = inside.trimEnd().replace(/,$/, "");
  return `${config.slice(0, open + 1)}${trimmed}, ${value}${config.slice(close)}`;
}

/** `config` with `line` right after `defineMercuryConfig({`, or `undefined` when that isn't there exactly once. */
function addKey(config: string, line: string): string | undefined {
  const matches = [...config.matchAll(/defineMercuryConfig\(\{[^\S\n]*\n/g)];
  if (matches.length !== 1) return undefined;
  const at = matches[0]!.index + matches[0]![0].length;
  return `${config.slice(0, at)}  ${line}\n${config.slice(at)}`;
}

/** Whether the config sets `key` already. */
const hasKey = (config: string, key: string) => new RegExp(`^[^\\S\\n]*${key}\\s*:`, "m").test(config);

/** Declares the plugin in `config` (see the module comment). */
export function declareInConfig(config: string, input: DeclareInput): Declared {
  const value = `${input.exportName}()`;
  const importLine = `import { ${input.exportName} } from "${input.packageName}";`;
  const declaration = pluginKind(input.kind).declare;
  const unwritten = (line: string): Declared => ({ text: config, written: false, lines: [importLine, line] });
  // A name the config already uses would be imported twice.
  const named = new RegExp(`\\b${input.exportName}\\b`).test(config);

  let declared: string | undefined;
  let fallback: string;
  switch (declaration.in) {
    case "array":
      fallback = `${declaration.key}: [..., ${value}],`;
      declared = appendToList(config, declaration.key, value);
      break;
    case "key": {
      const key = declaration.key;
      if (hasKey(config, key)) {
        const current = new RegExp(`^[^\\S\\n]*${key}\\s*:\\s*([^,\\n]+)`, "m").exec(config)?.[1]?.trim();
        return unwritten(
          key === "auth" && current !== undefined && !current.startsWith("[")
            ? `auth: ${value},  // or a list with the provider already there: auth: [${current}, ${value}]`
            : `${key}: ${value},  // in place of the one there`,
        );
      }
      fallback = `${key}: ${value},`;
      declared = addKey(config, fallback);
      break;
    }
    case "traces":
      if (hasKey(config, "traces")) return unwritten(`sink: ${value},  // in traces, in place of the sink there`);
      fallback = `traces: { sink: ${value} },`;
      declared = addKey(config, fallback);
      break;
    case "profile":
      return unwritten(`const conversation = ${value};  // in place of the conversation there, in plugins and in the profile`);
  }

  const importAt = declared === undefined ? undefined : afterLastImport(declared);
  if (declared === undefined || importAt === undefined || named) return unwritten(fallback);
  return { text: `${declared.slice(0, importAt)}\n${importLine}${declared.slice(importAt)}`, written: true, lines: [] };
}
