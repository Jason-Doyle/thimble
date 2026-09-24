import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";
import { ImmutableSnapshotEngine } from "thimbledb";
import { LocalObjectStore } from "thimbledb/providers/local";

const dataDirectory = path.resolve(".data");
const database = new ImmutableSnapshotEngine(
  new LocalObjectStore(dataDirectory),
);
const [command = "help", ...args] = process.argv.slice(2);

if (command === "demo") {
  await rm(dataDirectory, { recursive: true, force: true });
  await database.putMany("notes", [
    {
      id: "welcome",
      title: "Welcome",
      body: "Stored by ThimbleDB without a database process.",
    },
    {
      id: "fit-check",
      title: "Fit check",
      body: "Use bounded collections and modest write concurrency.",
    },
  ]);
  console.log(JSON.stringify(await database.scan("notes"), null, 2));
} else if (command === "add") {
  const [title, body = ""] = args;
  if (!title) {
    throw new Error('Usage: npm start -- add "Title" "Body"');
  }
  const id = randomUUID();
  await database.put("notes", id, { id, title, body });
  console.log(JSON.stringify(await database.get("notes", id), null, 2));
} else if (command === "list") {
  console.log(JSON.stringify(await database.scan("notes"), null, 2));
} else if (command === "get") {
  const [id] = args;
  if (!id) {
    throw new Error("Usage: npm start -- get <id>");
  }
  console.log(JSON.stringify(await database.get("notes", id), null, 2));
} else {
  console.log(`
ThimbleDB local notes example

  npm run demo
  npm start -- add "Title" "Body"
  npm start -- list
  npm start -- get <id>
`);
}
