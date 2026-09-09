/**
 * Строка ввода внизу экрана: запрос поиска.
 *
 * Как и всплывающее окно, это состояние читалки, а не вложенный цикл:
 * каждая клавиша приходит снаружи.
 */

import { cutToWidth } from "@fb2read/core";
import type { Screen } from "../term/screen.js";
import type { Theme } from "./theme.js";

const MAX_LENGTH = 120;

export class Prompt {
  private text = "";

  constructor(
    private readonly label: string,
    private readonly onDone: (text: string | null) => void,
  ) {}

  draw(screen: Screen, theme: Theme): void {
    const row = screen.rows - 1;
    const line = this.label + this.text;
    screen.fillRow(row, theme.attr("text"));
    screen.put(row, 0, cutToWidth(line, screen.columns - 1), theme.attr("text"));
  }

  /** Где стоит курсор — терминал показывает его на время ввода. */
  cursorColumn(): number {
    return Math.min(this.label.length + this.text.length, 200);
  }

  /** Обрабатывает клавишу. Возвращает true, если ввод закончен. */
  key(name: string): boolean {
    if (name === "enter") {
      this.onDone(this.text.trim());
      return true;
    }
    if (name === "esc") {
      this.onDone(null);
      return true;
    }
    if (name === "backspace") {
      // Режем по символам, а не по единицам UTF-16: иначе эмодзи распалось
      // бы на половинки.
      const chars = [...this.text];
      chars.pop();
      this.text = chars.join("");
      return false;
    }
    if (name === "ctrl-u") {
      this.text = "";
      return false;
    }
    // Служебные имена длиннее одного символа в текст не попадают.
    if ([...name].length === 1 && this.text.length < MAX_LENGTH) this.text += name;
    return false;
  }
}
