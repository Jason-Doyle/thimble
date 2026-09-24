import packageJson from "../../../package.json";

export const site = {
  name: "ThimbleDB",
  url: "https://thimbledb.com",
  description:
    "Encrypted browser-first database for small web applications, backed by object storage.",
  repository: "https://github.com/Jason-Doyle/thimble",
  npm: "https://www.npmjs.com/package/thimbledb",
  version: packageJson.version,
  author: "Jason Doyle",
} as const;
