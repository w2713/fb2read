/**
 * Точка входа читалки в браузере.
 *
 * Пока умеет одно: открыть книгу с устройства и показать её. Библиотека,
 * позиция, закладки и синхронизация приезжают следующими этапами — но каркас
 * уже тот, в который они встанут: разбор в отдельном потоке, разметка чистой
 * функцией, показ здесь.
 */

import { renderBook } from "./render.js";
import type { ParseReply, ParsedBook, ParseRequest } from "./worker.js";

const start = document.querySelector<HTMLElement>("#start")!;
const article = document.querySelector<HTMLElement>("#book")!;
const input = document.querySelector<HTMLInputElement>("#file")!;

const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });

/** Разборы нумеруются: пока идёт один, читатель мог выбрать другую книгу. */
let ticket = 0;
const waiting = new Map<number, (reply: ParseReply) => void>();

worker.addEventListener("message", (event: MessageEvent<ParseReply>) => {
  waiting.get(event.data.id)?.(event.data);
  waiting.delete(event.data.id);
});

function parse(file: File): Promise<ParseReply> {
  const id = ++ticket;
  return new Promise((resolve) => {
    waiting.set(id, resolve);
    worker.postMessage({ id, file } satisfies ParseRequest);
  });
}

/** Показывает сообщение вместо книги: битый файл не должен ронять страницу. */
function showFailure(text: string): void {
  start.hidden = false;
  article.hidden = true;
  const box = document.createElement("p");
  box.className = "failure";
  box.textContent = text;
  start.querySelector(".failure")?.remove();
  start.append(box);
}

function show(book: ParsedBook): void {
  document.title = book.title ? `${book.title} — fb2read` : "fb2read";
  article.innerHTML = renderBook(book.blocks);
  article.hidden = false;
  start.hidden = true;
  window.scrollTo(0, 0);
}

async function open(file: File): Promise<void> {
  start.querySelector(".failure")?.remove();
  const reply = await parse(file);
  // Пока читали, могли выбрать другую книгу: показываем только последнюю.
  if (reply.id !== ticket) return;
  if (!reply.ok) {
    showFailure(`${file.name}: ${reply.error}`);
    return;
  }
  show(reply.book);
}

input.addEventListener("change", () => {
  const file = input.files?.[0];
  if (file) void open(file);
});

// Перетаскивание: на настольных машинах это самый короткий путь.
document.addEventListener("dragover", (event) => {
  event.preventDefault();
  document.body.classList.add("dragging");
});

document.addEventListener("dragleave", (event) => {
  if (event.relatedTarget === null) document.body.classList.remove("dragging");
});

document.addEventListener("drop", (event) => {
  event.preventDefault();
  document.body.classList.remove("dragging");
  const file = event.dataTransfer?.files?.[0];
  if (file) void open(file);
});
