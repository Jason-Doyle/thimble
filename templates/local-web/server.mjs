process.env.THIMBLE_PROVIDER ??= "local";
process.env.THIMBLE_HOST ??= "127.0.0.1";
process.env.THIMBLE_PORT ??= "8787";
process.env.THIMBLE_ALLOWED_ORIGIN ??= "http://127.0.0.1:5173";
process.env.THIMBLE_DEV_IDENTITY ??= "true";

const { startNodeAuthority } = await import(
  "thimbledb/authority/node"
);

await startNodeAuthority({
  collectionLayouts: {
    notes: "snapshot",
  },
  collectionIndexes: {
    notes: [
      {
        name: "by-title",
        fields: ["title"],
        mode: "equality",
      },
      {
        name: "by-last-modified",
        fields: ["lastModified"],
        mode: "range",
      },
    ],
  },
});
