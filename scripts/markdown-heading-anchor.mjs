export function markdownHeadingAnchor(heading) {
  return withoutInlineHtml(
    heading.replace(/\[([^\]]+)]\([^)]+\)/g, "$1"),
  )
    .replace(/[`*_~]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s+/g, "-");
}

function withoutInlineHtml(value) {
  let result = "";
  let cursor = 0;
  while (cursor < value.length) {
    const opening = value.indexOf("<", cursor);
    if (opening === -1) {
      result += value.slice(cursor);
      break;
    }
    result += value.slice(cursor, opening);
    const closing = value.indexOf(">", opening + 1);
    if (closing === -1) {
      result += value.slice(opening);
      break;
    }
    cursor = closing + 1;
  }
  return result;
}
