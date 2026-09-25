import {
  existsSync,
  readFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

/**
 * @param {{ publicDirectory: string }} options
 */
export default function remarkMermaidDiagrams(options) {
  const publicDirectory = path.resolve(options.publicDirectory);

  /** @param {import("mdast").Root} tree */
  return (tree) => {
    let currentHeading = "System";
    for (const [index, child] of tree.children.entries()) {
      if (child.type === "heading") {
        currentHeading = plainText(child) || currentHeading;
      }
      if (child.type === "code" && child.lang === "mermaid") {
        const source = normalizeSource(child.value);
        const hash = createHash("sha256")
          .update(source)
          .digest("hex")
          .slice(0, 20);
        const fileName = `${hash}.svg`;
        const assetPath = path.join(publicDirectory, fileName);
        if (!existsSync(assetPath)) {
          throw new Error(
            `Missing generated Mermaid asset ${fileName}. Run npm --prefix site run generate:diagrams.`,
          );
        }
        const dimensions = svgDimensions(
          readFileSync(assetPath, "utf8"),
        );
        const caption = `${currentHeading} diagram`;
        tree.children[index] = {
          type: "html",
          value: [
            '<figure class="mermaid-figure">',
            `<img class="mermaid-static" src="/diagrams/${fileName}" alt="${escapeHtml(caption)}" loading="lazy" decoding="async"${dimensions}>`,
            `<figcaption>${escapeHtml(caption)}</figcaption>`,
            '<details class="mermaid-source">',
            "<summary>View Mermaid source</summary>",
            `<pre data-language="mermaid"><code>${escapeHtml(source)}</code></pre>`,
            "</details>",
            "</figure>",
          ].join(""),
        };
      }
    }
  };
}

/**
 * @param {import("mdast").Nodes} node
 * @returns {string}
 */
function plainText(node) {
  if ("value" in node && typeof node.value === "string") {
    return node.value;
  }
  if (!("children" in node) || !Array.isArray(node.children)) {
    return "";
  }
  return node.children.map(plainText).join("");
}

/** @param {string} svg */
function svgDimensions(svg) {
  const match =
    /<svg\b[^>]*\bviewBox="[-\d.]+ [-\d.]+ ([\d.]+) ([\d.]+)"/.exec(
      svg,
    );
  return match
    ? ` width="${Math.ceil(Number(match[1]))}" height="${Math.ceil(Number(match[2]))}"`
    : "";
}

/** @param {string} source */
function normalizeSource(source) {
  return source.replace(/\r\n/g, "\n").trim();
}

/** @param {string} value */
function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
