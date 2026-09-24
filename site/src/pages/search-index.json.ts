import { getCollection } from "astro:content";
import { getDocMeta } from "../data/docs";
import { plainText } from "../lib/faq";
import { docRoute } from "../lib/routes.js";

export const prerender = true;

export async function GET() {
  const [docs, project] = await Promise.all([
    getCollection("docs"),
    getCollection("project"),
  ]);
  const index = [...docs, ...project].map((entry) => {
    const meta = getDocMeta(entry.id);
    return {
      title: meta.title,
      description: meta.description,
      href: docRoute(entry.id),
      group: meta.group,
      text: plainText(entry.body ?? "").slice(0, 8_000),
    };
  });

  return new Response(JSON.stringify(index), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=3600",
    },
  });
}
