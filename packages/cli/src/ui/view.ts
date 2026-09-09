/**
 * Экран, который умеет показать себя и принять события.
 *
 * Читалка и список книг устроены одинаково: рисуют кадр, получают клавиши и
 * мышь, сообщают, что закончили. Общий вид позволяет сеансу крутить их по
 * очереди в одном терминале — а именно так и работает библиотека: список,
 * книга, снова список.
 */

import type { MouseEvent } from "../term/input.js";
import type { Screen } from "../term/screen.js";

export interface View {
  /** Рисует кадр в сетку экрана. */
  draw(screen: Screen): void;
  key(name: string): void;
  mouseEvent(event: MouseEvent): void;
  /** Сообщает новый размер окна. */
  setSize(rows: number, columns: number): void;
  /** Закончил ли экран работу: сеанс переходит к следующему. */
  readonly done: boolean;
  /** Нужна ли полная перерисовка: Ctrl+L, смена темы, возврат из картинки. */
  needsFullRedraw: boolean;
  /** Где показать курсор, или null, если он не нужен. */
  readonly promptCursor: number | null;
  /** Держит ли экран мышь. */
  readonly mouse: boolean;
}
