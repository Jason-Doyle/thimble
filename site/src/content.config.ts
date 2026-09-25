import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";

const docs = defineCollection({
  loader: glob({
    pattern: [
      "**/*.md",
      "!README.md",
      // Contributor release operations are public repository documentation,
      // but not application-user documentation for the product website.
      "!NPM-PUBLISHING.md",
    ],
    base: new URL("../../docs", import.meta.url),
    generateId: ({ entry }) =>
      entry.replace(/\.md$/i, "").toLowerCase(),
  }),
});

const project = defineCollection({
  loader: glob({
    pattern: "CHANGELOG.md",
    base: new URL("../..", import.meta.url),
    generateId: () => "changelog",
  }),
});

export const collections = { docs, project };
