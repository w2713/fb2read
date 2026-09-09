/**
 * Библиотека на экране: список книг, чтение, возвращение к списку.
 *
 * Терминал занимается один раз на всю работу: список и книга сменяют друг
 * друга внутри одного сеанса. Поэтому переход туда и обратно мгновенный, а
 * прогресс в списке обновляется сразу после того, как книгу закрыли.
 */

import { basename, resolve } from "node:path";
import {
  Book,
  bookKey,
  progressPercent,
  type Bookmark,
  type ImageBackend,
  type StateStore,
  type Theme as ThemeName,
} from "@fb2read/core";
import { FileSource } from "../fsSource.js";
import type { Terminal } from "../term/terminal.js";
import { Chooser, type ChooserEntry } from "./chooser.js";
import { readBook } from "./read.js";
import { Session } from "./session.js";
import { Theme } from "./theme.js";

/** Настройки, которые читалка меняет и запоминает. */
export interface LibraryPrefs {
  theme: ThemeName;
  spacing: number;
  columns: number;
  images: ImageBackend;
  mouse: boolean;
  width: number;
  keys: Record<string, string>;
}

export interface LibraryOptions {
  entries: ChooserEntry[];
  prefs: LibraryPrefs;
  store: StateStore;
  fromStart: boolean;
  /** Куда писать выгруженные закладки. */
  exportBookmarks: (book: Book, marks: Bookmark[]) => string;
  /**
   * Скачивание книги, которая есть только на сервере.
   *
   * Возвращает путь, по которому книга легла на диск. Сеть — дело
   * платформы, поэтому сюда она приходит снаружи, а список о ней не знает.
   */
  download?: (hash: string, name: string) => Promise<string>;
  /** Версия читалки для заголовка справки. */
  version?: string;
  /**
   * Синхронизация книги, открытой из списка.
   *
   * Книга здесь становится известна только после выбора, поэтому вместо
   * готового обработчика библиотека получает способ его собрать.
   */
  syncNow?: (
    key: string,
    meta: { hash: string; title: string; author: string; total: number },
    path: string,
  ) => (block: number, bookmarks: Bookmark[]) => Promise<{ text: string; bookmarks?: Bookmark[] }>;
  /** Обмен состоянием всех книг по клавише в списке. */
  syncAll?: () => Promise<{ text: string; entries?: ChooserEntry[] }>;
}

/**
 * Крутит список книг, пока читатель не выйдет.
 *
 * Возвращает настройки в том виде, в каком их оставило чтение: тему и режим
 * колонок читатель мог поменять внутри книги, и список должен их подхватить.
 */
export async function runLibrary(
  terminal: Terminal,
  options: LibraryOptions,
): Promise<LibraryPrefs> {
  const { entries, store, fromStart } = options;
  const prefs = { ...options.prefs };
  const session = new Session(terminal);
  session.begin(prefs.mouse);

  try {
    for (;;) {
      const chooser = new Chooser(entries, new Theme(prefs.theme), prefs.mouse, {
        ...(options.syncAll ? { onSync: options.syncAll } : {}),
        requestPaint: () => session.paint(),
      });
      await session.show(chooser);
      let path = chooser.picked;
      if (path === null) return prefs;

      // Книга с сервера: сначала её надо забрать. Список остаётся на экране
      // и говорит, что происходит, — иначе терминал просто замирает.
      const picked = chooser.pickedEntry;
      if (picked?.remote && options.download) {
        chooser.notice = ` скачиваю ${picked.title}… `;
        session.paint();
        try {
          path = await options.download(picked.remote, picked.title);
          picked.path = path;
          delete picked.remote;
        } catch (e) {
          chooser.notice = "";
          chooser.showFailure(`${picked.title}: ${(e as Error).message}`);
          await session.show(chooser);
          continue;
        }
        chooser.notice = "";
      }

      let book: Book;
      let source: FileSource;
      try {
        source = new FileSource(path);
        book = await Book.open(source);
      } catch (e) {
        // Битая книга не выбрасывает из библиотеки: сказали и вернулись.
        chooser.showFailure(`${basename(path)}: ${(e as Error).message}`);
        await session.show(chooser);
        continue;
      }

      const full = resolve(path);
      const key = await bookKey(full, source.size);
      const start = fromStart ? 0 : await store.loadPosition(key);
      const bookmarks = await store.loadBookmarks(key);

      const result = await readBook(session, {
        book,
        path: full,
        width: prefs.width,
        startBlock: start,
        theme: prefs.theme,
        spacing: prefs.spacing,
        columns: prefs.columns,
        images: prefs.images,
        imagesOff: prefs.images === "off",
        mouse: prefs.mouse,
        keys: prefs.keys,
        bookmarks,
        ...(options.version ? { version: options.version } : {}),
        ...(options.syncNow
          ? {
              syncNow: options.syncNow(
                key,
                {
                  hash: book.hash,
                  title: book.title,
                  author: book.author,
                  total: book.blocks.length,
                },
                full,
              ),
            }
          : {}),
        saveBookmarks: (marks) => {
          void store.saveBookmarks(key, marks, {
            title: book.title,
            author: book.author,
            total: book.blocks.length,
            path: full,
          });
        },
        exportBookmarks: (marks) => options.exportBookmarks(book, marks),
      });

      await store.savePosition(key, {
        block: result.block,
        title: book.title,
        author: book.author,
        total: book.blocks.length,
        path: full,
        at: Date.now() / 1000,
        hash: book.hash,
      });

      // Настройки, выбранные при чтении, переносим на список и следующие книги.
      prefs.theme = result.reader.theme.name as ThemeName;
      prefs.spacing = result.reader.spacing;
      prefs.columns = result.reader.columns;
      prefs.mouse = result.reader.mouse;
      await store.saveSettings({
        theme: prefs.theme,
        spacing: prefs.spacing,
        columns: prefs.columns,
        mouse: prefs.mouse,
      });

      // Список общий на весь цикл, поэтому обновлённый процент виден сразу
      // же, как только читатель вернулся из книги.
      chooser.updateProgress(path, progressPercent(result.block, book.blocks.length));
    }
  } finally {
    session.end();
  }
}
