/**
 * Экран выбора книги.
 *
 * Показывает недавно читанное или содержимое каталога с процентом чтения.
 * Устроен как машина состояний, а не вложенный цикл: сеанс переключает
 * список и книгу, оставаясь в одном терминале, и после чтения читатель
 * возвращается сюда же с обновлённым прогрессом.
 */

import { cutToWidth, plural, strWidth } from "@fb2read/core";
import type { MouseEvent } from "../term/input.js";
import type { Screen } from "../term/screen.js";
import type { Theme } from "./theme.js";
import type { View } from "./view.js";

/** Книга в списке. */
export interface ChooserEntry {
  path: string;
  title: string;
  author: string;
  percent: number | null;
  /**
   * Отпечаток книги, которая лежит только на сервере.
   *
   * Такие показаны облаком вместо процента и скачиваются по Enter. Путь у
   * них пустой до тех пор, пока книга не окажется на диске.
   */
  remote?: string;
}

/** Дочитанной считается книга, пройденная почти до конца. */
const FINISHED = 99;

export class Chooser implements View {
  needsFullRedraw = false;
  /** Путь к выбранной книге; null, если читатель вышел. */
  picked: string | null = null;
  /** Сама выбранная запись: у книги с сервера пути ещё нет. */
  pickedEntry: ChooserEntry | null = null;
  /** Строка вместо подсказки: например, «скачиваю…» во время загрузки. */
  notice = "";

  private cursor = 0;
  private top = 0;
  private rows = 24;
  private columns = 80;
  private finished = false;
  /** Сообщение об ошибке во весь экран: книга не открылась. */
  private failure: string | null = null;

  constructor(
    private entries: ChooserEntry[],
    private readonly theme: Theme,
    readonly mouse: boolean,
    /**
     * Синхронизация по клавише и просьба перерисовать экран.
     *
     * Обмен идёт по сети и заканчивается когда-то потом, а список сам об
     * этом не узнает, — отсюда и просьба перерисовать.
     */
    private readonly hooks: {
      onSync?: () => Promise<{ text: string; entries?: ChooserEntry[] }>;
      requestPaint?: () => void;
    } = {},
  ) {}

  get done(): boolean {
    return this.finished;
  }

  /** Курсор на экране списка не нужен. */
  get promptCursor(): number | null {
    return null;
  }

  /** Сколько строк списка помещается: строка заголовка, пустая и подсказка. */
  private get view(): number {
    return Math.max(this.rows - 3, 1);
  }

  setSize(rows: number, columns: number): void {
    this.rows = rows;
    this.columns = columns;
    this.clamp();
  }

  /** Обновляет прогресс книги, прочитанной только что. */
  updateProgress(path: string, percent: number | null): void {
    for (const entry of this.entries) {
      if (entry.path === path) entry.percent = percent;
    }
  }

  /**
   * Переводит экран в сообщение о том, что книга не открылась.
   *
   * Сообщение уходит от любого нажатия, и на этом экран заканчивается:
   * читатель возвращается к списку, а не остаётся в непонятном состоянии.
   */
  showFailure(text: string): void {
    this.failure = text;
    this.picked = null;
    this.finished = false;
    this.needsFullRedraw = true;
  }

  private clamp(): void {
    this.cursor = Math.max(0, Math.min(this.cursor, Math.max(this.entries.length - 1, 0)));
    this.top = Math.max(0, Math.min(this.top, Math.max(this.entries.length - this.view, 0)));
    if (this.cursor < this.top) this.top = this.cursor;
    else if (this.cursor >= this.top + this.view) this.top = this.cursor - this.view + 1;
  }

  draw(screen: Screen): void {
    screen.setBackground(this.theme.background);
    screen.erase();

    if (this.failure !== null) {
      this.drawFailure(screen);
      return;
    }

    this.clamp();

    const title = ` Библиотека — ${plural(this.entries.length, "книга", "книги", "книг")} `;
    screen.fillRow(0, this.theme.header);
    screen.put(0, 0, cutToWidth(title, this.columns - 1), this.theme.header, this.columns - 1);

    for (let i = 0; i < this.view; i++) {
      const index = this.top + i;
      if (index >= this.entries.length) break;
      const entry = this.entries[index]!;
      // Облако вместо процента: книга есть на сервере, но не здесь.
      const mark = entry.remote
        ? "  ☁ "
        : entry.percent === null
          ? "  · "
          : `${String(entry.percent).padStart(3)}%`;
      const name = entry.author ? `${entry.author} — ${entry.title}` : entry.title;
      let row = cutToWidth(` ${mark}  ${name}`, this.columns - 2);
      // Дополняем пробелами: у выбранной строки фон обращён, и без этого
      // полоса обрывалась бы на конце названия.
      row += " ".repeat(Math.max(this.columns - 2 - strWidth(row), 0));
      screen.put(i + 1, 0, row, this.attrFor(entry, index === this.cursor), this.columns - 1);
    }

    const hint =
      this.notice ||
      (this.hooks.onSync
        ? " Enter — читать,  S — синхронизировать,  q — выход "
        : " Enter или клик — читать,  q — выход ");
    screen.put(
      this.rows - 1,
      0,
      cutToWidth(hint, this.columns - 1),
      this.theme.attr("dim", { dim: true }),
      this.columns - 1,
    );
  }

  private drawFailure(screen: Screen): void {
    const text = this.theme.attr("text");
    screen.put(0, 0, cutToWidth(this.failure ?? "", this.columns - 1), text, this.columns - 1);
    screen.put(
      2,
      0,
      "любая клавиша — назад к списку",
      this.theme.attr("dim", { dim: true }),
      this.columns - 1,
    );
  }

  private attrFor(entry: ChooserEntry, chosen: boolean) {
    if (chosen) return this.theme.attr("text", { reverse: true });
    // Дочитанные приглушаем, чтобы взгляд цеплялся за непрочитанное.
    if (entry.percent !== null && entry.percent >= FINISHED) {
      return this.theme.attr("dim", { dim: true });
    }
    return this.theme.attr("text");
  }

  key(name: string): void {
    if (this.failure !== null) {
      // Любое нажатие закрывает сообщение и возвращает к списку.
      this.failure = null;
      this.finished = true;
      return;
    }

    if (name === "q" || name === "Q" || name === "esc") {
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
    if (name === "S") {
      void this.runSync();
      return;
    }

    const last = this.entries.length - 1;
    if (name === "down" || name === "j") this.cursor = Math.min(this.cursor + 1, last);
    else if (name === "up" || name === "k") this.cursor = Math.max(this.cursor - 1, 0);
    else if (name === "pgdn") this.cursor = Math.min(this.cursor + this.view, last);
    else if (name === "pgup") this.cursor = Math.max(this.cursor - this.view, 0);
    else if (name === "home" || name === "g") this.cursor = 0;
    else if (name === "end" || name === "G") this.cursor = last;
    this.clamp();
  }

  mouseEvent(event: MouseEvent): void {
    if (this.failure !== null) return; // ошибку снимает только клавиша
    if (event.motion) return;

    const last = this.entries.length - 1;
    if (event.button === "wheel-up") {
      // В списке колесо двигает выбор на одну книгу, а не прокручивает
      // на три строки, как в тексте.
      this.cursor = Math.max(this.cursor - 1, 0);
    } else if (event.button === "wheel-down") {
      this.cursor = Math.min(this.cursor + 1, last);
    } else if (event.button === "left" && event.press) {
      const row = event.row - 1;
      if (row >= 0 && row < this.view) {
        const index = this.top + row;
        if (index < this.entries.length) {
          this.cursor = index;
          this.choose(index);
          return;
        }
      }
    }
    this.clamp();
  }

  /** Обмен с сервером и обновление списка. */
  private async runSync(): Promise<void> {
    if (!this.hooks.onSync) {
      this.notice = " синхронизация не настроена: раздел [sync] в конфиге ";
      this.hooks.requestPaint?.();
      return;
    }
    this.notice = " синхронизирую… ";
    this.hooks.requestPaint?.();
    const got = await this.hooks.onSync();
    // Список мог измениться: прогресс подтянулся, а книги с сервера,
    // которых тут нет, могли появиться или пропасть.
    if (got.entries) {
      this.entries = got.entries;
      this.clamp();
    }
    this.notice = ` ${got.text} `;
    this.needsFullRedraw = true;
    this.hooks.requestPaint?.();
  }

  private choose(index: number): void {
    const entry = this.entries[index];
    if (!entry) return;
    this.picked = entry.path;
    this.pickedEntry = entry;
    this.finished = true;
  }
}
