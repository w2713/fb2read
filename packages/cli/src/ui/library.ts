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
  capHits,
  findMatches,
  matchContext,
  progressLine,
  progressPercent,
  type Bookmark,
  type ImageBackend,
  type StateStore,
  type Theme as ThemeName,
} from "@fb2read/core";
import { FileSource } from "../fsSource.js";
import type { Terminal } from "../term/terminal.js";
import { Chooser, type ChooserEntry } from "./chooser.js";
import { Finder, type FoundPick } from "./finder.js";
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
  justify: boolean;
  hyphens: boolean;
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
  /** Добавление книги или каталога по пути, введённому в списке. */
  add?: (path: string) => Promise<{ text: string; entries?: ChooserEntry[] }>;
  /**
   * Выгрузка открытой книги на сервер целиком.
   *
   * Возвращает строку для читателя: пустую, если книга там уже была.
   */
  keep?: (path: string, meta: { hash: string; title: string; author: string }) => Promise<string>;
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

  // Итог выгрузки предыдущей книги: показывается, когда читатель вернулся в
  // список. Ждать выгрузки нельзя — она идёт, пока книгу читают.
  let uploadNote = "";

  try {
    for (;;) {
      const chooser = new Chooser(entries, new Theme(prefs.theme), prefs.mouse, {
        ...(options.syncAll ? { onSync: options.syncAll } : {}),
        ...(options.add ? { onAdd: options.add } : {}),
        requestPaint: () => session.paint(),
      });
      if (uploadNote) {
        chooser.notice = ` ${uploadNote} `;
        uploadNote = "";
      }
      await session.show(chooser);
      let path = chooser.picked;

      // Поиск по всем книгам сразу: находка сама говорит, что открывать и на
      // каком абзаце. Отказались от находок — возвращаемся к списку.
      let startAt: number | null = null;
      if (chooser.query) {
        const found = await findEverywhere(session, chooser.query, entries, prefs);
        if (!found) continue;
        path = found.path;
        startAt = found.block;
      }

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
      // Место в книге: обычно запомненное, но пришли из находки — значит, к ней.
      const start = startAt ?? (fromStart ? 0 : await store.loadPosition(key));
      const bookmarks = await store.loadBookmarks(key);

      if (options.keep) {
        void options
          .keep(full, { hash: book.hash, title: book.title, author: book.author })
          .then((note) => {
            uploadNote = note;
          });
      }

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
        justify: prefs.justify,
        hyphens: prefs.hyphens,
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
      prefs.justify = result.reader.justify;
      prefs.hyphens = result.reader.hyphens;
      await store.saveSettings({
        theme: prefs.theme,
        spacing: prefs.spacing,
        columns: prefs.columns,
        mouse: prefs.mouse,
        justify: prefs.justify,
        hyphens: prefs.hyphens,
      });

      // Если место не записалось, читатель должен узнать об этом здесь же:
      // в списке, а не завтра, открыв книгу с начала. Проверка по свойству, а
      // не по типу: хранилище описано в ядре, а неудача записи — забота той
      // реализации, что пишет в файл.
      const failure = (store as { lastWriteError?: string | null }).lastWriteError;
      if (failure) uploadNote = `место не сохранилось: ${failure}`;

      // Список общий на весь цикл, поэтому обновлённый процент виден сразу
      // же, как только читатель вернулся из книги.
      chooser.updateProgress(path, progressPercent(result.block, book.blocks.length));
    }
  } finally {
    session.end();
  }
}

/**
 * В каких книгах вообще есть что искать.
 *
 * Книги, которые лежат только на сервере, пропускаются: искать в том, чего нет
 * на диске, нечем, а скачивать всю библиотеку ради поиска — самоуправство. В
 * счёт просмотренных они тоже не идут: обещать перебор по книге, которой тут
 * нет, значит врать читателю о том, где искали.
 */
export function searchQueue<T extends { path: string; remote?: string }>(
  entries: readonly T[],
): T[] {
  return entries.filter((entry) => entry.path && !entry.remote);
}

/**
 * Перебирает книги библиотеки в поисках слова.
 *
 * Указателя нет и не заводится: вся цена поиска — в разборе книги (измерено:
 * 408 мс разбора против 93 мс самого поиска на книге в 2.3 МБ), а указатель
 * стоил бы второй копии библиотеки на диске. Поэтому книги разбираются по
 * одной, находки показываются по мере готовности, и перебор можно прекратить,
 * не дожидаясь конца, — первая находка обычно появляется раньше, чем читатель
 * успеет об этом подумать.
 *
 * Порядок обхода — от недавно читанных: ищут обычно в том, что читают. Он
 * задан списком, который уже отсортирован по времени.
 */
async function findEverywhere(
  session: Session,
  query: string,
  entries: readonly ChooserEntry[],
  prefs: LibraryPrefs,
): Promise<FoundPick | null> {
  const finder = new Finder(query, new Theme(prefs.theme), prefs.mouse, {
    requestPaint: () => session.paint(),
  });
  const queue = searchQueue(entries);
  let done = 0;
  let found = 0;
  finder.say(progressLine(done, queue.length, found));

  // Экран показывается, но не дожидается: пока читатель смотрит на находки,
  // перебор идёт дальше и подкладывает новые.
  const shown = session.show(finder);

  for (const entry of queue) {
    if (finder.stopped || finder.done) break;
    // Пауза перед каждой книгой: разбор держит поток целиком, и без неё
    // нажатие «прекратить» дошло бы только в самом конце перебора.
    await new Promise((resume) => setImmediate(resume));
    // И ещё раз после паузы: как раз в ней нажатие и доходит. Без этой
    // проверки «прекратить», нажатое во время разбора книги, опаздывало на
    // целую книгу — CI поймал это на macOS, где перебор успевал уйти дальше.
    if (finder.stopped || finder.done) break;
    let book: Book | null = null;
    try {
      book = await Book.open(new FileSource(entry.path));
    } catch {
      // Битая книга не обрывает перебор по остальным: о ней читатель узнает,
      // когда попробует её открыть.
    }
    done += 1;
    if (!book) {
      finder.say(progressLine(done, queue.length, found));
      continue;
    }
    const matches = findMatches(book.blocks, query);
    const { shown: hits, more } = capHits(matches);
    found += matches.length;
    const total = Math.max(book.blocks.length - 1, 1);
    // Находки и счёт кладутся разом: иначе строка внизу мигала бы пустотой
    // между ними.
    finder.add(
      matches.length
        ? {
            path: entry.path,
            title: book.title,
            author: book.author,
            hits: hits.map(({ block, offset }) => ({
              block,
              percent: Math.round((100 * block) / total),
              text: matchContext(book.blocks[block]!, offset),
            })),
            more,
          }
        : null,
      progressLine(done, queue.length, found),
    );
  }

  const прервано = finder.stopped && done < queue.length;
  finder.ended(progressLine(done, queue.length, found) + (прервано ? " · остановлено" : ""));
  await shown;
  return finder.picked;
}
