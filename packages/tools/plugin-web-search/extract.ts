/**
 * What `web_fetch` hands the model of a page: its title and its text, not its
 * HTML. Readability (the algorithm behind Firefox's reader view) finds the
 * main content and drops menus, footers, banners and sidebars; `linkedom`
 * gives it a DOM without a browser. A page Readability finds no article in
 * (an index, a list of links) falls back to its whole text, scripts and
 * styles removed. Plain text stays as it is. No JavaScript runs, so a page
 * that builds its content in the browser comes back nearly empty.
 */
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";

export type ExtractedPage = { title: string; text: string; truncated: boolean };

/** Block-level tags whose boundaries become line breaks in the text. */
const BLOCK_TAGS = /<(\/?)(p|div|h[1-6]|li|ul|ol|br|tr|pre|blockquote|section|article|header|footer|table|dt|dd|hr)\b[^>]*>/gi;

/** Tags whose text is never content. */
const NOT_CONTENT = "script, style, noscript, template, svg";

/** Collapses runs of spaces, trims each line, and keeps at most one empty line in a row. */
function tidy(text: string): string {
  return text
    .replace(/[ \t ]+/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** The readable text of an HTML fragment or document, block boundaries kept as line breaks. */
function htmlToText(html: string): string {
  const { document } = parseHTML(`<!doctype html><html><body>${html.replace(BLOCK_TAGS, "\n$&")}</body></html>`);
  for (const el of document.querySelectorAll(NOT_CONTENT)) el.remove();
  return tidy(document.body?.textContent ?? "");
}

/** The title and text of a downloaded page, cut at `maxChars`. */
export function extractText(body: string, contentType: string, url: string, maxChars: number): ExtractedPage {
  let title = url;
  let text: string;
  if (/^text\/plain\b/i.test(contentType)) {
    text = body;
  } else {
    // Without an <html> tag linkedom takes the first element for the document
    // and leaves the body empty: a bare page gets a document around it.
    const html = /<html[\s>]/i.test(body) ? body : `<!doctype html><html><body>${body}</body></html>`;
    const { document } = parseHTML(html);
    const pageTitle = document.querySelector("title")?.textContent?.trim();
    const article = new Readability(document as unknown as ConstructorParameters<typeof Readability>[0]).parse();
    if (article?.content && article.textContent && article.textContent.trim().length > 0) {
      title = article.title?.trim() || pageTitle || url;
      text = htmlToText(article.content);
    } else {
      title = pageTitle || url;
      const { document: whole } = parseHTML(html);
      for (const el of whole.querySelectorAll(NOT_CONTENT)) el.remove();
      text = htmlToText(whole.body?.innerHTML ?? whole.documentElement?.innerHTML ?? "");
    }
  }
  const truncated = text.length > maxChars;
  return { title, text: truncated ? text.slice(0, maxChars) : text, truncated };
}
