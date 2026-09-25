import { site } from "../data/site";

export const prerender = true;

export function GET() {
  return new Response(
    [
      "# ThimbleDB permits crawling and search indexing.",
      "User-agent: *",
      "Allow: /",
      `Sitemap: ${site.url}/sitemap-index.xml`,
      "",
    ].join("\n"),
    {
      headers: {
        "content-type": "text/plain; charset=utf-8",
      },
    },
  );
}
