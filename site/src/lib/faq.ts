export type FaqItem = {
  question: string;
  answer: string;
};

export function parseFaqMarkdown(markdown: string): FaqItem[] {
  const items: FaqItem[] = [];
  let question = "";
  let answer: string[] = [];

  const flush = () => {
    if (!question) {
      return;
    }
    items.push({
      question,
      answer: plainText(answer.join("\n")),
    });
  };

  for (const line of markdown.split(/\r?\n/)) {
    if (line.startsWith("## ")) {
      flush();
      question = line.slice(3).trim();
      answer = [];
      continue;
    }
    if (question) {
      answer.push(line);
    }
  }
  flush();
  return items;
}

export function plainText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_>#-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
