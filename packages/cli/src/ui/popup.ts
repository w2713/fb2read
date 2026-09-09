/**
 * Всплывающее окно со списком.
 *
 * В версии на curses это был вложенный цикл событий. Здесь окно — состояние
 * читалки: события приходят снаружи, ответ отдаётся обратным вызовом. Так
 * нет второго цикла, и то же окно годится браузеру.
 */

import { cutToWidth, strWidth } from "@fb2read/core";
import type { Screen } from "../term/screen.js";
import type { MouseEvent } from "../term/input.js";
import type { Theme } from "./theme.js";

/** Чем закончился выбор: номер строки, действие над строкой или отказ. */
export type PopupResult = { index: number } | { action: string; index: number } | null;

export interface PopupOptions {
  title: string;
  items: string[];
  /** Если задан — по списку можно ходить и выбирать. */
  select?: number;
  /** Клавиши, которые вернутся как действие над выбранной строкой. */
  actions?: string;
  hint?: string;
  onDone: (result: PopupResult) => void;
}

export class Popup {
  private cursor: number;
  private top = 0;
  private height = 0;
  private width = 0;
  private originRow = 0;
  private originColumn = 0;
  private view = 0;

  constructor(private readonly options: PopupOptions) {
    this.cursor = options.select ?? 0;
  }

  private get selectable(): boolean {
    return this.options.select !== undefined;
  }

  draw(screen: Screen, theme: Theme): void {
    const { title, items } = this.options;
    const longest = items.reduce((max, s) => Math.max(max, strWidth(s)), 20);
    this.height = Math.max(Math.min(items.length + 4, screen.rows - 2), 5);
    this.width = Math.max(Math.min(longest + 6, screen.columns - 4), 24);
    this.originRow = Math.max(Math.floor((screen.rows - this.height) / 2), 0);
    this.originColumn = Math.max(Math.floor((screen.columns - this.width) / 2), 0);
    this.view = this.height - 4;

    const text = theme.attr("text");
    const dim = theme.attr("dim", { dim: true });

    // Рамка рисуется теми же символами, что curses.box.
    for (let y = 0; y < this.height; y++) {
      const row = this.originRow + y;
      screen.put(row, this.originColumn, " ".repeat(this.width), text);
      if (y === 0 || y === this.height - 1) {
        const line = (y === 0 ? "┌" : "└") + "─".repeat(this.width - 2) + (y === 0 ? "┐" : "┘");
        screen.put(row, this.originColumn, line, text);
      } else {
        screen.put(row, this.originColumn, "│", text);
        screen.put(row, this.originColumn + this.width - 1, "│", text);
      }
    }
    screen.put(this.originRow, this.originColumn + 2, ` ${title} `, theme.attr("text", { bold: true }));

    this.top = Math.max(0, Math.min(this.top, Math.max(items.length - this.view, 0)));
    if (this.selectable) {
      if (this.cursor < this.top) this.top = this.cursor;
      else if (this.cursor >= this.top + this.view) this.top = this.cursor - this.view + 1;
    }

    for (let i = 0; i < this.view; i++) {
      const j = this.top + i;
      if (j >= items.length) break;
      const chosen = this.selectable && j === this.cursor;
      const item = cutToWidth(items[j]!, this.width - 4);
      const padded = item + " ".repeat(Math.max(this.width - 4 - strWidth(item), 0));
      screen.put(
        this.originRow + i + 2,
        this.originColumn + 2,
        padded,
        chosen ? theme.attr("text", { reverse: true }) : text,
        this.width - 4,
      );
    }

    const scrollable = !this.selectable && items.length > this.view;
    const footer =
      this.options.hint ??
      (this.selectable
        ? " Enter — перейти, q — закрыть "
        : scrollable
          ? " j k — листать, q — закрыть "
          : " q — закрыть ");
    screen.put(
      this.originRow + this.height - 1,
      this.originColumn + 2,
      cutToWidth(footer, this.width - 4),
      dim,
      this.width - 4,
    );
  }

  /** Обрабатывает клавишу. Возвращает true, если окно закрылось. */
  key(name: string): boolean {
    const { items, actions, onDone } = this.options;
    if (["q", "esc", "t", "o"].includes(name)) {
      onDone(null);
      return true;
    }

    if (!this.selectable) {
      // Список без выбора всё равно бывает длиннее экрана — справка не
      // помещается в 24 строки, — поэтому его можно листать.
      const step = Math.max(this.view, 1);
      if (name === "down" || name === "j") this.top += 1;
      else if (name === "up" || name === "k") this.top -= 1;
      else if (name === "pgdn" || name === " ") this.top += step;
      else if (name === "pgup") this.top -= step;
      else if (name === "home" || name === "g") this.top = 0;
      else if (name === "end" || name === "G") this.top = items.length;
      this.top = Math.max(0, Math.min(this.top, Math.max(items.length - step, 0)));
      return false;
    }

    if (name === "down" || name === "j") this.cursor = Math.min(this.cursor + 1, items.length - 1);
    else if (name === "up" || name === "k") this.cursor = Math.max(this.cursor - 1, 0);
    else if (name === "pgdn") this.cursor = Math.min(this.cursor + this.view, items.length - 1);
    else if (name === "pgup") this.cursor = Math.max(this.cursor - this.view, 0);
    else if (name === "home" || name === "g") this.cursor = 0;
    else if (name === "end" || name === "G") this.cursor = items.length - 1;
    else if (name === "enter") {
      onDone({ index: this.cursor });
      return true;
    } else if (actions && name.length === 1 && actions.includes(name)) {
      onDone({ action: name, index: this.cursor });
      return true;
    }
    return false;
  }

  /** Обрабатывает мышь. Возвращает true, если окно закрылось. */
  mouse(event: MouseEvent): boolean {
    const { items, onDone } = this.options;

    if (!this.selectable) {
      if (event.button === "wheel-up") this.top = Math.max(this.top - 1, 0);
      else if (event.button === "wheel-down") {
        this.top = Math.min(this.top + 1, Math.max(items.length - this.view, 0));
      }
      return false;
    }

    if (event.button === "wheel-up") {
      this.cursor = Math.max(this.cursor - 1, 0);
      return false;
    }
    if (event.button === "wheel-down") {
      this.cursor = Math.min(this.cursor + 1, items.length - 1);
      return false;
    }
    if (event.button === "left" && event.press) {
      const row = event.row - this.originRow - 2;
      const inside =
        row >= 0 &&
        row < this.view &&
        event.column >= this.originColumn &&
        event.column < this.originColumn + this.width;
      if (inside) {
        const picked = this.top + row;
        if (picked < items.length) {
          onDone({ index: picked });
          return true;
        }
      }
    }
    return false;
  }
}
