const copyLabel = "Copy";

for (const block of document.querySelectorAll<HTMLElement>(".prose pre")) {
  const code = block.querySelector("code");
  if (
    !code ||
    block.dataset.language === "mermaid" ||
    block.parentElement?.classList.contains("code-shell")
  ) {
    continue;
  }
  const shell = document.createElement("div");
  shell.className = "code-shell";
  block.before(shell);
  shell.append(block);

  const button = document.createElement("button");
  button.type = "button";
  button.className = "copy-code";
  button.textContent = copyLabel;
  button.setAttribute("aria-label", "Copy code to clipboard");
  button.addEventListener("click", async () => {
    await navigator.clipboard.writeText(code.textContent ?? "");
    button.textContent = "Copied";
    window.setTimeout(() => {
      button.textContent = copyLabel;
    }, 1_500);
  });
  shell.append(button);
}

document.addEventListener("keydown", (event) => {
  if (
    event.key !== "/" ||
    event.metaKey ||
    event.ctrlKey ||
    event.altKey ||
    isEditable(event.target)
  ) {
    return;
  }
  event.preventDefault();
  window.location.assign("/search/");
});

function isEditable(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}

export {};
