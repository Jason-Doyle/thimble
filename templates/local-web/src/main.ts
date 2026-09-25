import {
  createThimbleClient,
  defineCollection,
  defineIndex,
} from "thimbledb";
import "./styles.css";

type Note = {
  id: string;
  title: string;
  body: string;
  lastModified: number;
};

const noteSchema = {
  parse(value: unknown): Note {
    if (
      typeof value !== "object" ||
      value === null ||
      !("id" in value) ||
      typeof value.id !== "string" ||
      !("title" in value) ||
      typeof value.title !== "string" ||
      !("body" in value) ||
      typeof value.body !== "string" ||
      !("lastModified" in value) ||
      typeof value.lastModified !== "number"
    ) {
      throw new Error("Invalid note");
    }
    return value as Note;
  },
};

type NoteSummary = Pick<
  Note,
  "id" | "title" | "lastModified"
>;

const noteSummarySchema = {
  parse(value: unknown): NoteSummary {
    if (
      typeof value !== "object" ||
      value === null ||
      !("id" in value) ||
      typeof value.id !== "string" ||
      !("title" in value) ||
      typeof value.title !== "string" ||
      !("lastModified" in value) ||
      typeof value.lastModified !== "number"
    ) {
      throw new Error("Invalid note summary");
    }
    return value as NoteSummary;
  },
};

const noteDefinition = defineCollection("notes", noteSchema, {
  indexes: [
    defineIndex<Note>(
      "by-title",
      ["title"],
      "equality",
      { include: ["lastModified"] },
    ),
    defineIndex<Note>(
      "by-last-modified",
      ["lastModified"],
      "range",
    ),
  ],
});

const status = element<HTMLParagraphElement>("status");
await ensureDevelopmentSession().catch((error) => {
  showError(error);
  throw error;
});
const client = await createThimbleClient();
const notes = client.collection(noteDefinition);
let lastDeletedId: string | null = null;

const form = element<HTMLFormElement>("note-form");
const notesOutput = element<HTMLElement>("notes");
const restorePanel = element<HTMLElement>("restore");

form.addEventListener("submit", (event) =>
  runAction(async () => {
    event.preventDefault();
    const title = element<HTMLInputElement>("title").value.trim();
    const body = element<HTMLTextAreaElement>("body").value.trim();
    if (!title) {
      return;
    }
    const id = crypto.randomUUID();
    await notes.put({
      id,
      title,
      body,
      lastModified: Date.now(),
    });
    form.reset();
    await renderAll();
  }),
);

element<HTMLButtonElement>("filter").addEventListener(
  "click",
  () =>
    runAction(async () => {
      const title =
        element<HTMLInputElement>("title-filter").value.trim();
      if (!title) {
        await renderAll();
        return;
      }
      const result = await notes
        .where((note) => note.title.eq(title))
        .orderBy((note) => note.lastModified.desc())
        .take(50)
        .select(
          ["title", "lastModified"],
          noteSummarySchema,
        )
        .get();
      status.textContent =
        `${result.documents.length} notes via ${result.plan}` +
        (result.indexName ? ` ${result.indexName}` : "");
      renderNotes(result.documents);
    }),
);

element<HTMLButtonElement>("show-all").addEventListener(
  "click",
  () => runAction(renderAll),
);

element<HTMLButtonElement>("restore-button").addEventListener(
  "click",
  () =>
    runAction(async () => {
      if (!lastDeletedId) {
        return;
      }
      await notes.restore(lastDeletedId);
      lastDeletedId = null;
      restorePanel.hidden = true;
      await renderAll();
    }),
);

await renderAll();

async function renderAll() {
  const result = await notes
    .orderBy((note) => note.lastModified.desc())
    .take(100)
    .get();
  status.textContent =
    `${result.documents.length} notes via ${result.plan}` +
    (result.indexName ? ` ${result.indexName}` : "");
  renderNotes(result.documents);
}

function renderNotes(
  items: Array<
    Note | NoteSummary
  >,
) {
  notesOutput.replaceChildren(
    ...items.map((note) => {
      const article = document.createElement("article");
      const title = document.createElement("h2");
      title.textContent = note.title;
      const body = document.createElement("p");
      body.textContent =
        "body" in note
          ? note.body || "No body"
          : "Use Show all to load the note body.";
      const metadata = document.createElement("small");
      metadata.textContent = new Date(
        note.lastModified,
      ).toLocaleString();
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "danger";
      remove.textContent = "Delete";
      remove.addEventListener("click", () =>
        runAction(async () => {
          await notes.delete(note.id);
          lastDeletedId = note.id;
          restorePanel.hidden = false;
          await renderAll();
        }),
      );
      article.append(title, body, metadata, remove);
      return article;
    }),
  );
}

async function ensureDevelopmentSession() {
  const existing = await fetch("/api/config", {
    credentials: "same-origin",
  });
  if (existing.ok) {
    return;
  }
  if (existing.status !== 401) {
    throw new Error(
      `Authority configuration failed with ${existing.status}`,
    );
  }
  const response = await fetch("/api/auth/dev/session", {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "content-type": "application/json",
    },
    body: "{}",
  });
  if (!response.ok) {
    throw new Error(
      `Development sign in failed with ${response.status}`,
    );
  }
}

function runAction(operation: () => Promise<void>): void {
  void operation().catch(showError);
}

function showError(error: unknown): void {
  status.textContent =
    error instanceof Error ? error.message : String(error);
}

function element<T extends HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (!value) {
    throw new Error(`Missing element: ${id}`);
  }
  return value as T;
}
