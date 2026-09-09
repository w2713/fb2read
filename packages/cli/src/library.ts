/**
 * Список книг: каталог на диске и недавно читанное.
 *
 * Автор и название достаются без полного разбора, поэтому список строится
 * быстро даже на каталоге в сотню книг.
 */

import { readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { isBookName, quickMeta, type RecentEntry, type StateStore } from "@fb2read/core";
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

/** Список книг текстом — когда вывод идёт в файл или конвейер. */
export function libraryLines(entries: readonly LibraryEntry[]): string[] {
  return entries.map((e) => {
    const percent = e.percent === null ? "-" : String(e.percent);
    return `${percent.padStart(4)}  ${e.title}  (${e.path})`;
  });
}
