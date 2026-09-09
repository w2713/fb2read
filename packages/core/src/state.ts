/**
 * Позиция чтения, закладки и настройки.
 *
 * Формат записи тот же, что у эталонной реализации, и ключ книги считается
 * так же — по абсолютному пути и размеру. Значит, читалка на TypeScript
 * открывает книгу ровно там, где её закрыла версия на Python.
 *
 * К записи добавлено поле `hash`: отпечаток содержимого нужен, чтобы узнать
 * ту же книгу на другом устройстве, где путь другой. Старые записи без него
 * читаются как прежде.
 */

import { sha1Hex } from "./hash.js";

/** Закладка: номер блока, подпись и время. */
export interface Bookmark {
  block: number;
  name?: string;
  text?: string;
  /** Процент по книге на момент постановки. */
  percent?: number;
  at?: number;
  /** Надгробие: закладка снята, но об этом надо помнить при синхронизации. */
  deleted?: boolean;
}

/** Запись о книге в хранилище. */
export interface PositionRecord {
  block: number;
  title: string;
  author: string;
  total: number;
  path: string;
  at: number;
  hash?: string;
  bookmarks?: Bookmark[];
}

/** Книга в списке недавних. */
export interface RecentEntry {
  path: string;
  title: string;
  author: string;
  percent: number | null;
  at: number;
}

/** Настройки, которые читалка запоминает сама. */
export interface Settings {
  theme?: string;
  spacing?: number;
  columns?: number;
  mouse?: boolean;
  [key: string]: unknown;
}

/**
 * Хранилище состояния.
 *
 * Всё асинхронно, потому что в браузере иначе нельзя: файловая реализация
 * просто оборачивает синхронные вызовы.
 */
export interface StateStore {
  loadPosition(key: string): Promise<number>;
  savePosition(key: string, record: PositionRecord): Promise<void>;
  loadBookmarks(key: string): Promise<Bookmark[]>;
  saveBookmarks(key: string, marks: Bookmark[], meta: Partial<PositionRecord>): Promise<void>;
  loadSettings(): Promise<Settings>;
  saveSettings(patch: Settings): Promise<void>;
  recent(): Promise<RecentEntry[]>;
}

/** Ключ книги: тот же, что в версии на Python, — sha1 от пути и размера. */
export async function bookKey(absolutePath: string, size: number): Promise<string> {
  const digest = await sha1Hex(`${absolutePath}:${size}`);
  return digest.slice(0, 16);
}

/** Процент прочитанного или null, если размер книги неизвестен. */
export function progressPercent(block: number, total: number): number | null {
  if (!total) return null;
  return Math.max(0, Math.min(100, Math.round((100 * block) / Math.max(total - 1, 1))));
}

/** Русское склонение: 1 книга, 2 книги, 5 книг. */
export function plural(n: number, one: string, few: string, many: string): string {
  const word =
    n % 10 === 1 && n % 100 !== 11
      ? one
      : n % 10 >= 2 && n % 10 <= 4 && !(n % 100 >= 12 && n % 100 <= 14)
        ? few
        : many;
  return `${n} ${word}`;
}
