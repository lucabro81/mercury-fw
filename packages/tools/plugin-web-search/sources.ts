/**
 * The sources of an answer built on web pages: after a turn that read pages
 * with `web_fetch` (the one read after the person allowed it included), the
 * answer ends with "Fonti:" and the title and URL of each page, in the order
 * they were read, once each. Written by the plugin from the turn's tool
 * results, never by the model, so it can't be left out or made up.
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
    .replace(/[*_`~#|<>\[\]()]/g, "")
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

/** The guard that lists the sources (see the module comment). */
export function createSourcesGuard(): PostTurnGuard {
  return {
    statusLabel: "Aggiungo le fonti…",
    statusId: "web-search-sources",
    shouldRun: (text, steps) => text.trim() !== "" && text.trim() !== "NO_REPLY" && pagesRead(steps).length > 0,
    run: async (text, steps) => {
      const lines = pagesRead(steps).map((p) => (p.title === "" || p.title === p.url ? `- ${p.url}` : `- ${p.title}: ${p.url}`));
      return { text: `${text}\n\nFonti:\n${lines.join("\n")}`, outcome: "success" };
    },
  };
}
