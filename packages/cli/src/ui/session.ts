/**
 * Сеанс: связывает экраны с настоящим терминалом.
 *
 * Здесь и только здесь программа встречается с вводом-выводом. Сами экраны о
 * терминале не знают, поэтому тесты подставляют сюда свою реализацию и
 * проверяют всё до последней ячейки.
 *
 * Сеанс живёт дольше одного экрана: в библиотеке за ним идут список, книга и
 * снова список. Обработчики событий поэтому ставятся один раз и всегда
 * обращаются к текущему экрану — иначе они накапливались бы с каждой книгой.
 */

import { CLEAR, CURSOR_HIDE, CURSOR_SHOW, moveTo } from "../term/ansi.js";
import type { Terminal } from "../term/terminal.js";
import { Screen } from "../term/screen.js";
import type { View } from "./view.js";

export class Session {
  private readonly screen: Screen;
  private view: View | null = null;
  private finish: (() => void) | null = null;
  private waitingKey: (() => void) | null = null;
  private started = false;

  constructor(readonly terminal: Terminal) {
    this.screen = new Screen(terminal.rows, terminal.columns, terminal.colors);
  }

  /** Занимает терминал: полноэкранный режим, сырой ввод, мышь. */
  begin(mouse: boolean): void {
    if (this.started) return;
    this.started = true;
    this.terminal.enterRaw(mouse);

    this.terminal.onInput((event) => {
      if (this.waitingKey) {
        // Пока показана картинка, экран ждёт любого нажатия.
        if (event.kind === "key") {
          const resume = this.waitingKey;
          this.waitingKey = null;
          resume();
        }
        return;
      }
      const view = this.view;
      if (!view) return;
      const mouseWas = view.mouse;
      if (event.kind === "key") view.key(event.name);
      else view.mouseEvent(event);
      if (view.mouse !== mouseWas) this.terminal.setMouse(view.mouse);
      if (view.done) {
        this.finish?.();
        return;
      }
      this.paint();
    });

    this.terminal.onResize(() => {
      this.screen.resize(this.terminal.rows, this.terminal.columns);
      this.view?.setSize(this.terminal.rows, this.terminal.columns);
      this.paint();
    });
  }

  /** Возвращает терминал в исходное состояние. */
  end(): void {
    if (!this.started) return;
    this.started = false;
    this.terminal.leaveRaw();
  }

  /** Показывает экран и ждёт, пока тот закончит. */
  async show(view: View): Promise<void> {
    this.view = view;
    view.setSize(this.terminal.rows, this.terminal.columns);
    this.terminal.setMouse(view.mouse);
    // Прошлый экран оставил на терминале свои ячейки, поэтому первый кадр
    // нового рисуется целиком.
    this.screen.invalidate();
    this.paint();
    if (view.done) return;
    await new Promise<void>((resolve) => {
      this.finish = resolve;
    });
    this.finish = null;
  }

  /** Рисует кадр. Открыт для тестов, чтобы получить экран без цикла. */
  paint(): void {
    const view = this.view;
    if (!view) return;
    if (view.needsFullRedraw) {
      this.screen.invalidate();
      view.needsFullRedraw = false;
    }
    view.draw(this.screen);
    let frame = this.screen.render();
    // Курсор нужен только в строке поиска: там читатель видит, что набирает.
    const cursor = view.promptCursor;
    frame += cursor === null ? CURSOR_HIDE : moveTo(this.screen.rows - 1, cursor) + CURSOR_SHOW;
    this.terminal.write(frame);
  }

  /** Отдаёт весь экран под чужой вывод и ждёт нажатия. */
  async takeOver(draw: (write: (data: string) => void, columns: number, rows: number) => boolean): Promise<boolean> {
    this.terminal.write(CLEAR + moveTo(0, 0));
    const drawn = draw(
      (data) => this.terminal.write(data),
      this.terminal.columns,
      this.terminal.rows,
    );
    if (!drawn) {
      this.terminal.write(CLEAR + moveTo(0, 0));
      return false;
    }
    await new Promise<void>((resolve) => {
      this.waitingKey = resolve;
    });
    this.terminal.write(CLEAR);
    if (this.view) this.view.needsFullRedraw = true;
    return true;
  }
}
