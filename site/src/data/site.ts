import packageJson from "../../../package.json";

export const site = {
  name: "ThimbleDB",
  url: "https://thimbledb.com",
  description:
    "Encrypted browser-first JSON database for small web apps, backed by object storage with in-app or separate Cloudflare and Node authorities.",
  repository: "https://github.com/Jason-Doyle/thimble",
  issues: "https://github.com/Jason-Doyle/thimble/issues",
  license:
    "https://github.com/Jason-Doyle/thimble/blob/main/LICENSE",
  npm: "https://www.npmjs.com/package/thimbledb",
  version: packageJson.version,
  author: "Jason Doyle",
} as const;
