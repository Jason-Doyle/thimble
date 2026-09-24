import { site } from "../data/site";

export const prerender = true;

export function GET() {
  return new Response(
    [
      "# ThimbleDB permits search indexing, real-time AI input, and model training.",
      "User-agent: *",
      "Allow: /",
      "Content-Signal: search=yes, ai-input=yes, ai-train=yes",
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
