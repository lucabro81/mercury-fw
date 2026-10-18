/**
 * The Markdown version of a built page: its title and the rendered content
 * (components included, since it reads the HTML Starlight wrote, not the
 * source), with code blocks as fences and relative links made site paths so
 * they work from the `.md` address too.
 */
import type { Element, ElementContent, Root } from "hast";
import { select } from "hast-util-select";
import { toString } from "hast-util-to-string";
import rehypeParse from "rehype-parse";
import rehypeRemark from "rehype-remark";
import remarkGfm from "remark-gfm";
import remarkStringify from "remark-stringify";
import { unified } from "unified";
import { SKIP, visit } from "unist-util-visit";

/** An element with these children. */
const el = (tagName: string, properties: Element["properties"], children: ElementContent[]): Element => ({
  type: "element",
  tagName,
  properties,
  children,
});

/** Whether `node` carries the class `name`. */
const hasClass = (node: Element, name: string) => {
  const cls = node.properties.className;
  return Array.isArray(cls) && cls.includes(name);
};

/** An Expressive Code block as a plain `pre > code`, with its title (if any) as a bold paragraph before it. */
function plainCodeBlock(block: Element): ElementContent[] {
  const pre = select("pre", block);
  const copy = select("button[data-code]", block);
  const title = toString(select(".title", block) ?? el("span", {}, [])).trim();
  const code = String(copy?.properties.dataCode ?? toString(pre ?? block)).replace(/\u007f/g, "\n");
  const language = pre?.properties.dataLanguage;
  const fence = el("pre", {}, [el("code", language ? { className: [`language-${language}`] } : {}, [{ type: "text", value: code }])]);
  return title ? [el("p", {}, [el("strong", {}, [{ type: "text", value: title }])]), fence] : [fence];
}

/** A Starlight aside as a quote: its title in bold, then its content. */
function plainAside(aside: Element): Element {
  const title = toString(select(".starlight-aside__title", aside) ?? el("p", {}, [])).trim();
  const content = select(".starlight-aside__content", aside);
  return el("blockquote", {}, [el("p", {}, [el("strong", {}, [{ type: "text", value: title }])]), ...(content?.children ?? [])]);
}

/** Rewrites the content tree in place: code blocks, asides, heading anchors, decorations, links. */
function simplify(content: Element, pageUrl: string) {
  visit(content, "element", (node, index, parent) => {
    if (!parent || index === undefined) return;
    let replacement: ElementContent[] | null = null;
    if (hasClass(node, "expressive-code")) replacement = plainCodeBlock(node);
    else if (node.tagName === "aside" && hasClass(node, "starlight-aside")) replacement = [plainAside(node)];
    else if (hasClass(node, "sl-anchor-link") || ["svg", "link", "script", "style"].includes(node.tagName)) replacement = [];
    if (replacement) {
      parent.children.splice(index, 1, ...replacement);
      return [SKIP, index + replacement.length];
    }
    if (node.tagName === "a" && typeof node.properties.href === "string" && !/^[a-z]+:/i.test(node.properties.href)) {
      const resolved = new URL(node.properties.href, `https://site${pageUrl}`);
      node.properties.href = `${resolved.pathname}${resolved.hash}`;
    }
    return undefined;
  });
}

/**
 * The Markdown of the page whose built HTML is `html`, served at `pageUrl`
 * (its path, base included). Throws when the page has no Starlight content.
 */
export function pageMarkdown(html: string, pageUrl: string): string {
  const tree = unified().use(rehypeParse).parse(html) as Root;
  const content = select(".sl-markdown-content", tree);
  if (!content) throw new Error(`no page content in ${pageUrl}`);
  const title = toString(select("h1", tree) ?? el("h1", {}, [])).trim();
  simplify(content, pageUrl);
  const root: Root = { type: "root", children: [el("h1", {}, [{ type: "text", value: title }]), ...content.children] };
  const processor = unified().use(rehypeRemark).use(remarkGfm).use(remarkStringify, { fences: true, bullet: "-", rule: "-" });
  return String(processor.stringify(processor.runSync(root as never) as never));
}
