import { defineConfig } from "vite";

export default defineConfig({
  build: {
    outDir: "dist/browser",
    emptyOutDir: true,
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:8787",
      "/objects": "http://127.0.0.1:8787",
    },
  },
});
