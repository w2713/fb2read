/**
 * Точка входа читалки в браузере.
 *
 * Здесь и только здесь программа встречается с DOM: разметку строит чистая
 * функция, решения о позиции — тоже чистые, а всё, что нельзя проверить без
 * браузера, собрано в одном месте.
 *
 * Библиотека, поиск, закладки и синхронизация приезжают следующими этапами.
 */

import { THEME_ORDER, progressPercent } from "@fb2read/core";
import { IdbStore } from "./db.js";
import { keepPosition, topmost, type Keeper } from "./position.js";
import { renderBook } from "./render.js";
import type { Ask, ParsedBook, Reply, Request } from "./worker.js";

const start = document.querySelector<HTMLElement>("#start")!;
const article = document.querySelector<HTMLElement>("#book")!;
const input = document.querySelector<HTMLInputElement>("#file")!;
const bar = document.querySelector<HTMLElement>("#bar")!;
const tocPanel = document.querySelector<HTMLElement>("#toc")!;
const progressLabel = document.querySelector<HTMLElement>("#progress")!;

const store = new IdbStore();
const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });

/** Разборы нумеруются: пока идёт один, читатель мог выбрать другую книгу. */
let ticket = 0;
const waiting = new Map<number, (reply: Reply) => void>();

worker.addEventListener("message", (event: MessageEvent<Reply>) => {
  waiting.get(event.data.id)?.(event.data);
  waiting.delete(event.data.id);
});

/** Спрашивает поток и ждёт именно свой ответ. */
function ask(request: Ask): Promise<Reply> {
  const id = ++ticket;
  return new Promise((resolve) => {
    waiting.set(id, resolve);
    worker.postMessage({ ...request, id } as Request);
  });
}

// --- открытая книга --------------------------------------------------------

interface Open {
  book: ParsedBook;
  keeper: Keeper;
}

let open: Open | null = null;
let watcher: IntersectionObserver | null = null;
let images: IntersectionObserver | null = null;
/** Показанные картинки: адреса нужно отзывать, иначе память течёт. */
const shown = new Map<string, string>();

/** Закрывает предыдущую книгу: наблюдатели и адреса не должны накапливаться. */
async function closeOpen(): Promise<void> {
  watcher?.disconnect();
  images?.disconnect();
  watcher = images = null;
  for (const url of shown.values()) URL.revokeObjectURL(url);
  shown.clear();
  if (open) {
    await open.keeper.flush();
    open.keeper.stop();
    open = null;
  }
}

// --- позиция ---------------------------------------------------------------

/** Следит, какой блок наверху окна, и отдаёт его хранителю позиции. */
function watchPosition(keeper: Keeper): void {
  const seen = new Map<number, number>();
  watcher = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const block = Number((entry.target as HTMLElement).dataset["block"]);
        if (entry.isIntersecting) seen.set(block, entry.boundingClientRect.top);
        else seen.delete(block);
      }
      const now = topmost([...seen].map(([block, top]) => ({ block, top })));
      if (now !== null) {
        keeper.moved(now);
        showProgress(now);
      }
    },
    // Небольшой запас сверху: иначе абзац считается ушедшим ровно на границе,
    // и позиция дёргается туда-сюда от каждого пикселя прокрутки.
    { rootMargin: "-8px 0px 0px 0px", threshold: 0 },
  );
  for (const node of article.querySelectorAll("[data-block]")) watcher.observe(node);
}

function showProgress(block: number): void {
  const total = open?.book.blocks.length ?? 0;
  const percent = progressPercent(block, total);
  progressLabel.textContent = percent === null ? "" : `${percent}%`;
}

/** Прокручивает к блоку. Именно к нему, а не примерно туда. */
function goToBlock(block: number): void {
  const target = article.querySelector<HTMLElement>(`[data-block="${block}"]`);
  if (!target) return;
  target.scrollIntoView({ block: "start" });
}

// --- картинки --------------------------------------------------------------

/**
 * Подставляет картинки по мере появления в окне.
 *
 * Разворачивать все сразу нельзя: книга с иллюстрациями заняла бы десятки
 * мегабайт памяти ещё до того, как читатель дошёл до первой.
 */
function watchImages(): void {
  images = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const img = entry.target as HTMLImageElement;
      const src = img.dataset["src"];
      images?.unobserve(img);
      if (!src || img.src) continue;
      void showImage(img, src);
    }
  });
  for (const img of article.querySelectorAll("img[data-src]")) images.observe(img);
}

/** Просит картинку у потока и подставляет её. */
async function showImage(img: HTMLImageElement, src: string): Promise<void> {
  const reply = await ask({ kind: "image", src });
  // Картинка не прочиталась — книга от этого читаться не перестаёт.
  if (!reply.ok || reply.kind !== "image" || !reply.image) return;
  const url = URL.createObjectURL(reply.image);
  shown.set(src, url);
  img.src = url;
}

// --- оглавление ------------------------------------------------------------

function fillToc(book: ParsedBook): void {
  tocPanel.innerHTML = "";
  if (!book.toc.length) {
    tocPanel.hidden = true;
    return;
  }
  const list = document.createElement("ul");
  for (const entry of book.toc) {
    const item = document.createElement("li");
    item.style.paddingLeft = `${Math.min(entry.level, 4)}rem`;
    const link = document.createElement("button");
    link.type = "button";
    link.textContent = entry.title;
    link.addEventListener("click", () => {
      goToBlock(entry.block);
      tocPanel.hidden = true;
    });
    item.append(link);
    list.append(item);
  }
  tocPanel.append(list);
}

// --- темы ------------------------------------------------------------------

async function applyTheme(theme: string): Promise<void> {
  // auto означает «как в системе»: тогда атрибута нет, и решают медиазапросы.
  if (theme === "auto") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", theme);
  await store.saveSettings({ theme });
}

function nextTheme(current: string): string {
  const at = THEME_ORDER.indexOf(current as (typeof THEME_ORDER)[number]);
  return THEME_ORDER[(at + 1) % THEME_ORDER.length]!;
}

// --- показ книги -----------------------------------------------------------

function showFailure(text: string): void {
  start.hidden = false;
  article.hidden = true;
  bar.hidden = true;
  const box = document.createElement("p");
  box.className = "failure";
  box.textContent = text;
  start.querySelector(".failure")?.remove();
  start.append(box);
}

async function show(book: ParsedBook): Promise<void> {
  document.title = book.title ? `${book.title} — fb2read` : "fb2read";
  article.innerHTML = renderBook(book.blocks);
  article.hidden = false;
  start.hidden = true;
  bar.hidden = false;
  fillToc(book);

  const keeper = keepPosition({
    store,
    key: book.hash,
    meta: {
      title: book.title,
      author: book.author,
      total: book.blocks.length,
      path: "",
      hash: book.hash,
    },
  });
  open = { book, keeper };

  // Место читается до слежения: иначе первый же кадр перетёр бы его нулём.
  const saved = await store.loadPosition(book.hash);
  if (saved > 0) goToBlock(saved);
  else window.scrollTo(0, 0);
  showProgress(saved);

  watchPosition(keeper);
  watchImages();
}

async function openFile(file: File): Promise<void> {
  start.querySelector(".failure")?.remove();
  await closeOpen();
  const reply = await ask({ kind: "parse", file });
  // Пока читали, могли выбрать другую книгу: показываем только последнюю.
  if (reply.id !== ticket) return;
  if (!reply.ok) {
    showFailure(`${file.name}: ${reply.error}`);
    return;
  }
  if (reply.kind !== "parse") return;
  await show(reply.book);
}

// --- события ---------------------------------------------------------------

input.addEventListener("change", () => {
  const file = input.files?.[0];
  if (file) void openFile(file);
});

document.querySelector("#toc-toggle")!.addEventListener("click", () => {
  tocPanel.hidden = !tocPanel.hidden;
});

document.querySelector("#theme")!.addEventListener("click", () => {
  const current = document.documentElement.getAttribute("data-theme") ?? "auto";
  void applyTheme(nextTheme(current));
});

document.querySelector("#close")!.addEventListener("click", () => {
  void closeOpen().then(() => {
    article.hidden = true;
    bar.hidden = true;
    tocPanel.hidden = true;
    start.hidden = false;
    document.title = "fb2read";
  });
});

/**
 * Уход со страницы: записываем место немедленно.
 *
 * Именно visibilitychange, а не beforeunload: на iOS второе не срабатывает
 * при закрытии вкладки, и место терялось бы каждый раз.
 */
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") void open?.keeper.flush();
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
  if (file) void openFile(file);
});

// Тема запомнена с прошлого раза — применяем до первой отрисовки книги.
void store.loadSettings().then((settings) => {
  const theme = typeof settings.theme === "string" ? settings.theme : "auto";
  if (theme !== "auto") document.documentElement.setAttribute("data-theme", theme);
});
