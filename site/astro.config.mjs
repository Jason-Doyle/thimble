import { fileURLToPath } from "node:url";
import sitemap from "@astrojs/sitemap";
import { unified } from "@astrojs/markdown-remark";
import { defineConfig } from "astro/config";
import remarkRepositoryLinks from "./src/lib/remark-repository-links.js";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

export default defineConfig({
  site: "https://thimbledb.com",
  output: "static",
  trailingSlash: "always",
  integrations: [
    sitemap({
      filter: (page) => !page.endsWith("/search/"),
    }),
  ],
  markdown: {
    processor: unified({
      remarkPlugins: [
        [
          remarkRepositoryLinks,
          {
            repositoryRoot,
          },
        ],
      ],
    }),
    syntaxHighlight: "shiki",
    shikiConfig: {
      theme: "github-dark-default",
      wrap: true,
    },
  },
  vite: {
    preview: {
      allowedHosts: true,
    },
    server: {
      fs: {
        allow: [repositoryRoot],
      },
    },
  },
});
