import { getCollection } from "astro:content";
import { docs } from "../data/docs";
import { docRoute } from "../lib/routes.js";
import { site } from "../data/site";

export const prerender = true;

const includedIds = docs.map((doc) => doc.id);

export async function GET() {
  const entries = await getCollection("docs");
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const sections = includedIds.flatMap((id) => {
    const entry = byId.get(id);
    if (!entry?.body) {
      return [];
    }
    return [
      `\n\n---\n\nSource: ${site.url}${docRoute(id)}\n\n${entry.body.trim()}`,
    ];
  });

  return new Response(
    `# ThimbleDB full documentation context\n\n` +
      `Canonical site: ${site.url}\n` +
      `Repository: ${site.repository}\n` +
      `Package version: ${site.version}\n` +
      sections.join(""),
    {
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "public, max-age=3600",
      },
    },
  );
}
