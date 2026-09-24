export const repositoryUrl = "https://github.com/Jason-Doyle/thimble";

const specialRoutes = new Map([
  ["faq", "/faq/"],
  ["use-cases", "/use-cases/"],
  ["benchmarks", "/benchmarks/"],
  ["security", "/security/"],
  ["changelog", "/changelog/"],
]);

/** @param {string} id */
export function docRoute(id) {
  const normalized = normalizeId(id);
  const special = specialRoutes.get(normalized);
  if (special) {
    return special;
  }
  if (normalized.startsWith("use-cases/")) {
    return `/${normalized}/`;
  }
  return `/docs/${normalized}/`;
}

/** @param {string} value */
export function normalizeId(value) {
  return value
    .replaceAll("\\", "/")
    .replace(/^docs\//i, "")
    .replace(/\.md$/i, "")
    .toLowerCase();
}

/** @param {string} id */
export function sourcePathForId(id) {
  const normalized = normalizeId(id);
  if (normalized === "changelog") {
    return "CHANGELOG.md";
  }
  if (normalized.startsWith("use-cases/")) {
    return `docs/use-cases/${normalized
      .slice("use-cases/".length)
      .toUpperCase()}.md`;
  }
  return `docs/${normalized.toUpperCase()}.md`;
}
