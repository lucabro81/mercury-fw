import { describe, expect, test } from "bun:test";
import { pageMarkdown } from "./page-markdown.ts";

/** A page as Starlight builds it: the title outside the content, the content in `.sl-markdown-content`. */
const page = (content: string, title = "Your first plugin") =>
  `<html><body><header><a href="/mercury-fw/">mercury framework</a></header><main>` +
  `<div class="sl-container"><h1 id="_top">${title}</h1></div>` +
  `<div class="sl-container"><div class="sl-markdown-content">${content}</div></div>` +
  `<footer><a href="/mercury-fw/changelog/">Mercury Framework 0.52.0</a></footer></main></body></html>`;

const url = "/mercury-fw/getting-started/local-plugin/";

describe("pageMarkdown", () => {
  test("the title and the content only, never the header, sidebar or footer", () => {
    const md = pageMarkdown(page("<p>A <strong>plugin</strong> is how an agent gets to do something.</p>"), url);
    expect(md).toBe("# Your first plugin\n\nA **plugin** is how an agent gets to do something.\n");
  });

  test("a code block becomes a fence with its language and the exact text the copy button holds", () => {
    const block =
      '<div class="expressive-code"><link rel="stylesheet" href="/x.css"><figure class="frame is-terminal"><figcaption class="header"><span class="title"></span><span class="sr-only">Terminal window</span></figcaption>' +
      '<pre data-language="bash"><code><div class="ec-line"><div class="code"><span>bun</span><span> add</span></div></div></code></pre>' +
      '<div class="copy"><button data-code="bun add @mercury-fw/kit ai zod"></button></div></figure></div>';
    expect(pageMarkdown(page(block), url)).toBe("# Your first plugin\n\n```bash\nbun add @mercury-fw/kit ai zod\n```\n");
  });

  test("a code block's title stays, in bold before the fence, and multi-line code keeps its lines", () => {
    const block =
      '<div class="expressive-code"><figure class="frame has-title"><figcaption class="header"><span class="title">.env</span></figcaption>' +
      '<pre data-language="bash"><code></code></pre><div class="copy"><button data-code="A=1\u007fB=2"></button></div></figure></div>';
    expect(pageMarkdown(page(block), url)).toBe("# Your first plugin\n\n**.env**\n\n```bash\nA=1\nB=2\n```\n");
  });

  test("relative links become site paths, so they work from the .md address too; others stay as they are", () => {
    const md = pageMarkdown(
      page('<p><a href="../../concepts/people/">People</a>, <a href="https://bun.sh">Bun</a>, <a href="#the-plugin">below</a>.</p>'),
      url,
    );
    expect(md).toBe(
      "# Your first plugin\n\n[People](/mercury-fw/concepts/people/), [Bun](https://bun.sh), [below](/mercury-fw/getting-started/local-plugin/#the-plugin).\n",
    );
  });

  test("headings keep their text without Starlight's anchor-link icons", () => {
    const heading =
      '<div class="sl-heading-wrapper level-h2"><h2 id="the-packages">The packages</h2><a class="sl-anchor-link" href="#the-packages"><span aria-hidden="true"><svg></svg></span><span class="sr-only">Section titled “The packages”</span></a></div>';
    expect(pageMarkdown(page(heading), url)).toBe("# Your first plugin\n\n## The packages\n");
  });

  test("an aside keeps its title and text as a quote", () => {
    const aside =
      '<aside class="starlight-aside starlight-aside--caution"><p class="starlight-aside__title"><svg></svg>The plugin contract will change</p><div class="starlight-aside__content"><p>Still settling.</p></div></aside>';
    expect(pageMarkdown(page(aside), url)).toBe("# Your first plugin\n\n> **The plugin contract will change**\n>\n> Still settling.\n");
  });

  test("a page without Starlight's content wrapper fails loudly instead of writing an empty file", () => {
    expect(() => pageMarkdown("<html><body><p>no content</p></body></html>", url)).toThrow(url);
  });
});
