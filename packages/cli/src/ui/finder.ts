/**
 * Экран находок по всей библиотеке.
 *
 * Список книг умеет открыть книгу, но не умеет сказать, в какой из них
 * встречается слово. Этот экран отвечает именно на такой вопрос: перебирает
 * книги одну за другой и показывает находки по мере готовности — заголовком
 * книги и выдержками под ним.
 *
 * Перебор идёт снаружи, в библиотеке: она умеет открывать книги, а экран —
 * нет, и знать об этом ему незачем. Сюда находки только приносят, а экран
 * решает, как их показать и куда уйдёт выбор.
 */

import { cutToWidth, strWidth } from "@fb2read/core";
import type { MouseEvent } from "../term/input.js";
import type { Screen } from "../term/screen.js";
import type { Theme } from "./theme.js";
import type { View } from "./view.js";

/** Одна находка: где она в книге и что вокруг неё написано. */
export interface FoundHit {
  block: number;
  percent: number;
  text: string;
}

/** Находки одной книги. */
export interface FoundBook {
  path: string;
  title: string;
  author: string;
  hits: FoundHit[];
  /** Сколько находок осталось за пределом показа. */
  more: number;
}

/** Выбранная находка: какую книгу открыть и на каком абзаце. */
export interface FoundPick {
  path: string;
  block: number;
}

/** Строка экрана: заголовок книги, находка или хвост «и ещё столько-то». */
type Row =
  | { kind: "book"; book: FoundBook }
  | { kind: "hit"; book: FoundBook; hit: FoundHit }
  | { kind: "more"; book: FoundBook };

export class Finder implements View {
  needsFullRedraw = false;
  /** Что выбрал читатель; null — ушёл ни с чем. */
  picked: FoundPick | null = null;
  /** Попросил ли читатель прекратить перебор. */
  stopped = false;

  /** Идёт ли перебор: от этого зависит и подсказка, и что делает «q». */
  private running = true;

  private books: FoundBook[] = [];
  private rows: Row[] = [];
  private cursor = 0;
  private top = 0;
  private height = 24;
  private columns = 80;
  private finished = false;
  private line = "";

  constructor(
    private readonly query: string,
    private readonly theme: Theme,
    readonly mouse: boolean,
    private readonly hooks: { requestPaint?: () => void } = {},
  ) {}

  get done(): boolean {
    return this.finished;
  }

  /** Курсор в строке ввода этому экрану не нужен: запрос уже набран. */
  get promptCursor(): number | null {
    return null;
  }

  setSize(rows: number, columns: number): void {
    this.height = rows;
    this.columns = columns;
    this.clamp();
  }

  /** Сколько строк списка помещается: заголовок сверху и счёт снизу. */
  private get view(): number {
    return Math.max(this.height - 2, 1);
  }

  /**
   * Добавляет находки очередной книги и обновляет строку о ходе дела.
   *
   * Книга без находок сюда не приходит вовсе — вместо неё приносят пустоту, —
   * но счёт просмотренных меняется и от неё: по нему видно, что перебор идёт.
   */
  add(book: FoundBook | null, note: string): void {
    if (book) {
      this.books.push(book);
      this.rebuild();
    }
    this.line = note;
    this.hooks.requestPaint?.();
  }

  /** Меняет строку о ходе дела, ничего не добавляя. */
  say(note: string): void {
    this.line = note;
    this.hooks.requestPaint?.();
  }

  /** Перебор кончился: сам дошёл до конца или его остановили. */
  ended(note: string): void {
    this.running = false;
    this.line = note;
    this.hooks.requestPaint?.();
  }

  private rebuild(): void {
    const was = this.rows[this.cursor];
    this.rows = [];
    for (const book of this.books) {
      this.rows.push({ kind: "book", book });
      for (const hit of book.hits) this.rows.push({ kind: "hit", book, hit });
      if (book.more) this.rows.push({ kind: "more", book });
    }
    // Первая находка ставится под курсор сама: читателю чаще всего нужна
    // именно она, а не заголовок книги, в которой она нашлась.
    if (!was) this.cursor = this.rows.findIndex((row) => row.kind === "hit");
    if (this.cursor < 0) this.cursor = 0;
    this.clamp();
  }

  private clamp(): void {
    const last = Math.max(this.rows.length - 1, 0);
    this.cursor = Math.max(0, Math.min(this.cursor, last));
    this.top = Math.max(0, Math.min(this.top, Math.max(this.rows.length - this.view, 0)));
    if (this.cursor < this.top) this.top = this.cursor;
    else if (this.cursor >= this.top + this.view) this.top = this.cursor - this.view + 1;
  }

  draw(screen: Screen): void {
    screen.setBackground(this.theme.background);
    screen.erase();
    this.clamp();

    const title = ` Поиск: ${this.query} `;
    screen.fillRow(0, this.theme.header);
    screen.put(0, 0, cutToWidth(title, this.columns - 1), this.theme.header, this.columns - 1);

    const text = this.theme.attr("text");
    const dim = this.theme.attr("dim", { dim: true });
    const bold = this.theme.attr("title", { bold: true });

    for (let i = 0; i < this.view; i++) {
      const index = this.top + i;
      const row = this.rows[index];
      if (!row) break;
      const chosen = index === this.cursor;
      let line: string;
      let attr = text;
      if (row.kind === "book") {
        // Пустая строка перед книгой отделяла бы находки друг от друга, но
        // съедала бы строку экрана: вместо неё — начертание.
        line = ` ${row.book.author ? `${row.book.author} — ` : ""}${row.book.title}`;
        attr = bold;
      } else if (row.kind === "more") {
        line = `      …и ещё ${row.book.more}`;
        attr = dim;
      } else {
        line = `   ${String(row.hit.percent).padStart(3)}%  ${row.hit.text}`;
      }
      let shown = cutToWidth(line, this.columns - 2);
      shown += " ".repeat(Math.max(this.columns - 2 - strWidth(shown), 0));
      screen.put(
        i + 1,
        0,
        shown,
        chosen ? this.theme.attr("text", { reverse: true }) : attr,
        this.columns - 1,
      );
    }

    // Подсказка о клавишах меняется вместе с делом: пока идёт перебор, его
    // можно прекратить, а выбирать ещё нечего.
    const keys = this.running
      ? "esc — прекратить"
      : this.rows.length
        ? "Enter — открыть,  q — назад"
        : "q — назад";
    screen.put(
      this.height - 1,
      0,
      cutToWidth(` ${this.line} · ${keys} `, this.columns - 1),
      dim,
      this.columns - 1,
    );
  }

  key(name: string): void {
    if (name === "q" || name === "Q" || name === "esc") {
      // Пока идёт перебор, первое нажатие останавливает его, а не уходит с
      // экрана: найденное читатель ещё не посмотрел.
      if (this.running) {
        this.stopped = true;
        return;
      }
      this.picked = null;
      this.finished = true;
      return;
    }
    if (name === "ctrl-l") {
      this.needsFullRedraw = true;
      return;
    }
    if (name === "enter") {
      this.choose(this.cursor);
      return;
    }

    if (name === "down" || name === "j") this.step(1);
    else if (name === "up" || name === "k") this.step(-1);
    else if (name === "pgdn") this.jump(this.view);
    else if (name === "pgup") this.jump(-this.view);
    else if (name === "home" || name === "g") this.toEdge(1);
    else if (name === "end" || name === "G") this.toEdge(-1);
    this.clamp();
  }

  /**
   * Двигает курсор на следующую находку.
   *
   * Заголовки книг и хвосты пропускаются: выбирать в них нечего, а
   * останавливаться на них значит заставлять читателя жать клавишу впустую.
   */
  private step(by: number): void {
    for (let at = this.cursor + by; at >= 0 && at < this.rows.length; at += by) {
      if (this.rows[at]!.kind === "hit") {
        this.cursor = at;
        return;
      }
    }
  }

  private jump(by: number): void {
    const want = Math.max(0, Math.min(this.cursor + by, this.rows.length - 1));
    this.cursor = want;
    // С заголовка сходим на ближайшую находку в ту же сторону.
    if (this.rows[this.cursor]?.kind !== "hit") this.step(by > 0 ? 1 : -1);
    if (this.rows[this.cursor]?.kind !== "hit") this.step(by > 0 ? -1 : 1);
  }

  private toEdge(from: number): void {
    this.cursor = from > 0 ? 0 : this.rows.length - 1;
    if (this.rows[this.cursor]?.kind !== "hit") this.step(from);
  }

  mouseEvent(event: MouseEvent): void {
    if (event.motion) return;
    if (event.button === "wheel-up") this.step(-1);
    else if (event.button === "wheel-down") this.step(1);
    else if (event.button === "left" && event.press) {
      const at = this.top + event.row - 1;
      if (at >= 0 && at < this.rows.length && this.rows[at]!.kind === "hit") {
        this.cursor = at;
        this.choose(at);
        return;
      }
    }
    this.clamp();
  }

  private choose(index: number): void {
    const row = this.rows[index];
    if (!row || row.kind !== "hit") return;
    this.picked = { path: row.book.path, block: row.hit.block };
    this.finished = true;
  }
}
