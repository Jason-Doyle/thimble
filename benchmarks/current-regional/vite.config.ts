import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    target: "node22",
    ssr: fileURLToPath(
      new URL("./client-runner.ts", import.meta.url),
    ),
    outDir: fileURLToPath(
      new URL(
        "../../.bench-data/current-regional/assets",
        import.meta.url,
      ),
    ),
    emptyOutDir: true,
    minify: false,
    rollupOptions: {
      output: {
        entryFileNames: "runner.mjs",
      },
    },
  },
});
