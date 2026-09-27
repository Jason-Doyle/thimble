import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  publicDir: fileURLToPath(
    new URL("./public", import.meta.url),
  ),
  build: {
    target: "es2022",
    outDir: fileURLToPath(
      new URL(
        "../../.bench-data/adaptive-head-revalidation/assets",
        import.meta.url,
      ),
    ),
    emptyOutDir: true,
    minify: false,
  },
});
