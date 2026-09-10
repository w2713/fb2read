/**
 * Список книг: каталог на диске и недавно читанное.
 *
 * Автор и название достаются без полного разбора, поэтому список строится
 * быстро даже на каталоге в сотню книг.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { bookKey, isBookName, quickMeta, type RecentEntry, type StateStore } from "@fb2read/core";
import { FileSource } from "./fsSource.js";

/** Книга в списке. */
export interface LibraryEntry {
  path: string;
  title: string;
  author: string;
  percent: number | null;
  at: number;
}

/** Книги в каталоге с подтянутым прогрессом чтения. */
export async function scanDir(path: string, store: StateStore): Promise<LibraryEntry[]> {
  const progress = new Map<string, number | null>();
  for (const entry of await store.recent()) progress.set(entry.path, entry.percent);

  const entries: LibraryEntry[] = [];
  for (const name of readdirSync(path).sort()) {
    const full = join(path, name);
    let info;
    try {
      info = statSync(full);
    } catch {
      continue; // битая ссылка или файл исчез между listdir и stat
    }
    if (!info.isFile() || !isBookName(name)) continue;
    let meta = { title: "", author: "" };
    try {
      meta = await quickMeta(new FileSource(full));
    } catch {
      // Нечитаемый файл всё равно покажем — по имени.
    }
    entries.push({
      path: full,
      title: meta.title || name,
      author: meta.author,
      percent: progress.get(resolve(full)) ?? null,
      at: info.mtimeMs / 1000,
    });
  }
  return entries;
}

/** Недавно читанные книги, самые свежие сверху. */
export async function recentBooks(store: StateStore): Promise<RecentEntry[]> {
  return store.recent();
}

/**
 * Список книг текстом — когда вывод идёт в файл или конвейер.
 *
 * Принимает лишь то, что печатает: сюда попадают и записи каталога, и книги
 * с сервера, у которых пути на этом устройстве ещё нет.
 */
export function libraryLines(
  entries: readonly { path: string; title: string; percent: number | null }[],
): string[] {
  return entries.map((e) => {
    const percent = e.percent === null ? "-" : String(e.percent);
    return `${percent.padStart(4)}  ${e.title}  (${e.path || "на сервере"})`;
  });
}

/** Что вышло из добавления: строка для читателя и сколько книг прибавилось. */
export interface Added {
  text: string;
  count: number;
}

/**
 * Кладёт книгу — или все книги из каталога — в библиотеку.
 *
 * «Добавить» здесь значит две вещи сразу, и обе нужны. Файл копируется в
 * каталог библиотеки: книга, скачанная в «Загрузки», иначе живёт до первой
 * уборки. И книга записывается в список, иначе её там просто не будет —
 * список без каталога строится по тому, что открывали, а новую книгу ещё не
 * открывали ни разу.
 *
 * Возвращает строку словами: молчаливое добавление неотличимо от опечатки в
 * пути.
 */
export async function addToLibrary(
  where: string,
  library: string,
  store: StateStore,
): Promise<Added> {
  const source = resolve(where.replace(/^~(?=[/\\]|$)/, homedir()));
  let files: string[];
  try {
    files = statSync(source).isDirectory()
      ? readdirSync(source)
          .sort()
          .map((name) => join(source, name))
          .filter((full) => isBookName(full) && safeIsFile(full))
      : [source];
  } catch {
    return { text: `не нашёл: ${where}`, count: 0 };
  }
  if (!files.length) return { text: `в ${source} книг не нашлось`, count: 0 };

  // Путь к библиотеке приводим один раз: он приходит снаружи и бывает
  // относительным, а сравнивать и склеивать надо приведённый.
  const dest = resolve(library);
  mkdirSync(dest, { recursive: true });
  let added = 0;
  let skipped = 0;
  const notes: string[] = [];
  for (const file of files) {
    try {
      if (!isBookName(file)) {
        notes.push(`${basename(file)}: не похоже на книгу`);
        continue;
      }
      // Книга, уже лежащая в библиотеке, копировалась бы сама в себя — а это
      // не «ничего не делать», это обнулить файл.
      const target = join(dest, basename(file));
      if (target !== file) {
        if (existsSync(target)) {
          skipped += 1;
        } else {
          copyFileSync(file, target);
        }
      }
      const size = statSync(target).size;
      const meta = await quickMeta(new FileSource(target));
      const key = await bookKey(target, size);
      // Место не трогаем, если книгу уже читали: добавление не должно
      // отматывать её в начало.
      const known = await store.loadPosition(key);
      await store.savePosition(key, {
        block: known,
        title: meta.title || basename(target),
        author: meta.author,
        total: 0,
        path: target,
        at: Date.now() / 1000,
      });
      added += 1;
    } catch (e) {
      notes.push(`${basename(file)}: ${(e as Error).message}`);
    }
  }

  const parts: string[] = [];
  if (added) parts.push(`добавлено: ${added}`);
  if (skipped) parts.push(`уже было: ${skipped}`);
  if (notes.length) parts.push(notes.length === 1 ? notes[0]! : `не вышло: ${notes.length}`);
  return { text: parts.join(", ") || "нечего добавлять", count: added };
}

function safeIsFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
