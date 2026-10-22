// The documentation site: Starlight on Astro, our theme in one CSS file
// (src/styles/theme.css), the header and footer replaced, the contracts'
// reference generated from the types.
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import starlightTypeDoc, { typeDocSidebarGroup } from "starlight-typedoc";
import starlightLlmsTxt from "starlight-llms-txt";

export default defineConfig({
  site: "https://lucabro81.github.io",
  base: "/mercury-fw",
  trailingSlash: "always",
  integrations: [
    starlight({
      title: "Mercury Framework",
      description: "A framework for building your own agent: you declare what it's made of, Mercury runs the rest.",
      favicon: "/favicon.svg",
      customCss: [
        "@fontsource/ibm-plex-serif/latin-400.css",
        "@fontsource/ibm-plex-serif/latin-400-italic.css",
        "@fontsource/ibm-plex-serif/latin-700.css",
        "@fontsource/ibm-plex-mono/latin-400.css",
        "@fontsource/ibm-plex-mono/latin-700.css",
        "./src/styles/theme.css",
      ],
      components: {
        Header: "./src/components/Header.astro",
        Footer: "./src/components/Footer.astro",
        PageTitle: "./src/components/PageTitle.astro",
        Sidebar: "./src/components/Sidebar.astro",
        MobileMenuFooter: "./src/components/MobileMenuFooter.astro",
      },
      expressiveCode: {
        themes: ["github-dark-default", "github-light-default"],
        styleOverrides: { borderRadius: "4px", frames: { shadowColor: "transparent" } },
        // Wrapped lines: a block that scrolls sideways is a region keyboard users can't reach.
        defaultProps: { wrap: true, preserveIndent: true },
      },
      pagefind: true,
      plugins: [
        starlightTypeDoc({
          entryPoints: [
            "../../packages/libs/core/index.ts",
            "../../packages/types/plugin-types/index.ts",
            "../../packages/types/channel-types/index.ts",
          ],
          tsconfig: "./typedoc.tsconfig.json",
          output: "reference/api",
          sidebar: { label: "Contracts (generated)", collapsed: true },
          typeDoc: { excludePrivate: true, excludeInternal: true, entryFileName: "index" },
        }),
        starlightLlmsTxt(),
      ],
      sidebar: [
        { label: "Getting started", items: [{ autogenerate: { directory: "getting-started" } }] },
        { label: "Concepts", items: [{ autogenerate: { directory: "concepts" } }] },
        {
          label: "Reference",
          items: [
            "reference/config",
            "reference/cli",
            "reference/environment",
            { label: "HTTP API", link: "/reference/http-api/", attrs: { "data-external-page": "" } },
            typeDocSidebarGroup,
          ],
        },
        { label: "Plugins", items: [{ autogenerate: { directory: "plugins" } }] },
        { label: "Changelog", link: "/changelog/" },
      ],
    }),
  ],
});
