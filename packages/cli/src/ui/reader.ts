/**
 * Чтение книги на экране.
 *
 * В отличие от версии на curses, здесь нет вложенных циклов событий: читалка
 * — машина состояний, и каждое событие обрабатывается снаружи. Поэтому её
 * можно прогнать в тестах целиком, не поднимая псевдотерминал, и позже
 * перенести в браузер, где вложенный цикл невозможен вовсе.
 */

import {
  buildKeymap,
  bookmarkLabel,
  cutToWidth,
  findMatches,
  helpRows,
  layout,
  matchContext,
  normalize,
  progressPercent,
  strWidth,
  type Block,
  type Bookmark,
  type Book,
  type Line,
  type Match,
} from "@fb2read/core";
import type { MouseEvent } from "../term/input.js";
import type { Screen } from "../term/screen.js";
import { Popup, type PopupResult } from "./popup.js";
import { Prompt } from "./prompt.js";
import { Theme, emphasisAttr } from "./theme.js";

const THEME_ORDER = ["auto", "night", "sepia", "day"];

/** Ширина «корешка» между страницами разворота. */
const GUTTER = 5;

/** Уже этого вторая колонка не имеет смысла. */
const MIN_COL = 28;

/** Место на экране, по которому можно щёлкнуть. */
interface Hotspot {
  row: number;
  left: number;
  right: number;
  kind: "note" | "image";
  target: string;
}

export interface ReaderOptions {
  book: Book;
  width: number;
  startBlock: number;
  theme: string;
  spacing: number;
  columns: number;
  mouse: boolean;
  keys?: Record<string, string>;
  bookmarks?: Bookmark[];
  path?: string;
  /**
   * Что сказать в строке состояния сразу при открытии.
   *
   * Сюда попадает итог синхронизации: она случается до того, как книга
   * показана, и её сообщению больше негде появиться — на экран, который
   * тут же сменится, писать бессмысленно.
   */
  notice?: string;
  /** Выключен ли показ картинок: об этом надо сказать до выбора, а не после. */
  imagesOff?: boolean;
  /** Показ картинки: слой терминала знает, каким протоколом рисовать. */
  showImage?: (block: Block) => Promise<string>;
  /**
   * Просьба перерисовать экран.
   *
   * Нужна там, где читалка меняет вид не в ответ на нажатие: показ картинки
   * заканчивается когда-то потом, и сеанс сам об этом не узнает.
   */
  requestPaint?: () => void;
  /** Сохранение закладок наружу. */
  saveBookmarks?: (marks: Bookmark[]) => void;
  /**
   * Синхронизация этой книги по требованию читателя.
   *
   * Возвращает готовую к показу строку — и когда получилось, и когда нет.
   * Сеть здесь же, где и всё остальное платформенное: читалка о ней не знает.
   */
  syncNow?: (
    block: number,
    bookmarks: Bookmark[],
  ) => Promise<{ text: string; bookmarks?: Bookmark[] }>;
  /** Версия читалки: показывается в заголовке справки и в сведениях. */
  version?: string;
  /**
   * Выгрузка закладок в файл.
   *
   * Текст готовит ядро, а куда его положить, знает только платформа, —
   * поэтому запись остаётся снаружи и возвращает сообщение читателю.
   */
  exportBookmarks?: (marks: Bookmark[]) => string;
}

export class Reader {
  readonly book: Book;
  theme: Theme;
  spacing: number;
  columns: number;
  mouse: boolean;
  maxWidth: number;
  top = 0;
  message = "";
  bookmarks: Bookmark[];

  private lines: Line[] = [];
  private width: number;
  private margin = 0;
  private effColumns = 1;
  private cache = new Map<string, Line[]>();
  private keymap: Record<string, string>;
  private bindings: Record<string, string[]>;
  private hotspots: Hotspot[] = [];
  private jumpStack: number[] = [];
  private query = "";
  private matches: Match[] = [];
  private matchIndex = -1;
  private popup: Popup | null = null;
  private prompt: Prompt | null = null;
  private markedBlocks = new Set<number>();
  private screenRows = 24;
  private screenColumns = 80;
  private finished = false;

  constructor(private readonly options: ReaderOptions) {
    this.book = options.book;
    this.maxWidth = options.width;
    this.width = options.width;
    this.spacing = Math.min(Math.max(options.spacing, 1), 3);
    this.columns = options.columns === 2 ? 2 : 1;
    this.mouse = options.mouse;
    this.theme = new Theme(THEME_ORDER.includes(options.theme) ? options.theme : "auto");
    this.bookmarks = options.bookmarks ?? [];
    this.markedBlocks = new Set(this.liveMarks.map((m) => m.block));
    const built = buildKeymap(options.keys ?? {});
    this.keymap = built.keymap;
    this.bindings = built.bindings;
    // Правки в файле важнее: о них читатель должен узнать в любом случае,
    // а итог синхронизации подождёт следующего нажатия.
    this.message = this.book.repairs.length
      ? "файл открыт с исправлениями, подробности по i"
      : (options.notice ?? "");
    this.top = 0;
    this.pendingStart = options.startBlock;
  }

  private pendingStart: number;

  /** Закончил ли читатель работу с книгой. */
  get done(): boolean {
    return this.finished;
  }

  /** Высота одной страницы в строках. */
  private get height(): number {
    return Math.max(this.screenRows - 2, 1);
  }

  /** Сколько строк книги видно целиком: обе страницы разворота. */
  private get visible(): number {
    return this.height * this.effColumns;
  }

  /** Шаг перелистывания: страница с нахлёстом, разворот — целиком. */
  private get pageStep(): number {
    return this.effColumns === 1 ? this.visible - 1 : this.visible;
  }

  private columnX(column: number): number {
    return this.margin + column * (this.width + GUTTER);
  }

  /** Номер блока, с которого начинается видимая часть. */
  currentBlock(): number {
    if (!this.lines.length) return 0;
    return this.lines[Math.min(this.top, this.lines.length - 1)]!.block;
  }

  /** Пересчитывает вёрстку под размер окна. */
  relayout(keepBlock?: number): void {
    const cols = this.screenColumns;
    const room = cols >= 2 * MIN_COL + GUTTER + 2;
    this.effColumns = this.columns === 2 && room ? 2 : 1;
    if (this.effColumns === 2) {
      this.width = Math.max(
        Math.min(this.maxWidth, Math.floor((cols - GUTTER - 4) / 2)),
        MIN_COL,
      );
      const spread = this.width * 2 + GUTTER;
      this.margin = Math.max(Math.floor((cols - spread) / 2), 0);
    } else {
      this.width = Math.max(Math.min(this.maxWidth, cols - 4), 20);
      this.margin = Math.max(Math.floor((cols - this.width) / 2), 0);
    }

    const key = `${this.width}:${this.spacing}`;
    let cached = this.cache.get(key);
    if (!cached) {
      cached = layout(this.book.blocks, this.width, this.spacing);
      // Держим только свежие раскладки: книга на сотню тысяч строк в шести
      // экземплярах — это уже заметная память.
      if (this.cache.size >= 6) this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(key, cached);
    }
    this.lines = cached;
    if (keepBlock !== undefined) this.goToBlock(keepBlock);
    this.clamp();
  }

  private clamp(): void {
    this.top = Math.max(0, Math.min(this.top, Math.max(this.lines.length - this.visible, 0)));
  }

  /** Ставит начало экрана на первую строку блока. */
  goToBlock(block: number): void {
    const found = this.lines.findIndex((line) => line.block >= block);
    this.top = found === -1 ? Math.max(this.lines.length - this.height, 0) : found;
    this.clamp();
  }

  /** Сообщает читалке новый размер окна. */
  setSize(rows: number, columns: number): void {
    const first = this.screenRows === 24 && this.screenColumns === 80 && !this.lines.length;
    const keep = this.lines.length ? this.currentBlock() : this.pendingStart;
    this.screenRows = rows;
    this.screenColumns = columns;
    this.relayout(first ? this.pendingStart : keep);
    if (first && this.columns === 2 && this.effColumns === 1) {
      this.message = "для разворота нужно окно шире — пока одна колонка";
    }
  }

  // --- отрисовка --------------------------------------------------------

  draw(screen: Screen): void {
    screen.setBackground(this.theme.background);
    screen.erase();
    this.hotspots = [];
    const rows = screen.rows;
    const cols = screen.columns;

    this.drawHeader(screen, cols);

    for (let column = 0; column < this.effColumns; column++) {
      const x0 = this.columnX(column);
      const start = this.top + column * this.height;
      for (let row = 0; row < this.height; row++) {
        const index = start + row;
        if (index >= this.lines.length) break;
        this.drawLine(screen, this.lines[index]!, row + 1, x0, cols);
      }
    }

    if (this.effColumns === 2) {
      const x = this.margin + this.width + Math.floor(GUTTER / 2);
      if (x >= 0 && x < cols - 1) {
        for (let row = 1; row < rows - 1; row++) {
          screen.put(row, x, "│", this.theme.attr("dim", { dim: true }));
        }
      }
    }

    const status = this.message || "?  — справка,  t — оглавление,  q — выход";
    screen.put(
      rows - 1,
      0,
      cutToWidth(status, Math.max(cols - 1, 1)),
      this.theme.attr("dim", { dim: true }),
    );

    this.popup?.draw(screen, this.theme);
    this.prompt?.draw(screen, this.theme);
  }

  private drawHeader(screen: Screen, cols: number): void {
    let head = this.book.title;
    if (this.book.author) head = `${this.book.author} — ${head}`;
    const percent =
      this.lines.length > this.visible
        ? Math.floor((100 * this.top) / (this.lines.length - this.visible))
        : this.lines.length
          ? 100
          : 0;
    const right = ` ${String(percent).padStart(3)}% `;
    head = cutToWidth(head, Math.max(cols - right.length - 1, 0));
    const bar = head + " ".repeat(Math.max(cols - right.length - strWidth(head), 0)) + right;
    screen.fillRow(0, this.theme.header);
    screen.put(0, 0, bar, this.theme.header, Math.max(cols - 1, 1));
  }

  private drawLine(screen: Screen, line: Line, row: number, x0: number, cols: number): void {
    if (!line.text) return;
    const room = Math.max(cols - x0 - 1, 0);
    const base = this.theme.lineAttr(line.attr);
    screen.put(row, x0, cutToWidth(line.text, room), base, room);

    for (const [column, fragment, kind] of line.styles) {
      const x = x0 + column;
      if (x >= 0 && x < cols - 1) {
        screen.put(row, x, cutToWidth(fragment, cols - x - 1), emphasisAttr(base, kind));
      }
    }

    this.markRefs(screen, row, x0, line.text, line.block, cols);
    this.markQuery(screen, row, x0, line.text, cols);

    if (this.markedBlocks.has(line.block) && x0 >= 2) {
      screen.put(row, x0 - 2, "▌", this.theme.attr("dim", { dim: true }));
    }

    const block = this.book.blocks[line.block]!;
    if (block.kind === "image" && block.src) {
      this.hotspots.push({
        row,
        left: x0,
        right: x0 + strWidth(line.text),
        kind: "image",
        target: block.src,
      });
    }
  }

  /** Подсвечивает то, что сейчас ищут. */
  private markQuery(screen: Screen, row: number, x0: number, text: string, cols: number): void {
    if (!this.query || !this.matches.length) return;
    const needle = normalize(this.query);
    const hay = normalize(text);
    let at = hay.indexOf(needle);
    while (at >= 0) {
      const x = x0 + strWidth(text.slice(0, at));
      const fragment = text.slice(at, at + needle.length);
      if (x >= 0 && x < cols - 1) {
        screen.put(row, x, cutToWidth(fragment, cols - x - 1), this.theme.match);
      }
      at = hay.indexOf(needle, at + needle.length);
    }
  }

  /** Подсвечивает маркеры сносок и запоминает, куда по ним щёлкать. */
  private markRefs(
    screen: Screen,
    row: number,
    x0: number,
    text: string,
    block: number,
    cols: number,
  ): void {
    const refs = this.book.blocks[block]!.refs;
    if (!refs.length) return;
    for (const [marker, target] of refs) {
      if (!(target in this.book.anchors)) continue;
      let pos = text.indexOf(marker);
      while (pos >= 0) {
        const x = x0 + strWidth(text.slice(0, pos));
        if (x >= 0 && x < cols - 1) {
          screen.put(row, x, cutToWidth(marker, cols - x - 1), this.theme.note);
          this.hotspots.push({
            row,
            left: x,
            right: x + strWidth(marker),
            kind: "note",
            target,
          });
        }
        pos = text.indexOf(marker, pos + marker.length);
      }
    }
  }

  // --- события ----------------------------------------------------------

  /** Обрабатывает нажатие клавиши. */
  key(name: string): void {
    if (this.prompt) {
      if (this.prompt.key(name)) this.prompt = null;
      return;
    }
    if (this.popup) {
      // Закрывшееся окно могло открыть следующее прямо из обработчика —
      // так список закладок переоткрывается после удаления. Гасим только
      // то окно, что действительно закрылось.
      const shown = this.popup;
      if (shown.key(name) && this.popup === shown) this.popup = null;
      return;
    }

    const action = this.keymap[name];
    if (action !== "redraw") this.message = "";
    if (action === "quit") {
      this.finished = true;
      return;
    }
    this.act(action);
    this.clamp();
  }

  /** Обрабатывает событие мыши. */
  mouseEvent(event: MouseEvent): void {
    if (this.prompt) return;
    if (this.popup) {
      // Как и с клавишами: обработчик мог открыть следующее окно.
      const shown = this.popup;
      if (shown.mouse(event) && this.popup === shown) this.popup = null;
      return;
    }
    if (event.motion) return;

    if (event.button === "wheel-up") this.top -= 3;
    else if (event.button === "wheel-down") this.top += 3;
    else if (event.button === "right" && event.press) this.goBack();
    else if (event.button === "left" && event.press) this.click(event);
    this.clamp();
  }

  private click(event: MouseEvent): void {
    for (const spot of this.hotspots) {
      if (spot.row !== event.row || event.column < spot.left || event.column >= spot.right) {
        continue;
      }
      if (spot.kind === "note") {
        const destination = this.book.anchors[spot.target];
        if (destination !== undefined) {
          this.jumpStack.push(this.currentBlock());
          this.goToBlock(destination);
          this.message = "правая кнопка или Backspace — назад";
        }
      } else {
        void this.openImageAt(spot.target);
      }
      return;
    }
  }

  private act(action: string | undefined): void {
    switch (action) {
      case "line_down":
        this.top += 1;
        break;
      case "line_up":
        this.top -= 1;
        break;
      case "page_down":
        this.top += this.pageStep;
        break;
      case "page_up":
        this.top -= this.pageStep;
        break;
      case "half_down":
        this.top += Math.max(Math.floor(this.visible / 2), 1);
        break;
      case "half_up":
        this.top -= Math.max(Math.floor(this.visible / 2), 1);
        break;
      case "book_start":
        this.top = 0;
        break;
      case "book_end":
        this.top = this.lines.length;
        break;
      case "next_chapter":
        this.jumpChapter(1);
        break;
      case "prev_chapter":
        this.jumpChapter(-1);
        break;
      case "toc":
        this.showToc();
        break;
      case "note_follow":
        this.followNote();
        break;
      case "note_back":
        this.goBack();
        break;
      case "image":
        void this.openVisibleImage();
        break;
      case "sync":
        void this.runSync();
        break;
      case "search":
        this.startSearch();
        break;
      case "search_next":
        this.search(1);
        break;
      case "search_prev":
        this.search(-1);
        break;
      case "match_list":
        this.showMatches();
        break;
      case "bookmark_add":
        this.addBookmark();
        break;
      case "bookmark_list":
        this.showBookmarks();
        break;
      case "wider":
        this.changeWidth(4);
        break;
      case "narrower":
        this.changeWidth(-4);
        break;
      case "spacing":
        this.cycleSpacing();
        break;
      case "one_column":
        this.setColumns(1);
        break;
      case "two_columns":
        this.setColumns(2);
        break;
      case "toggle_columns":
        this.setColumns(this.columns === 2 ? 1 : 2);
        break;
      case "theme":
        this.cycleTheme();
        break;
      case "mouse":
        this.toggleMouse();
        break;
      case "info":
        this.showInfo();
        break;
      case "help":
        this.showHelp();
        break;
      case "redraw":
        this.needsFullRedraw = true;
        break;
      default:
        break;
    }
  }

  /** Просит перерисовать экран целиком: Ctrl+L и возврат из картинки. */
  needsFullRedraw = false;

  // --- действия ---------------------------------------------------------

  private setColumns(count: number): void {
    this.columns = count === 2 ? 2 : 1;
    this.relayout(this.currentBlock());
    if (this.columns === 2 && this.effColumns === 1) {
      this.message = "для разворота нужно окно шире — пока одна колонка";
    } else {
      this.message = this.columns === 2 ? "книжный разворот: две страницы" : "одна колонка";
    }
  }

  private changeWidth(delta: number): void {
    this.maxWidth = Math.max(this.maxWidth + delta, 24);
    this.relayout(this.currentBlock());
  }

  private cycleSpacing(): void {
    this.spacing = (this.spacing % 3) + 1;
    this.relayout(this.currentBlock());
    this.message = `межстрочный интервал: ${this.spacing}`;
  }

  private cycleTheme(): void {
    const next = (THEME_ORDER.indexOf(this.theme.name) + 1) % THEME_ORDER.length;
    this.theme = new Theme(THEME_ORDER[next]!);
    this.needsFullRedraw = true;
    this.message = `тема: ${this.theme.name}`;
  }

  private toggleMouse(): void {
    this.mouse = !this.mouse;
    this.message = this.mouse
      ? "мышь включена: колесо листает, клик по сноске открывает её"
      : "мышь отпущена — можно выделять текст";
  }

  private jumpChapter(direction: number): void {
    const here = this.currentBlock();
    const blocks = this.book.toc.map((t) => t.block);
    const next =
      direction > 0
        ? blocks.find((b) => b > here)
        : [...blocks].reverse().find((b) => b < here);
    if (next === undefined) {
      this.message = direction > 0 ? "дальше глав нет" : "это начало книги";
      return;
    }
    this.goToBlock(next);
  }

  private showToc(): void {
    if (!this.book.toc.length) {
      this.message = "в книге нет оглавления";
      return;
    }
    const here = this.currentBlock();
    let cursor = 0;
    const items = this.book.toc.map((entry, i) => {
      if (entry.block <= here) cursor = i;
      return "  ".repeat(Math.min(entry.level, 4)) + entry.title;
    });
    this.openPopup({
      title: "Оглавление",
      items,
      select: cursor,
      onDone: (result) => {
        if (result && "index" in result) this.goToBlock(this.book.toc[result.index]!.block);
      },
    });
  }

  private showHelp(): void {
    const rows = helpRows(this.bindings);
    const width = rows.reduce((max, [keys]) => Math.max(max, strWidth(keys)), 0) + 2;
    this.openPopup({
      // Версия в заголовке справки: это первое место, куда смотрят, когда
      // надо сказать, какая читалка стоит.
      title: this.options.version ? `Клавиши — fb2read ${this.options.version}` : "Клавиши",
      items: rows.map(([keys, text]) => keys + " ".repeat(width - strWidth(keys)) + text),
      onDone: () => {},
    });
  }

  private showInfo(): void {
    const b = this.book;
    const items = [
      `Формат   : ${b.format}`,
      `Название : ${b.title}`,
      `Автор    : ${b.author || "—"}`,
      `Серия    : ${b.series || "—"}`,
      `Файл     : ${this.options.path ?? ""}`,
      `Абзацев  : ${b.blocks.length}`,
      `Строк    : ${this.lines.length} (ширина ${this.width}, интервал ${this.spacing})`,
      `Экран    : ${this.screenColumns}x${this.screenRows} знакомест`,
      `Колонок  : ${this.effColumns}` +
        (this.columns === 2 && this.effColumns === 1 ? " (запрошено 2, окно узкое)" : ""),
      `Глав     : ${b.toc.length}`,
      `Закладок : ${this.liveMarks.length}`,
      ...(b.repairs.length ? ["", ...b.repairs.map((n) => `Правка   : ${n}`)] : []),
    ];
    this.openPopup({ title: "О книге", items, onDone: () => {} });
  }

  // --- сноски -----------------------------------------------------------

  private visibleRefs(): Array<[string, number]> {
    const found: Array<[string, number]> = [];
    const seen = new Set<number>();
    for (let i = this.top; i < Math.min(this.top + this.visible, this.lines.length); i++) {
      const block = this.lines[i]!.block;
      if (seen.has(block)) continue;
      seen.add(block);
      for (const [marker, target] of this.book.blocks[block]!.refs) {
        const destination = this.book.anchors[target];
        if (destination !== undefined) found.push([marker, destination]);
      }
    }
    return found;
  }

  private notePreview(destination: number): string {
    for (const b of this.book.blocks.slice(destination, destination + 5)) {
      if ((b.kind === "p" || b.kind === "cite") && b.text) return b.text;
    }
    return "";
  }

  private followNote(): void {
    const refs = this.visibleRefs();
    if (!refs.length) {
      this.message = "на экране нет ссылок на сноски";
      return;
    }
    if (refs.length === 1) {
      this.jumpTo(refs[0]![1]);
      return;
    }
    this.openPopup({
      title: "Сноски на экране",
      items: refs.map(([marker, dest]) => `${marker}  ${this.notePreview(dest)}`.slice(0, 100)),
      select: 0,
      onDone: (result) => {
        if (result && "index" in result) this.jumpTo(refs[result.index]![1]);
      },
    });
  }

  private jumpTo(block: number): void {
    this.jumpStack.push(this.currentBlock());
    this.goToBlock(block);
    this.message = "Backspace — вернуться к тексту";
  }

  private goBack(): void {
    const back = this.jumpStack.pop();
    if (back === undefined) {
      this.message = "возвращаться некуда";
      return;
    }
    this.goToBlock(back);
    this.message = "вернулись к тексту";
  }

  // --- поиск ------------------------------------------------------------

  private startSearch(): void {
    this.prompt = new Prompt("/", (text) => {
      if (text === null) return;
      if (!text) {
        this.query = "";
        this.matches = [];
        this.matchIndex = -1;
        this.message = "поиск сброшен";
        return;
      }
      this.query = text;
      this.matches = findMatches(this.book.blocks, text);
      this.matchIndex = -1;
      if (!this.matches.length) {
        this.message = `не найдено: ${text}`;
        return;
      }
      const here = this.currentBlock();
      const start = Math.max(
        this.matches.findIndex((m) => m.block >= here),
        0,
      );
      this.goToMatch(start);
    });
  }

  private search(direction: number): void {
    if (!this.query) {
      this.message = "сначала задайте поиск клавишей /";
      return;
    }
    if (!this.matches.length) {
      this.message = `не найдено: ${this.query}`;
      return;
    }
    const next = this.matchIndex + direction;
    this.goToMatch(
      ((next % this.matches.length) + this.matches.length) % this.matches.length,
      next < 0 || next >= this.matches.length,
    );
  }

  /** Переходит к совпадению и говорит, какое оно по счёту. */
  private goToMatch(index: number, wrapped = false): void {
    if (!this.matches.length) return;
    this.matchIndex = index % this.matches.length;
    const { block } = this.matches[this.matchIndex]!;
    this.goToBlock(block);
    const needle = normalize(this.query);
    for (let i = this.top; i < this.lines.length; i++) {
      const line = this.lines[i]!;
      if (line.block > block) break;
      if (line.block === block && normalize(line.text).includes(needle)) {
        this.top = Math.max(i - Math.floor(this.height / 3), 0);
        break;
      }
    }
    this.clamp();
    this.message =
      `совпадение ${this.matchIndex + 1} из ${this.matches.length}` +
      (wrapped ? ", поиск с начала" : "") +
      " — l покажет список";
  }

  private showMatches(): void {
    if (!this.matches.length) {
      this.message = "сначала задайте поиск клавишей /";
      return;
    }
    const total = Math.max(this.book.blocks.length - 1, 1);
    const items = this.matches.map(({ block, offset }) => {
      const percent = Math.round((100 * block) / total);
      return (
        String(percent).padStart(3) + "%  " + matchContext(this.book.blocks[block]!, offset)
      );
    });
    this.openPopup({
      title: `Совпадения: ${this.query}`,
      items,
      select: Math.max(this.matchIndex, 0),
      onDone: (result) => {
        if (result && "index" in result) this.goToMatch(result.index);
      },
    });
  }

  // --- закладки ---------------------------------------------------------

  /**
   * Живые закладки: без надгробий.
   *
   * Снятая закладка не выбрасывается, а помечается снятой, — иначе при
   * синхронизации она вернулась бы с другого устройства, которое о снятии не
   * знает. Читателю все эти пометки видеть незачем, поэтому список для
   * экрана всегда идёт через этот отбор.
   */
  private get liveMarks(): Bookmark[] {
    return this.bookmarks.filter((m) => !m.deleted);
  }

  /** Снимает закладку, оставляя след: когда именно её сняли. */
  private removeBookmark(block: number): void {
    const at = Date.now() / 1000;
    this.bookmarks = this.bookmarks.map((m) => (m.block === block ? { block, at, deleted: true } : m));
  }

  private addBookmark(): void {
    const block = this.currentBlock();
    if (this.liveMarks.some((m) => m.block === block)) {
      this.removeBookmark(block);
      this.message = "закладка снята";
    } else {
      // Надгробие на этом же блоке заменяется новой закладкой: поставить
      // заново — обычное дело.
      this.bookmarks = this.bookmarks.filter((m) => m.block !== block);
      this.bookmarks.push({
        block,
        name: bookmarkLabel(this.book.blocks, block),
        percent: progressPercent(block, this.book.blocks.length) ?? 0,
        at: Date.now() / 1000,
      });
      this.message = `закладка поставлена (${this.liveMarks.length} всего)`;
    }
    this.storeBookmarks();
  }

  private storeBookmarks(): void {
    this.markedBlocks = new Set(this.liveMarks.map((m) => m.block));
    this.options.saveBookmarks?.(this.bookmarks);
  }

  private showBookmarks(): void {
    if (!this.liveMarks.length) {
      this.message = "закладок нет: поставить — M";
      return;
    }
    // Порядок добавления, а не по книге: так закладка, которую только что
    // поставили, остаётся там, где её оставил читатель.
    const marks = this.liveMarks;
    const items = marks.map((m) => `${String(m.percent ?? 0).padStart(3)}%  ${m.name ?? ""}`);
    this.openPopup({
      title: "Закладки",
      items,
      select: 0,
      actions: "de",
      hint: " Enter — перейти, d — удалить, e — экспорт, q — закрыть ",
      onDone: (result) => {
        if (!result) return;
        const mark = marks[result.index]!;
        if ("action" in result && result.action === "d") {
          this.removeBookmark(mark.block);
          this.storeBookmarks();
          if (!this.liveMarks.length) {
            this.message = "закладок больше нет";
            return;
          }
          // Список открывается снова: удалять по одной удобнее, чем каждый
          // раз заходить заново.
          this.showBookmarks();
          return;
        }
        if ("action" in result && result.action === "e") {
          this.message =
            this.options.exportBookmarks?.(this.liveMarks) ?? "выгрузка закладок недоступна";
          return;
        }
        this.goToBlock(mark.block);
      },
    });
  }

  // --- картинки ---------------------------------------------------------

  private visibleImages(): Block[] {
    const found: Block[] = [];
    const seen = new Set<number>();
    for (let i = this.top; i < Math.min(this.top + this.visible, this.lines.length); i++) {
      const index = this.lines[i]!.block;
      if (seen.has(index)) continue;
      seen.add(index);
      const block = this.book.blocks[index]!;
      if (block.kind === "image" && block.src) found.push(block);
    }
    return found;
  }

  private async openVisibleImage(): Promise<void> {
    const images = this.visibleImages();
    if (!images.length) {
      this.message = "на экране нет иллюстраций";
      return;
    }
    // Про выключенный показ надо сказать сразу, а не после выбора картинки.
    if (this.options.imagesOff) {
      this.message = "показ картинок выключен ключом --images off";
      return;
    }
    if (images.length === 1) {
      await this.showImage(images[0]!);
      return;
    }
    this.openPopup({
      title: "Иллюстрации на экране",
      items: images.map((b, i) => `${i + 1}. ${b.text}`),
      select: 0,
      onDone: (result) => {
        if (result && "index" in result) void this.showImage(images[result.index]!);
      },
    });
  }

  private async openImageAt(src: string): Promise<void> {
    if (this.options.imagesOff) {
      this.message = "показ картинок выключен ключом --images off";
      return;
    }
    const block = this.book.blocks.find((b) => b.kind === "image" && b.src === src);
    if (block) await this.showImage(block);
  }

  /**
   * Синхронизация по нажатию.
   *
   * Сообщение о начале показывается сразу: обмен идёт по сети и может занять
   * секунду-другую, а молчащая читалка выглядит зависшей.
   */
  private async runSync(): Promise<void> {
    if (!this.options.syncNow) {
      this.message = "синхронизация не настроена: раздел [sync] в конфиге, подробности в README";
      return;
    }
    this.message = "синхронизирую…";
    this.options.requestPaint?.();
    // Позицию и закладки берём прямо сейчас: читатель мог пролистать книгу
    // с прошлого сохранения, и отправлять устаревшее место незачем.
    const got = await this.options.syncNow(this.currentBlock(), this.bookmarks);
    // Закладки, поставленные на другом устройстве, должны появиться сразу, а
    // не после перезапуска, — иначе непонятно, что синхронизация сработала.
    if (got.bookmarks) {
      this.bookmarks = got.bookmarks;
      this.markedBlocks = new Set(this.liveMarks.map((m) => m.block));
    }
    this.message = got.text;
    this.options.requestPaint?.();
  }

  private async showImage(block: Block): Promise<void> {
    if (!this.options.showImage) {
      this.message = "показ картинок выключен ключом --images off";
      return;
    }
    this.message = await this.options.showImage(block);
    this.needsFullRedraw = true;
    this.options.requestPaint?.();
  }

  // --- служебное --------------------------------------------------------

  private openPopup(options: Omit<ConstructorParameters<typeof Popup>[0], "onDone"> & {
    onDone: (result: PopupResult) => void;
  }): void {
    this.popup = new Popup({
      ...options,
      onDone: (result) => {
        this.popup = null;
        options.onDone(result);
      },
    });
  }

  /** Показывает ли читалка сейчас строку ввода: терминал вернёт курсор. */
  get promptCursor(): number | null {
    return this.prompt ? this.prompt.cursorColumn() : null;
  }
}
