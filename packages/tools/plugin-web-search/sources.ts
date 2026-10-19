/**
 * The sources of an answer built on web pages: after a turn that read pages
 * with `web_fetch` (the one read after the person allowed it included), the
 * answer ends with "Fonti:" and the title and URL of each page, in the order
 * they were read, once each. Written by the plugin from the turn's tool
 * results, never by the model, so it can't be left out or made up; a list the
 * model wrote at the end of its answer anyway is dropped.
 */
import type { PostTurnGuard, StepInfo } from "@mercury-fw/plugin-types";

/** A page `web_fetch` read in the turn. */
type ReadPage = { url: string; title: string };

/** Longest title shown, in characters. */
const MAX_TITLE = 120;

/**
 * A title as the person sees it: it's the site's text, so it brings no link,
 * address or formatting of its own (a chat client would render them), stays
 * on one line and is cut at `MAX_TITLE`.
 */
function plainTitle(title: string): string {
  const plain = title
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, "")
    // An address with a path, even without a scheme (a chat client links it); a dotted word like Node.js stays.
    .replace(/\b(?:[a-z0-9-]+\.)+[a-z]{2,}\/\S*/gi, "")
    .replace(/\s*\|\s*/g, " · ")
    .replace(/[*_`~#<>\[\]()]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return plain.length > MAX_TITLE ? `${plain.slice(0, MAX_TITLE)}…` : plain;
}

/** The pages read successfully in `steps`, in order, once each. */
function pagesRead(steps: StepInfo[] = []): ReadPage[] {
  const pages = new Map<string, ReadPage>();
  for (const step of steps) {
    for (const result of step.toolResults) {
      if (result.toolName !== "web_fetch") continue;
      const out = result.output as { ok?: unknown; url?: unknown; title?: unknown } | undefined;
      if (out?.ok !== true || typeof out.url !== "string" || pages.has(out.url)) continue;
      pages.set(out.url, { url: out.url, title: typeof out.title === "string" ? plainTitle(out.title) : "" });
    }
  }
  return [...pages.values()];
}

/** A heading the model gives its own list of sources: `Fonti`/`Sources`, bold or a Markdown heading, colon or not. */
const SOURCES_HEADING = /^\s*(?:#{1,6}\s+)?[*_]*(?:fonti|sources)[*_]*\s*:?\s*[*_]*\s*$/i;
/** A line of such a list: a bulleted or numbered item, or a bare URL. */
const LIST_LINE = /^\s*(?:(?:[-*•]|\d+[.)])\s+\S|<?https?:\/\/\S)/;

/**
 * `text` without the list of sources the model wrote at its end (a heading,
 * then only list lines and blank lines), so the guard's list is the only one.
 * Anything else, prose after the list included, stays as it is.
 */
function withoutModelSources(text: string): string {
  const lines = text.split("\n");
  let end = lines.length;
  while (end > 0 && lines[end - 1]!.trim() === "") end--;
  let start = end;
  while (start > 0 && (LIST_LINE.test(lines[start - 1]!) || lines[start - 1]!.trim() === "")) start--;
  const listed = lines.slice(start, end).some((line) => LIST_LINE.test(line));
  if (!listed || start === 0 || !SOURCES_HEADING.test(lines[start - 1]!)) return text;
  return lines.slice(0, start - 1).join("\n").trimEnd();
}

/** The guard that lists the sources (see the module comment). */
export function createSourcesGuard(): PostTurnGuard {
  return {
    statusLabel: "Aggiungo le fonti…",
    statusId: "web-search-sources",
    shouldRun: (text, steps) => text.trim() !== "" && text.trim() !== "NO_REPLY" && pagesRead(steps).length > 0,
    run: async (text, steps) => {
      const lines = pagesRead(steps).map((p) => (p.title === "" || p.title === p.url ? `- ${p.url}` : `- ${p.title}: ${p.url}`));
      const answer = withoutModelSources(text);
      const sources = `Fonti:\n${lines.join("\n")}`;
      return { text: answer === "" ? sources : `${answer}\n\n${sources}`, outcome: "success" };
    },
  };
}
