/**
 * Точка входа читалки в браузере.
 *
 * Здесь и только здесь программа встречается с DOM: разметку строит чистая
 * функция, решения о позиции, закладках и порядке совпадений — тоже чистые, а
 * всё, что нельзя проверить без браузера, собрано в одном месте.
 *
 * Библиотека, офлайн и синхронизация приезжают следующими этапами.
 */

import {
  THEME_ORDER,
  bookmarksFileName,
  bookmarksMarkdown,
  findMatches,
  matchContext,
  normalize,
  plural,
  progressPercent,
  type Bookmark,
  type Match,
} from "@fb2read/core";
import { IdbStore, type BookMeta } from "./db.js";
import { firstFrom, step } from "./find.js";
import { marked, removeMark, sortedMarks, toggleMark } from "./marks.js";
import { keepPosition, topmost, type Keeper } from "./position.js";
import { renderBook, renderOne } from "./render.js";
import {
  exchange,
  fetchBook,
  forgetBook,
  guessDevice,
  syncSettings,
  type SyncSettings,
} from "./sync.js";
import { bookSize, shelfOrder, whenRead } from "./shelf.js";
import type { Ask, ParsedBook, Reply } from "./worker.js";

const start = document.querySelector<HTMLElement>("#start")!;
const article = document.querySelector<HTMLElement>("#book")!;
const input = document.querySelector<HTMLInputElement>("#file")!;
const bar = document.querySelector<HTMLElement>("#bar")!;
const top = document.querySelector<HTMLElement>("#top")!;
const panel = document.querySelector<HTMLElement>("#panel")!;
const tocPanel = document.querySelector<HTMLElement>("#toc")!;
const findPanel = document.querySelector<HTMLElement>("#find")!;
const marksPanel = document.querySelector<HTMLElement>("#marks")!;
const query = document.querySelector<HTMLInputElement>("#q")!;
const foundList = document.querySelector<HTMLElement>("#found")!;
const findCount = document.querySelector<HTMLElement>("#find-count")!;
const markList = document.querySelector<HTMLElement>("#mark-list")!;
const marksEmpty = document.querySelector<HTMLElement>("#marks-empty")!;
const markButton = document.querySelector<HTMLButtonElement>("#mark")!;
const backButton = document.querySelector<HTMLButtonElement>("#back")!;
const progressLabel = document.querySelector<HTMLElement>("#progress")!;
const shelf = document.querySelector<HTMLElement>("#shelf")!;
const greeting = document.querySelector<HTMLElement>("#greeting")!;
const storageLine = document.querySelector<HTMLElement>("#storage")!;
const installLine = document.querySelector<HTMLElement>("#install")!;
const updateLine = document.querySelector<HTMLElement>("#update")!;
const syncNow = document.querySelector<HTMLButtonElement>("#sync-now")!;
const syncSetup = document.querySelector<HTMLButtonElement>("#sync-setup")!;
const syncForm = document.querySelector<HTMLFormElement>("#sync-form")!;
const syncNote = document.querySelector<HTMLElement>("#sync-note")!;
const syncUrl = document.querySelector<HTMLInputElement>("#sync-url")!;
const syncToken = document.querySelector<HTMLInputElement>("#sync-token")!;
const syncDevice = document.querySelector<HTMLInputElement>("#sync-device")!;
const syncAuto = document.querySelector<HTMLInputElement>("#sync-auto")!;

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
    worker.postMessage({ ...request, id });
  });
}

// --- открытая книга --------------------------------------------------------

interface Open {
  book: ParsedBook;
  keeper: Keeper;
  /** Закладки вместе с надгробиями: снятые нужны синхронизации. */
  marks: Bookmark[];
  query: string;
  matches: Match[];
  /** Какое совпадение показано сейчас; -1 — ещё ни одного. */
  matchAt: number;
  /** Блок, в котором сейчас подсвечено найденное. */
  lit: number | null;
  /** Откуда ушли по сноске: чтобы было куда вернуться. */
  back: number[];
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
  showPanel(null);
  backButton.hidden = true;
}

// --- позиция ---------------------------------------------------------------

/**
 * Следит, какой блок наверху окна, и отдаёт его хранителю позиции.
 *
 * Запоминаются сами элементы, а не их положение: положение из `entry` — это
 * снимок того мгновения, когда абзац пересёк край, и для абзаца, оставшегося
 * на экране, оно больше не обновляется. Прокрутка на страницу как раз половину
 * абзацев на экране и оставляет — с запомненными числами читалка после неё
 * считала текущим абзац на экран ниже настоящего.
 */
function watchPosition(keeper: Keeper): void {
  const seen = new Map<number, Element>();
  watcher = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const block = Number((entry.target as HTMLElement).dataset["block"]);
        if (entry.isIntersecting) seen.set(block, entry.target);
        else seen.delete(block);
      }
      const now = topmost(
        [...seen]
          // Абзац могли перерисовать: у вынутого из страницы нет положения,
          // и ноль от него сошёл бы за верх экрана.
          .filter(([, node]) => node.isConnected)
          // Отсчёт идёт от низа панели, а не от верха окна: под панелью текста
          // не видно, и абзац, спрятанный за ней, читают уже не его.
          .map(([block, node]) => ({
            block,
            top: node.getBoundingClientRect().top - readingTop(),
          })),
      );
      if (now !== null) {
        keeper.moved(now);
        showProgress(now);
        showMarkState(now);
      }
    },
    // Наблюдатель только называет видимые абзацы, а их положение читалка
    // измеряет сама, поэтому запас по краям тут не нужен.
    { threshold: 0 },
  );
  for (const node of article.querySelectorAll("[data-block]")) watcher.observe(node);
}

/**
 * Где начинается место для чтения.
 *
 * Панель и раскрытый список прилипли к верху окна и накрывают собой текст.
 * Считать верхом окна ноль поэтому нельзя: абзац, к которому перешли, уезжал
 * под панель, и первая его строка пропадала — как раз та, ради которой
 * переходили.
 */
function readingTop(): number {
  return Math.max(top.getBoundingClientRect().bottom, 0);
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
  window.scrollBy(0, target.getBoundingClientRect().top - readingTop());
  open?.keeper.moved(block);
  showProgress(block);
  showMarkState(block);
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

// --- панели ----------------------------------------------------------------

const PANELS = { toc: tocPanel, find: findPanel, marks: marksPanel };

/**
 * Показывает одну панель и прячет прочие.
 *
 * Две сразу не нужны никогда, а на телефоне они и не поместятся: экран узкий,
 * и книгу за ними уже не видно.
 */
function showPanel(which: keyof typeof PANELS | null): void {
  for (const [name, node] of Object.entries(PANELS)) node.hidden = name !== which;
  panel.hidden = which === null;
  if (which === "find") query.focus();
}

function togglePanel(which: keyof typeof PANELS): void {
  showPanel(PANELS[which].hidden ? which : null);
}

// --- оглавление ------------------------------------------------------------

function fillToc(book: ParsedBook): void {
  tocPanel.innerHTML = "";
  const list = document.createElement("ul");
  for (const entry of book.toc) {
    const item = document.createElement("li");
    item.style.paddingLeft = `${Math.min(entry.level, 4)}rem`;
    const link = document.createElement("button");
    link.type = "button";
    link.textContent = entry.title;
    link.addEventListener("click", () => {
      // Сперва закрыть, потом переходить: раскрытый список занимает место на
      // странице, и переход, посчитанный при нём, промахнётся на его высоту.
      showPanel(null);
      goToBlock(entry.block);
    });
    item.append(link);
    list.append(item);
  }
  tocPanel.append(list);
}

// --- поиск -----------------------------------------------------------------

/** Сколько совпадений показывать списком. */
const FOUND_LIMIT = 200;

/** Снимает подсветку: найденное перестаёт быть найденным. */
function unlight(): void {
  if (!open || open.lit === null) return;
  const block = open.lit;
  open.lit = null;
  redrawBlock(block);
}

/**
 * Перерисовывает один блок.
 *
 * Собирать заново всю книгу ради подсветки одного слова — заметная задержка на
 * каждом переходе к следующему совпадению. Новый элемент надо снова отдать
 * наблюдателям: старый они потеряют вместе с разметкой.
 */
function redrawBlock(block: number, found?: { start: number; end: number }): void {
  if (!open) return;
  const node = article.querySelector<HTMLElement>(`[data-block="${block}"]`);
  const item = open.book.blocks[block];
  if (!node || !item) return;

  const holder = document.createElement("div");
  holder.innerHTML = renderOne(item, block, found);
  const fresh = holder.firstElementChild as HTMLElement | null;
  if (!fresh) return;
  if (marked(open.marks, block)) fresh.classList.add("marked");

  watcher?.unobserve(node);
  node.replaceWith(fresh);
  watcher?.observe(fresh);
  for (const img of fresh.querySelectorAll("img[data-src]")) images?.observe(img);
}

function runSearch(text: string): void {
  if (!open) return;
  unlight();
  open.query = text.trim();
  open.matchAt = -1;
  open.matches = open.query ? findMatches(open.book.blocks, open.query) : [];
  fillFound();
  if (!open.query) {
    findCount.textContent = "";
    return;
  }
  if (!open.matches.length) {
    findCount.textContent = `не найдено: ${open.query}`;
    return;
  }
  // Ближайшее совпадение вперёд, а не начало книги: читатель ищет то, что
  // впереди, куда чаще, чем то, что уже прочитал.
  goToMatch(firstFrom(open.matches, open.keeper.current()));
}

function goToMatch(index: number, wrapped = false): void {
  if (!open?.matches.length) return;
  unlight();
  open.matchAt = index;
  const match = open.matches[index]!;
  open.lit = match.block;
  redrawBlock(match.block, { start: match.offset, end: match.offset + open.query.length });
  // Счётчик печатается до перехода: он добавляет панели строку, а панель висит
  // над текстом — найденное уехало бы ровно под неё.
  findCount.textContent =
    `совпадение ${index + 1} из ${open.matches.length}` + (wrapped ? ", поиск с начала" : "");
  markFound();
  goToBlock(match.block);
}

function stepMatch(delta: number): void {
  if (!open) return;
  if (!open.matches.length) {
    findCount.textContent = open.query ? `не найдено: ${open.query}` : "";
    return;
  }
  const next = step(open.matchAt, delta, open.matches.length);
  goToMatch(next.index, next.wrapped);
}

/** Помечает в списке то совпадение, на котором стоим. */
function markFound(): void {
  foundList
    .querySelectorAll<HTMLElement>("li")
    .forEach((item, at) => item.classList.toggle("here", at === open?.matchAt));
}

function fillFound(): void {
  foundList.innerHTML = "";
  if (!open) return;
  for (const [at, match] of open.matches.slice(0, FOUND_LIMIT).entries()) {
    const item = document.createElement("li");
    const link = document.createElement("button");
    link.type = "button";
    link.textContent = matchContext(open.book.blocks[match.block]!, match.offset);
    link.addEventListener("click", () => goToMatch(at));
    item.append(link);
    foundList.append(item);
  }
  // Совпадений бывают тысячи: список во всю книгу никто не читает, а строить
  // его — заметная работа при каждом запросе.
  if (open.matches.length > FOUND_LIMIT) {
    const rest = document.createElement("li");
    rest.className = "note-line";
    rest.textContent = `…и ещё ${open.matches.length - FOUND_LIMIT}`;
    foundList.append(rest);
  }
}

// --- закладки --------------------------------------------------------------

/** Кнопка показывает, стоит ли закладка здесь, а не то, что она делает. */
function showMarkState(block: number): void {
  if (!open) return;
  const here = marked(open.marks, block);
  markButton.textContent = here ? "★" : "☆";
  markButton.title = here ? "Снять закладку" : "Поставить закладку";
  markButton.setAttribute("aria-pressed", String(here));
}

async function storeMarks(): Promise<void> {
  if (!open) return;
  await store.saveBookmarks(open.book.hash, open.marks, {
    title: open.book.title,
    author: open.book.author,
    total: open.book.blocks.length,
    hash: open.book.hash,
  });
}

async function toggleHere(): Promise<void> {
  if (!open) return;
  const block = open.keeper.current();
  open.marks = toggleMark(open.marks, block, open.book.blocks);
  paintMark(block);
  showMarkState(block);
  fillMarks();
  await storeMarks();
}

/** Отметка на самом абзаце: видно, что закладка именно здесь. */
function paintMark(block: number): void {
  const node = article.querySelector<HTMLElement>(`[data-block="${block}"]`);
  node?.classList.toggle("marked", marked(open?.marks ?? [], block));
}

function paintMarks(): void {
  for (const node of article.querySelectorAll(".marked")) node.classList.remove("marked");
  for (const mark of sortedMarks(open?.marks ?? [])) paintMark(mark.block);
}

function fillMarks(): void {
  markList.innerHTML = "";
  const marks = sortedMarks(open?.marks ?? []);
  marksEmpty.hidden = marks.length > 0;
  for (const mark of marks) {
    const item = document.createElement("li");

    const go = document.createElement("button");
    go.type = "button";
    go.className = "mark-go";
    go.textContent = `${mark.percent ?? 0}% — ${mark.name ?? `абзац ${mark.block}`}`;
    go.addEventListener("click", () => {
      showPanel(null);
      goToBlock(mark.block);
    });

    const drop = document.createElement("button");
    drop.type = "button";
    drop.className = "mark-drop";
    drop.title = "Снять закладку";
    drop.setAttribute("aria-label", `Снять закладку: ${mark.name ?? mark.block}`);
    drop.textContent = "✕";
    drop.addEventListener("click", () => {
      if (!open) return;
      open.marks = removeMark(open.marks, mark.block);
      paintMark(mark.block);
      showMarkState(open.keeper.current());
      fillMarks();
      void storeMarks();
    });

    item.append(go, drop);
    markList.append(item);
  }
}

/**
 * Выгрузка закладок в markdown — та же, что в терминале.
 *
 * Файл собирается на месте: отсылать книгу куда-то ради выписок незачем, да и
 * читалка должна работать без сети вовсе.
 */
function exportMarks(): void {
  if (!open) return;
  const text = bookmarksMarkdown(open.book, open.marks);
  const url = URL.createObjectURL(new Blob([text], { type: "text/markdown;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = bookmarksFileName(open.book.title);
  link.click();
  // Адрес отзывается не сразу: браузеру нужно время, чтобы начать скачивание.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// --- сноски ----------------------------------------------------------------

/**
 * Переход по сноске.
 *
 * Примечания в FB2 лежат отдельным телом книги, то есть теми же блоками в
 * конце. Значит, переход — это обычная прокрутка; неочевидно здесь только то,
 * что вернуться надо уметь обязательно: без возврата сноска выбрасывает
 * читателя из книги, и место он ищет сам.
 */
function followNote(target: string): void {
  if (!open) return;
  const destination = open.book.anchors[target];
  if (destination === undefined) return;
  open.back.push(open.keeper.current());
  backButton.hidden = false;
  goToBlock(destination);
}

function goBack(): void {
  const where = open?.back.pop();
  if (where === undefined) return;
  goToBlock(where);
  backButton.hidden = !open?.back.length;
}

// --- темы ------------------------------------------------------------------

async function applyTheme(theme: string): Promise<void> {
  // auto означает «как в системе»: тогда атрибута нет, и решают медиазапросы.
  if (theme === "auto") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", theme);
  paintStatusBar();
  await store.saveSettings({ theme });
}

/**
 * Красит полосу состояния под тему.
 *
 * С домашнего экрана читалка занимает весь экран, и белая полоса над ночной
 * темой выглядит как чужая деталь. Цвет берётся прямо из темы, а не из списка:
 * список разошёлся бы со стилями при первой же правке.
 */
function paintStatusBar(): void {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (!meta) return;
  const bg = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim();
  if (bg) meta.content = bg;
}

function nextTheme(current: string): string {
  const at = THEME_ORDER.indexOf(current as (typeof THEME_ORDER)[number]);
  return THEME_ORDER[(at + 1) % THEME_ORDER.length]!;
}

// --- полка -----------------------------------------------------------------

/**
 * Рисует список книг, оставшихся в браузере.
 *
 * Пока полка пуста, приглашение обычное; как только на ней что-то есть,
 * главным становится список, а выбор файла — способом добавить ещё одну.
 */
async function fillShelf(): Promise<void> {
  const { books, states } = await store.shelf();
  const entries = shelfOrder(books, states);
  shelf.innerHTML = "";
  greeting.textContent = entries.length
    ? "Ваши книги. Они остаются здесь и открываются без сети."
    : "Читалка книг FB2 и EPUB. Откройте книгу с устройства.";

  for (const entry of entries) {
    const item = document.createElement("li");

    const open = document.createElement("button");
    open.type = "button";
    open.className = "shelf-open";
    const name = document.createElement("span");
    name.className = "shelf-title";
    name.textContent = entry.title;
    const about = document.createElement("span");
    about.className = "shelf-about";
    // Процент читателю важнее размера, поэтому он идёт первым; ни разу не
    // открытая книга процента не имеет — у неё и места в книге ещё нет.
    about.textContent = [
      entry.percent === null ? "не открыта" : `${entry.percent}%`,
      entry.author,
      whenRead(entry.at),
      bookSize(entry.size),
    ]
      .filter(Boolean)
      .join(" · ");
    open.append(name, about);
    open.addEventListener("click", () => void openStored(entry.hash));

    const drop = document.createElement("button");
    drop.type = "button";
    drop.className = "shelf-drop";
    drop.title = "Убрать книгу";
    drop.setAttribute("aria-label", `Убрать книгу: ${entry.title}`);
    drop.textContent = "✕";
    drop.addEventListener("click", () => void dropBook(entry.hash));

    item.append(open, drop);
    shelf.append(item);
  }

  await fillDropped();
  await showStorage(books);
}

/**
 * Снятые книги — облаком, как в терминале.
 *
 * Иначе «убрать» значило бы «спрятать навсегда»: файла на устройстве уже нет,
 * а обмен книгу больше не вернёт. Строка строится по местной записи о месте —
 * она остаётся после снятия, — поэтому список рисуется и без сети.
 */
async function fillDropped(): Promise<void> {
  // Без сервера возвращать книгу неоткуда, и обещать это нечестно.
  if (!server) return;
  for (const hash of await store.dropped()) {
    const record = await store.record(hash);
    if (!record) continue;

    const item = document.createElement("li");
    item.className = "shelf-remote";

    const get = document.createElement("button");
    get.type = "button";
    get.className = "shelf-open";
    const name = document.createElement("span");
    name.className = "shelf-title";
    name.textContent = `☁ ${record.title || "книга"}`;
    const about = document.createElement("span");
    about.className = "shelf-about";
    about.textContent = [record.author, "на сервере"].filter(Boolean).join(" · ");
    get.append(name, about);
    get.addEventListener("click", () => void returnBook(hash));

    const forget = document.createElement("button");
    forget.type = "button";
    forget.className = "shelf-drop";
    forget.title = "Удалить с сервера";
    forget.setAttribute("aria-label", `Удалить с сервера: ${record.title || "книга"}`);
    forget.textContent = "✕";
    forget.addEventListener("click", () => void forgetOnServer(hash, record.title));

    item.append(get, forget);
    shelf.append(item);
  }
}

/** Возвращает снятую книгу с сервера и открывает её. */
async function returnBook(hash: string): Promise<void> {
  if (!server) return;
  syncNote.textContent = "забираю с сервера…";
  syncNote.textContent = await fetchBook(store, server, hash);
  await fillShelf();
  if (await store.bookMeta(hash)) await openStored(hash);
}

/** Удаляет книгу с сервера — по одному подтверждению, как всякую потерю. */
async function forgetOnServer(hash: string, title: string): Promise<void> {
  if (!server) return;
  const name = title || "эту книгу";
  // Книга исчезнет у всех устройств, поэтому спрашиваем. Убрать с полки —
  // дело обратимое и спроса не требует, а это нет.
  if (!window.confirm(`Удалить ${name} с сервера? Она исчезнет на всех устройствах.`)) return;
  syncNote.textContent = await forgetBook(store, server, hash);
  await fillShelf();
}

/**
 * Сколько места занято.
 *
 * Книги едят десятки мегабайт, и молчать об этом нечестно: место в браузере не
 * бесконечно, а расходуется оно без спроса.
 */
async function showStorage(books?: readonly BookMeta[]): Promise<void> {
  // Список обычно только что прочитан — читать его второй раз незачем.
  const shown = books ?? (await store.shelf()).books;
  if (!shown.length) {
    storageLine.textContent = "";
    return;
  }
  const taken = shown.reduce((sum, book) => sum + book.size, 0);
  let line = `На полке ${plural(shown.length, "книга", "книги", "книг")}, ${bookSize(taken)}.`;
  // Если браузер не обещал хранить книги, об этом надо сказать прямо: iOS
  // чистит хранилище сайта, куда неделю не заходили, и книги пропадут молча.
  if (!(await persisted()) && !standalone()) {
    line += " Браузер может удалить их, если долго не заходить;" +
      " добавьте читалку на домашний экран, чтобы этого не случилось.";
  }
  storageLine.textContent = line;
}

/**
 * Приглашение поставить читалку на домашний экран.
 *
 * Там, где браузер предлагает установку сам, показывается кнопка; на iPhone
 * такого предложения нет вовсе, поэтому остаётся сказать словами, каким путём
 * это делается. И то и другое незачем показывать тому, кто уже поставил.
 */
let ready: { prompt(): void } | null = null;

function showInstall(): void {
  if (standalone()) {
    installLine.hidden = true;
    return;
  }
  installLine.hidden = false;
  installLine.textContent = "";
  if (ready) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Установить читалку";
    button.addEventListener("click", () => ready?.prompt());
    installLine.append(button);
  } else {
    installLine.textContent =
      "Чтобы читать без браузера и без сети: «Поделиться» → «На экран „Домой“».";
  }
}

/** Открыта ли читалка как приложение, а не вкладкой. */
function standalone(): boolean {
  return (
    matchMedia("(display-mode: standalone)").matches ||
    (navigator as { standalone?: boolean }).standalone === true
  );
}

/** Обещал ли браузер хранить наши книги. */
async function persisted(): Promise<boolean> {
  try {
    // В Safari этого нет вовсе — там ответ всегда «не обещал», и это правда.
    return (await navigator.storage?.persisted?.()) ?? false;
  } catch {
    return false;
  }
}

/** Открывает книгу, лежащую на полке. */
async function openStored(hash: string): Promise<void> {
  const meta = await store.bookMeta(hash);
  const data = meta && (await store.bookFile(hash));
  if (!meta || !data) {
    showFailure("Книга пропала из хранилища — откройте файл заново.");
    await fillShelf();
    return;
  }
  await openBlob(data, meta.name);
}

async function dropBook(hash: string): Promise<void> {
  await store.dropBook(hash);
  await fillShelf();
}

/**
 * Кладёт прочитанную книгу на полку.
 *
 * Отпечаток считается при разборе, поэтому книга сохраняется после него — и
 * сохраняется тот же самый Blob, который уже держим: копировать нечего.
 */
async function keepBook(data: Blob, name: string, book: ParsedBook): Promise<void> {
  try {
    await store.putBook(
      {
        hash: book.hash,
        name,
        title: book.title,
        author: book.author,
        size: data.size,
        addedAt: Date.now() / 1000,
      },
      data,
    );
    // Просить о постоянном хранении есть смысл только когда есть что хранить.
    await navigator.storage?.persist?.().catch(() => false);
  } catch (e) {
    // Место кончилось — читать это не мешает, но молчать нельзя: читатель
    // должен знать, что завтра книги здесь не будет.
    const why = (e as Error).name === "QuotaExceededError"
      ? "в браузере кончилось место"
      : (e as Error).message;
    storageLine.textContent = `Книга открыта, но не сохранена: ${why}. Уберите с полки лишнее.`;
  }
}

// --- обмен с сервером ------------------------------------------------------

/** Настройки обмена, как они сейчас записаны; null — сервер не настроен. */
let server: SyncSettings | null = null;

async function loadSync(): Promise<void> {
  const settings = await store.loadSettings();
  server = syncSettings(settings);
  syncNow.hidden = server === null;
  syncSetup.textContent = server ? "Настроить…" : "Синхронизация…";
  syncUrl.value = server?.url ?? "";
  syncToken.value = server?.token ?? "";
  syncDevice.value = server?.device ?? guessDevice(navigator.userAgent);
  syncAuto.checked = server?.auto ?? true;
}

/**
 * Обмен по нажатию кнопки.
 *
 * Читатель нажал и ждёт, поэтому итог всегда словами — и когда получилось, и
 * когда нет. Полка перерисовывается: с сервера могли приехать книги.
 */
async function runSync(quiet = false): Promise<void> {
  if (!server) return;
  if (!quiet) {
    syncNote.textContent = "обмениваюсь…";
    syncNow.disabled = true;
  }
  const report = await exchange(store, server);
  syncNow.disabled = false;
  syncNote.textContent = report.text;
  await fillShelf();
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
  query.value = "";
  findCount.textContent = "";
  foundList.innerHTML = "";

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
  open = { book, keeper, marks: [], query: "", matches: [], matchAt: -1, lit: null, back: [] };

  open.marks = await store.loadBookmarks(book.hash);
  paintMarks();
  fillMarks();

  // Место читается до слежения: иначе первый же кадр перетёр бы его нулём.
  const saved = await store.loadPosition(book.hash);
  if (saved > 0) goToBlock(saved);
  else window.scrollTo(0, 0);
  showProgress(saved);
  showMarkState(saved);

  watchPosition(keeper);
  watchImages();
}

/**
 * Открывает книгу откуда угодно: из проводника или с полки.
 *
 * Разница только в том, откуда взялся Blob; всё остальное — разбор в потоке,
 * показ, сохранение на полку — одно и то же.
 */
async function openBlob(data: Blob, name: string): Promise<void> {
  start.querySelector(".failure")?.remove();
  await closeOpen();
  const reply = await ask({ kind: "parse", data, name });
  // Пока читали, могли выбрать другую книгу: показываем только последнюю.
  if (reply.id !== ticket) return;
  if (!reply.ok) {
    showFailure(`${name}: ${reply.error}`);
    return;
  }
  if (reply.kind !== "parse") return;
  await keepBook(data, name, reply.book);
  await show(reply.book);
}

function openFile(file: File): Promise<void> {
  return openBlob(file, file.name);
}

// --- события ---------------------------------------------------------------

input.addEventListener("change", () => {
  const file = input.files?.[0];
  // Поле сбрасывается, иначе выбор того же файла второй раз не считается
  // изменением и книга просто не откроется.
  input.value = "";
  if (file) void openFile(file);
});

document.querySelector("#toc-toggle")!.addEventListener("click", () => togglePanel("toc"));
document.querySelector("#find-toggle")!.addEventListener("click", () => togglePanel("find"));
document.querySelector("#marks-toggle")!.addEventListener("click", () => togglePanel("marks"));
document.querySelector("#marks-export")!.addEventListener("click", exportMarks);

syncNow.addEventListener("click", () => void runSync());

syncSetup.addEventListener("click", () => {
  syncForm.hidden = !syncForm.hidden;
  if (!syncForm.hidden) syncUrl.focus();
});

syncForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void store
    .saveSettings({
      syncUrl: syncUrl.value.trim(),
      // Токен лежит рядом с настройками, в хранилище этого браузера. Больше
      // ему деться некуда: сервер спрашивает его при каждом обмене.
      syncToken: syncToken.value.trim(),
      device: syncDevice.value.trim() || guessDevice(navigator.userAgent),
      syncAuto: syncAuto.checked,
    })
    .then(loadSync)
    .then(() => {
      syncForm.hidden = true;
      syncNote.textContent = server ? "сервер записан" : "адрес пуст — обмена не будет";
    });
});
document.querySelector("#find-next")!.addEventListener("click", () => stepMatch(1));
document.querySelector("#find-prev")!.addEventListener("click", () => stepMatch(-1));
markButton.addEventListener("click", () => void toggleHere());
backButton.addEventListener("click", goBack);

document.querySelector("#find-form")!.addEventListener("submit", (event) => {
  event.preventDefault();
  // Тот же запрос второй раз — это «дальше», а не «искать заново»: так ведёт
  // себя поиск везде, и терминальная читалка в том числе.
  if (open && open.query && normalize(query.value.trim()) === normalize(open.query)) stepMatch(1);
  else runSearch(query.value);
});

// Сноски ловятся на всём тексте разом: абзацев в книге десятки тысяч, и вешать
// на каждый свой обработчик — лишняя работа при каждом открытии книги.
article.addEventListener("click", (event) => {
  const link = (event.target as HTMLElement).closest<HTMLElement>("a.note");
  if (!link) return;
  event.preventDefault();
  followNote(link.dataset["note"] ?? "");
});

document.querySelector("#theme")!.addEventListener("click", () => {
  const current = document.documentElement.getAttribute("data-theme") ?? "auto";
  void applyTheme(nextTheme(current));
});

document.querySelector("#close")!.addEventListener("click", () => {
  // Экран переключается сразу, а место дописывается следом: ждать записи
  // читателю незачем, а задержка на телефоне читается как «не нажалось».
  article.hidden = true;
  bar.hidden = true;
  start.hidden = false;
  document.title = "fb2read";
  // Полка перерисовывается после записи: процент только что изменился, и
  // список должен показывать то же, что показывала книга.
  // Место только что записано — самое время отдать его серверу, если читатель
  // этого просил. Молча: он закрыл книгу, а не нажимал кнопку.
  void closeOpen()
    .then(() => fillShelf())
    .then(() => (server?.auto ? runSync(true) : undefined));
});

/**
 * Клавиши те же, что в терминале.
 *
 * На телефоне их нет, а за столом читают именно ими, и переучиваться ради
 * второй читалки той же программы никто не станет.
 */
document.addEventListener("keydown", (event) => {
  if (event.altKey || event.ctrlKey || event.metaKey) return;
  const inField = (event.target as HTMLElement).closest("input, textarea");
  if (event.key === "Escape") {
    if (inField) query.blur();
    showPanel(null);
    return;
  }
  if (inField || article.hidden) return;

  switch (event.key) {
    case "/":
      // Иначе браузер откроет собственный поиск по странице, а он ищет только
      // в показанном куске книги.
      event.preventDefault();
      showPanel("find");
      break;
    case "n":
      stepMatch(1);
      break;
    case "N":
      stepMatch(-1);
      break;
    case "M":
      void toggleHere();
      break;
    case "'":
      togglePanel("marks");
      break;
    case "t":
    case "o":
      togglePanel("toc");
      break;
    case "c":
      void applyTheme(nextTheme(document.documentElement.getAttribute("data-theme") ?? "auto"));
      break;
    case "Backspace":
      goBack();
      break;
    default:
      break;
  }
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

// Полка рисуется сразу: ради неё читалку и открывают во второй раз.
void fillShelf();
void loadSync();
paintStatusBar();
showInstall();

// Браузер сам сказал, что готов поставить читалку, — предлагаем кнопкой.
window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  ready = event as unknown as { prompt(): void };
  showInstall();
});

window.addEventListener("appinstalled", () => {
  ready = null;
  showInstall();
  void showStorage();
});

/**
 * Работник, который даёт читалке открываться без сети.
 *
 * Только в собранном виде: в `vite dev` он поселился бы навсегда и кормил бы
 * разработчика вчерашними файлами. `updateViaCache: "none"` — чтобы сам
 * `sw.js` не приезжал из кэша браузера: страницы Pages отдаются с большим
 * сроком хранения, и обновление ждали бы неделю.
 */
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  void navigator.serviceWorker
    .register(`${import.meta.env.BASE_URL}sw.js`, {
      scope: import.meta.env.BASE_URL,
      updateViaCache: "none",
    })
    .then(watchUpdate)
    .catch(() => {
      // Без работника читалка работает, просто требует сети.
    });
} else if (import.meta.env.DEV) {
  // Работник, оставшийся от прошлой сборки, кормил бы `vite dev` старьём.
  void navigator.serviceWorker?.getRegistrations().then((all) => {
    for (const one of all) void one.unregister();
  });
}

/** Показывает строку об обновлении, когда рядом ждёт новая сборка. */
function watchUpdate(reg: ServiceWorkerRegistration): void {
  // Перезагрузка бывает только по просьбе читателя.
  //
  // Событие смены работника приходит и при самой первой установке — работник
  // забирает страницу себе. Без этой отметки читалка перезагружала бы себя
  // прямо под читателем на первом же открытии книги.
  let asked = false;

  const offer = (worker: ServiceWorker | null): void => {
    // Первая установка — это не обновление: подменять нечего.
    if (!worker || !navigator.serviceWorker.controller) return;

    // Книга не открыта — обновляемся сами, не спрашивая.
    //
    // Спрашивать было плохой мыслью: строчка внизу первого экрана, под полкой
    // и подсказками, на телефоне попросту не попадается на глаза, и читалка
    // оставалась вчерашней. Спрашивать есть смысл только когда книга открыта:
    // подменять файлы посреди чтения нельзя.
    if (article.hidden) {
      asked = true;
      worker.postMessage("обновиться");
      return;
    }

    updateLine.hidden = false;
    updateLine.textContent = "Готово обновление читалки. ";
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Обновить";
    button.addEventListener("click", () => {
      asked = true;
      worker.postMessage("обновиться");
    });
    updateLine.append(button);
  };

  offer(reg.waiting);
  reg.addEventListener("updatefound", () => {
    const fresh = reg.installing;
    fresh?.addEventListener("statechange", () => {
      if (fresh.state === "installed") offer(reg.waiting ?? fresh);
    });
  });

  let reloading = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    // Перезагрузка ровно одна: событие приходит и по второму разу.
    if (!asked || reloading) return;
    reloading = true;
    location.reload();
  });
}
