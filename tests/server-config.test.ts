import { describe, expect, it } from "vitest";
import { validateAzureReadBaseUrl } from "../src/server-config.js";

describe("Azure browser read configuration", () => {
  it("accepts an HTTPS read-only SAS scoped to the configured path", () => {
    expect(
      validateAzureReadBaseUrl(
        "https://account.blob.core.windows.net/thimbledb/demo?sp=r&sr=c&sig=test",
        "thimbledb",
        "demo",
      ),
    ).toContain("/thimbledb/demo?");
  });

  it("rejects a SAS with write or delete permissions", () => {
    expect(() =>
      validateAzureReadBaseUrl(
        "https://account.blob.core.windows.net/thimbledb/demo?sp=rwd&sr=c&sig=test",
        "thimbledb",
        "demo",
      ),
    ).toThrow("read permission only");
  });

  it("rejects a URL that omits the container or prefix", () => {
    expect(() =>
      validateAzureReadBaseUrl(
        "https://account.blob.core.windows.net/content-trie?sp=r&sr=c&sig=test",
        "thimbledb",
        "demo",
      ),
    ).toThrow("must end with /thimbledb/demo");
  });

  it("rejects account SAS tokens and unscoped resources", () => {
    expect(() =>
      validateAzureReadBaseUrl(
        "https://account.blob.core.windows.net/thimbledb/demo?sp=r&ss=b&srt=o&sig=test",
        "thimbledb",
        "demo",
      ),
    ).toThrow("Account SAS");

    expect(() =>
      validateAzureReadBaseUrl(
        "https://account.blob.core.windows.net/thimbledb/demo?sp=r&sr=b&sig=test",
        "thimbledb",
        "demo",
      ),
    ).toThrow("container or directory");
  });
});
