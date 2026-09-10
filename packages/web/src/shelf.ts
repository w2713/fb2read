/**
 * Полка: что показать в списке книг и в каком порядке.
 *
 * Здесь только решения, без DOM и без хранилища, — значит, проверяются они
 * обычными тестами, а не браузером. Порядок списка тот же, что в терминале:
 * последнее читанное сверху.
 */

import { plural, progressPercent, type PositionRecord } from "@fb2read/core";
import type { BookMeta } from "./db.js";

/** Строка полки: всё, что нужно нарисовать, и ничего сверх того. */
export interface ShelfEntry {
  hash: string;
  title: string;
  author: string;
  percent: number | null;
  /** Когда книгу читали в последний раз; если не открывали — когда положили. */
  at: number;
  /** Открывали ли её вообще: непрочитанная книга и брошенная — разные вещи. */
  read: boolean;
  size: number;
}

/**
 * Собирает полку из книг и записей о местах.
 *
 * Книга и место лежат порознь: место переживает удаление книги, а книга может
 * лежать ни разу не открытой. Соединяются они по отпечатку.
 */
export function shelfOrder(
  books: readonly BookMeta[],
  states: readonly PositionRecord[],
): ShelfEntry[] {
  const byHash = new Map(states.map((state) => [state.hash ?? "", state]));
  const entries = books.map((book): ShelfEntry => {
    const state = byHash.get(book.hash);
    return {
      hash: book.hash,
      // Название из книги надёжнее имени файла, но в файле без названия
      // остаётся только оно.
      title: book.title || book.name,
      author: book.author,
      percent: state ? progressPercent(state.block, state.total) : null,
      at: state?.at ?? book.addedAt,
      read: state !== undefined,
      size: book.size,
    };
  });
  return entries.sort((a, b) => b.at - a.at);
}

const MONTHS = [
  "января",
  "февраля",
  "марта",
  "апреля",
  "мая",
  "июня",
  "июля",
  "августа",
  "сентября",
  "октября",
  "ноября",
  "декабря",
];

const DAY = 86_400;

/**
 * Когда это было, по-человечески.
 *
 * «Сегодня» и «вчера» считаются по календарю, а не по суткам назад: книга,
 * закрытая вчера в одиннадцать вечера, читалась вчера, а не сегодня.
 */
export function whenRead(at: number, now = Date.now() / 1000): string {
  if (!at) return "";
  const midnight = (seconds: number): number => {
    const date = new Date(seconds * 1000);
    date.setHours(0, 0, 0, 0);
    return date.getTime() / 1000;
  };
  const days = Math.round((midnight(now) - midnight(at)) / DAY);
  if (days <= 0) return "сегодня";
  if (days === 1) return "вчера";
  if (days < 7) return `${plural(days, "день", "дня", "дней")} назад`;
  const date = new Date(at * 1000);
  const day = `${date.getDate()} ${MONTHS[date.getMonth()]}`;
  return date.getFullYear() === new Date(now * 1000).getFullYear()
    ? day
    : `${day} ${date.getFullYear()}`;
}

/** Размер книги словами: мегабайты понятнее байтов. */
export function bookSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} КБ`;
  return `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
}
