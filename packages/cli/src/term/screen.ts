/**
 * Экран как сетка ячеек с отрисовкой по разнице.
 *
 * Это замена curses: программа рисует кадр целиком, а на экран уходит только
 * то, что изменилось. Иначе каждое нажатие перерисовывало бы всё окно, и на
 * медленном соединении текст заметно мигал бы.
 */

import {
  CLEAR,
  DEFAULT_ATTR,
  RESET,
  SYNC_OFF,
  SYNC_ON,
  moveTo,
  sameAttr,
  sgr,
  type Attr,
} from "./ansi.js";
import { charWidth } from "@fb2read/core";

interface Cell {
  ch: string;
  attr: Attr;
}

/** Пустая ячейка: пробел с начертанием по умолчанию. */
const blank = (attr: Attr): Cell => ({ ch: " ", attr });

export class Screen {
  private cells: Cell[][] = [];
  private shown: Cell[][] = [];
  private full = true;
  private background: Attr = DEFAULT_ATTR;

  constructor(
    public rows: number,
    public columns: number,
    private readonly colors = 256,
  ) {
    this.reset();
  }

  private reset(): void {
    const make = () =>
      Array.from({ length: this.rows }, () =>
        Array.from({ length: this.columns }, () => blank(this.background)),
      );
    this.cells = make();
    this.shown = make();
    this.full = true;
  }

  /** Меняет размер сетки: содержимое сбрасывается, кадр рисуется заново. */
  resize(rows: number, columns: number): void {
    this.rows = Math.max(rows, 1);
    this.columns = Math.max(columns, 1);
    this.reset();
  }

  /** Цвет фона всего экрана — задаётся темой. */
  setBackground(attr: Attr): void {
    this.background = attr;
    this.full = true;
  }

  /** Требует полной перерисовки: Ctrl+L, возврат из показа картинки. */
  invalidate(): void {
    this.full = true;
  }

  /** Стирает кадр перед новой отрисовкой. */
  erase(): void {
    for (const row of this.cells) {
      for (let x = 0; x < row.length; x++) row[x] = blank(this.background);
    }
  }

  /**
   * Пишет текст с заданной позиции.
   *
   * Выход за край не ошибка, а обычное дело при узком окне: лишнее молча
   * отсекается, как это делал addnstr в curses.
   */
  put(row: number, column: number, text: string, attr: Attr, maxWidth?: number): void {
    if (row < 0 || row >= this.rows) return;
    const line = this.cells[row]!;
    const limit =
      maxWidth === undefined ? this.columns : Math.min(this.columns, column + maxWidth);
    let x = column;
    for (const ch of text) {
      const width = charWidth(ch);
      if (x >= limit) break;
      if (width === 0) continue; // диакритика присоединилась бы к предыдущей
      if (x + width > limit) break;
      if (x >= 0) {
        line[x] = { ch, attr };
        // Широкий символ занимает две ячейки: правая пустая, иначе при
        // отрисовке по разнице там остался бы хвост прошлого кадра.
        if (width === 2 && x + 1 < this.columns) line[x + 1] = { ch: "", attr };
      }
      x += width;
    }
  }

  /** Заливает строку начертанием — так рисуется полоса заголовка. */
  fillRow(row: number, attr: Attr): void {
    if (row < 0 || row >= this.rows) return;
    const line = this.cells[row]!;
    for (let x = 0; x < line.length; x++) line[x] = blank(attr);
  }

  /** Что сейчас нарисовано в строке — нужно тестам и отладке. */
  lineText(row: number): string {
    if (row < 0 || row >= this.rows) return "";
    return this.cells[row]!.map((c) => c.ch)
      .join("")
      .replace(/\s+$/, "");
  }

  /** Собирает байты кадра: только изменившиеся ячейки. */
  render(): string {
    const out: string[] = [SYNC_ON];
    if (this.full) out.push(RESET, CLEAR);

    let attr: Attr | null = null;
    let cursorRow = -1;
    let cursorColumn = -1;

    for (let y = 0; y < this.rows; y++) {
      const line = this.cells[y]!;
      const previous = this.shown[y]!;
      for (let x = 0; x < this.columns; x++) {
        const cell = line[x]!;
        if (cell.ch === "") continue; // правая половина широкого символа
        const before = previous[x]!;
        if (!this.full && before.ch === cell.ch && sameAttr(before.attr, cell.attr)) {
          continue;
        }
        if (y !== cursorRow || x !== cursorColumn) {
          out.push(moveTo(y, x));
          cursorRow = y;
          cursorColumn = x;
        }
        if (!attr || !sameAttr(attr, cell.attr)) {
          out.push(sgr(cell.attr, this.colors));
          attr = cell.attr;
        }
        out.push(cell.ch === "" ? " " : cell.ch);
        cursorColumn += charWidth(cell.ch) || 1;
      }
    }

    out.push(RESET, SYNC_OFF);
    this.shown = this.cells.map((row) => row.map((cell) => ({ ...cell })));
    this.full = false;
    return out.join("");
  }
}
