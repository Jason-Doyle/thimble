type SearchEntry = {
  title: string;
  description: string;
  href: string;
  group: string;
  text: string;
};

const page = document.querySelector<HTMLElement>("[data-search-page]");
const form = document.querySelector<HTMLFormElement>("[data-search-form]");
const input = document.querySelector<HTMLInputElement>("[data-search-input]");
const statusElement = document.querySelector<HTMLElement>("[data-search-status]");
const results = document.querySelector<HTMLElement>("[data-search-results]");

if (page && form && input && statusElement && results) {
  let index: SearchEntry[] = [];

  const loadIndex = async () => {
    if (index.length === 0) {
      const response = await fetch("/search-index.json");
      if (!response.ok) {
        throw new Error("Search index could not be loaded.");
      }
      index = (await response.json()) as SearchEntry[];
    }
    return index;
  };

  const search = async (query: string) => {
    const normalized = query.trim().toLowerCase();
    const url = new URL(window.location.href);
    if (normalized) {
      url.searchParams.set("q", query.trim());
    } else {
      url.searchParams.delete("q");
    }
    window.history.replaceState({}, "", url);
    results.replaceChildren();

    if (normalized.length < 2) {
      statusElement.textContent = "Enter at least two characters.";
      return;
    }

    statusElement.textContent = "Searching…";
    try {
      const terms = normalized.split(/\s+/).filter(Boolean);
      const matches = (await loadIndex())
        .map((entry) => ({
          entry,
          score: score(entry, terms),
        }))
        .filter((match) => match.score > 0)
        .sort((left, right) => right.score - left.score)
        .slice(0, 20);

      statusElement.textContent =
        matches.length === 1
          ? "1 result"
          : `${matches.length} results`;

      for (const match of matches) {
        results.append(renderResult(match.entry));
      }
    } catch {
      statusElement.textContent =
        "Search is unavailable. Browse the documentation directory instead.";
    }
  };

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void search(input.value);
  });

  const initialQuery = new URLSearchParams(window.location.search).get("q");
  if (initialQuery) {
    input.value = initialQuery;
    void search(initialQuery);
  } else {
    statusElement.textContent =
      "Enter a topic, provider, feature, or limitation.";
  }

  input.focus();
}

function score(entry: SearchEntry, terms: string[]): number {
  const title = entry.title.toLowerCase();
  const description = entry.description.toLowerCase();
  const text = entry.text.toLowerCase();
  let total = 0;
  for (const term of terms) {
    if (!title.includes(term) && !description.includes(term) && !text.includes(term)) {
      return 0;
    }
    if (title.includes(term)) {
      total += 12;
    }
    if (description.includes(term)) {
      total += 5;
    }
    total += Math.min(text.split(term).length - 1, 5);
  }
  return total;
}

function renderResult(entry: SearchEntry): HTMLElement {
  const link = document.createElement("a");
  link.className = "search-result";
  link.href = entry.href;

  const group = document.createElement("span");
  group.className = "card-label";
  group.textContent = entry.group;

  const title = document.createElement("strong");
  title.textContent = entry.title;

  const description = document.createElement("span");
  description.textContent = entry.description;

  link.append(group, title, description);
  return link;
}

export {};
