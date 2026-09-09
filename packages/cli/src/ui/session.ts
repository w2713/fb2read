/**
 * Сеанс чтения: связывает читалку с терминалом.
 *
 * Здесь и только здесь читалка встречается с настоящим вводом-выводом.
 * Сама она о терминале не знает, поэтому тесты подставляют сюда свою
 * реализацию и проверяют всё до последней ячейки экрана.
 */

import {
  CLEAR,
  CURSOR_HIDE,
  CURSOR_SHOW,
  moveTo,
} from "../term/ansi.js";
import type { Terminal } from "../term/terminal.js";
import { Screen } from "../term/screen.js";
import type { Block, Book, Bookmark, ImageBackend } from "@fb2read/core";
import { Reader, type ReaderOptions } from "./reader.js";
import { detectBackend, renderImage } from "./images.js";

export interface SessionOptions extends Omit<ReaderOptions, "showImage"> {
  images: ImageBackend;
}

/** Читает книгу, пока пользователь не выйдет. */
export class Session {
  readonly reader: Reader;
  private screen: Screen;
  private backend: string;
  private waitingKey: ((name: string) => void) | null = null;

  constructor(
    private readonly terminal: Terminal,
    options: SessionOptions,
  ) {
    this.backend = options.images === "auto" ? detectBackend() : options.images;
    this.screen = new Screen(terminal.rows, terminal.columns, terminal.colors);
    this.reader = new Reader({
      ...options,
      showImage: (block) => this.showImage(block),
    });
    this.reader.setSize(terminal.rows, terminal.columns);
  }

  /** Ведёт чтение до выхода и возвращает, где читатель остановился. */
  async run(): Promise<{ block: number; bookmarks: Bookmark[] }> {
    this.terminal.enterRaw(this.reader.mouse);

    const done = new Promise<void>((resolve) => {
      this.terminal.onInput((event) => {
        if (this.waitingKey) {
          // Пока показана картинка, любая клавиша возвращает к тексту.
          if (event.kind === "key") {
            const resume = this.waitingKey;
            this.waitingKey = null;
            resume(event.name);
          }
          return;
        }
        const mouseWas = this.reader.mouse;
        if (event.kind === "key") this.reader.key(event.name);
        else this.reader.mouseEvent(event);
        if (this.reader.mouse !== mouseWas) this.terminal.setMouse(this.reader.mouse);
        if (this.reader.done) {
          resolve();
          return;
        }
        this.paint();
      });

      this.terminal.onResize(() => {
        this.screen.resize(this.terminal.rows, this.terminal.columns);
        this.reader.setSize(this.terminal.rows, this.terminal.columns);
        this.paint();
      });
    });

    this.paint();
    await done;
    this.terminal.leaveRaw();
    return { block: this.reader.currentBlock(), bookmarks: this.reader.bookmarks };
  }

  /** Рисует кадр. Открыт для тестов, чтобы получить экран без цикла. */
  paint(): void {
    if (this.reader.needsFullRedraw) {
      this.screen.invalidate();
      this.reader.needsFullRedraw = false;
    }
    this.reader.draw(this.screen);
    let frame = this.screen.render();
    // Курсор нужен только в строке поиска: там читатель видит, что набирает.
    const cursor = this.reader.promptCursor;
    frame += cursor === null ? CURSOR_HIDE : moveTo(this.screen.rows - 1, cursor) + CURSOR_SHOW;
    this.terminal.write(frame);
  }

  /**
   * Показывает картинку во весь экран и ждёт клавишу.
   *
   * Читалка на это время уходит с экрана целиком: протоколы рисуют поверх
   * содержимого, и вернуть текст можно только полной перерисовкой.
   */
  private async showImage(block: Block): Promise<string> {
    const book: Book = this.reader.book;
    const image = await book.imageData(block.src);
    if (!image) return "не удалось прочитать иллюстрацию";
    if (!this.backend) {
      return "этот терминал не умеет картинки — поставьте chafa";
    }

    this.terminal.write(CLEAR + moveTo(0, 0));
    const rows = Math.max(this.terminal.rows - 1, 1);
    const drawn = renderImage(
      (s) => this.terminal.write(s),
      image,
      this.backend,
      this.terminal.columns,
      rows,
    );
    if (!drawn) {
      this.terminal.write(CLEAR + moveTo(0, 0));
      return "показать картинку не вышло — поставьте chafa";
    }

    this.terminal.write(moveTo(this.terminal.rows - 1, 0) + " любая клавиша — назад ");
    await new Promise<void>((resolve) => {
      this.waitingKey = () => resolve();
    });
    this.terminal.write(CLEAR);
    return "";
  }
}
