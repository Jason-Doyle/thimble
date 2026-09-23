import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(".thimble-e2e");
await rm(root, {
  recursive: true,
  force: true,
});

const child = spawn("npm run dev", {
  shell: true,
  stdio: "inherit",
  env: {
    ...process.env,
    THIMBLE_PREFIX: "e2e",
    THIMBLE_AUTH_RATE_LIMIT: "100",
    THIMBLE_LOCAL_DATA_ROOT: path.join(root, "data"),
    THIMBLE_LOCAL_AUTH_ROOT: path.join(root, "auth"),
    THIMBLE_LOCAL_SECRET_ROOT: path.join(root, "secrets"),
  },
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => child.kill(signal));
}

child.on("exit", (code) => {
  process.exit(code ?? 0);
});
