/**
 * The Markdown version of every page, at the page's address with `.md` in
 * place of the trailing slash (`/concepts/memory.md`), for coding agents and
 * anyone who'd rather read the source: the title, the description, the body.
 */
import type { APIRoute, GetStaticPaths } from "astro";
import { getCollection, type CollectionEntry } from "astro:content";

export const getStaticPaths = (async () => {
  const pages = await getCollection("docs");
  return pages.map((page) => ({ params: { slug: page.id }, props: { page } }));
}) satisfies GetStaticPaths;

export const GET: APIRoute<{ page: CollectionEntry<"docs"> }> = ({ props }) => {
  const { title, description } = props.page.data;
  const text = [`# ${title}`, description ? `> ${description}` : null, props.page.body ?? ""].filter((part) => part !== null).join("\n\n");
  return new Response(text, { headers: { "content-type": "text/markdown; charset=utf-8" } });
};
