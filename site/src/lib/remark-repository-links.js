import path from "node:path";
import { docRoute, normalizeId, repositoryUrl } from "./routes.js";

/**
 * @param {{ repositoryRoot: string }} options
 */
export default function remarkRepositoryLinks(options) {
  const repositoryRoot = path.resolve(options.repositoryRoot);
  const docsRoot = path.join(repositoryRoot, "docs");

  /**
   * @param {import("mdast").Root} tree
   * @param {import("vfile").VFile} file
   */
  return (tree, file) => {
    walk(tree, (node) => {
      if (node.type !== "link" || typeof node.url !== "string") {
        return;
      }
      if (
        node.url.startsWith("#") ||
        /^[a-z][a-z\d+.-]*:/i.test(node.url)
      ) {
        return;
      }

      const [target, fragment = ""] = node.url.split("#", 2);
      if (!target) {
        return;
      }

      const currentFile = file.path
        ? path.resolve(String(file.path))
        : docsRoot;
      const absolute = path.resolve(path.dirname(currentFile), target);
      const repositoryRelative = path
        .relative(repositoryRoot, absolute)
        .replaceAll("\\", "/");

      if (target.toLowerCase().endsWith(".md")) {
        const id =
          repositoryRelative.toLowerCase() === "changelog.md"
            ? "changelog"
            : normalizeId(path.relative(docsRoot, absolute));
        node.url = `${docRoute(id)}${fragment ? `#${fragment}` : ""}`;
        return;
      }

      if (
        !repositoryRelative.startsWith("../") &&
        !path.isAbsolute(repositoryRelative)
      ) {
        node.url =
          `${repositoryUrl}/blob/main/${repositoryRelative}` +
          `${fragment ? `#${fragment}` : ""}`;
      }
    });
  };
}

/**
 * @param {import("mdast").Nodes} node
 * @param {(node: import("mdast").Nodes) => void} visit
 */
function walk(node, visit) {
  visit(node);
  if (!("children" in node) || !Array.isArray(node.children)) {
    return;
  }
  for (const child of node.children) {
    walk(child, visit);
  }
}
