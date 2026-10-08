import { describe, expect, it } from "vitest";
import { markdownHeadingAnchor } from "../scripts/markdown-heading-anchor.mjs";

describe("documentation heading anchors", () => {
  it("normalises links and inline HTML", () => {
    expect(
      markdownHeadingAnchor(
        "[Read API](#read-api) <code>get()</code>",
      ),
    ).toBe("read-api-get");
  });

  it("handles overlapping and incomplete HTML-like text", () => {
    expect(
      markdownHeadingAnchor("Before <<span>inside> after"),
    ).toBe("before-inside-after");
    expect(
      markdownHeadingAnchor("Before <span after"),
    ).toBe("before-span-after");
  });
});
