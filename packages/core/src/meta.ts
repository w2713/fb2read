/**
 * Быстрые метаданные: автор и название без разбора книги целиком.
 *
 * Список книг в каталоге строится по сотням файлов, и полный разбор каждого
 * занял бы секунды. Здесь по началу файла работают регулярные выражения —
 * этого хватает, чтобы показать список сразу.
 */

import type { ByteSource } from "./source.js";
import { decode, declaredEncoding } from "./encoding.js";
import { attr, iter, parseXml, textOf } from "./xml.js";
import { isZip, isEpubData, readBookData, zipRead } from "./zip.js";

/** Расширения, которые читалка считает книгами. */
export const BOOK_SUFFIXES = [".fb2", ".fb2.zip", ".fbz", ".epub"] as const;

const TITLE_RE = /<book-title[^>]*>([\s\S]*?)<\/book-title>/;
const AUTHOR_RE = /<author>([\s\S]*?)<\/author>/;
const NAME_RE = /<(first-name|middle-name|last-name|nickname)[^>]*>([\s\S]*?)<\/\1>/g;

const HEAD_BYTES = 300_000;

/** Название и автор. */
export interface QuickMeta {
  title: string;
  author: string;
}

/** Похоже ли имя файла на книгу. */
export function isBookName(name: string): boolean {
  const low = name.toLowerCase();
  return BOOK_SUFFIXES.some((suffix) => low.endsWith(suffix));
}

/** Автор и название из описания EPUB, без разбора всей книги. */
export function epubMeta(archive: Uint8Array): QuickMeta {
  try {
    const containerData = zipRead(archive, "META-INF/container.xml");
    if (!containerData) return { title: "", author: "" };
    const container = parseXml(containerData).root;
    const rootfile = [...iter(container)].find(
      (el) => el.tag === "rootfile" && attr(el, "full-path"),
    );
    if (!rootfile) return { title: "", author: "" };
    const opfData = zipRead(archive, attr(rootfile, "full-path"));
    if (!opfData) return { title: "", author: "" };
    const opf = parseXml(opfData).root;
    let title = "";
    let author = "";
    for (const el of iter(opf)) {
      if (el.tag === "title" && !title) title = textOf(el);
      else if (el.tag === "creator" && !author) author = textOf(el);
    }
    return { title, author };
  } catch {
    return { title: "", author: "" };
  }
}

/** Быстро достаёт автора и название. */
export async function quickMeta(source: ByteSource): Promise<QuickMeta> {
  let head: Uint8Array;
  try {
    // У голого файла хватает начала; архив приходится прочитать целиком,
    // зато распаковывается из него только сама книга.
    const probe = await source.slice(0, 4);
    if (isZip(probe)) {
      const whole = await source.bytes();
      if (isEpubData(whole)) return epubMeta(whole);
      head = readBookData(whole).subarray(0, HEAD_BYTES);
    } else {
      head = await source.slice(0, HEAD_BYTES);
    }
  } catch {
    return { title: "", author: "" };
  }

  const declared = declaredEncoding(head.subarray(0, 200));
  const encodings = [...(declared ? [declared] : []), "utf-8", "cp1251"];
  let text = "";
  for (const enc of encodings) {
    try {
      text = decode(head, enc, false); // без строгости: хвост обрезан посередине
      break;
    } catch {
      continue;
    }
  }

  const titleMatch = TITLE_RE.exec(text);
  const title = titleMatch ? titleMatch[1]!.replace(/\s+/g, " ").trim() : "";
  let author = "";
  const authorMatch = AUTHOR_RE.exec(text);
  if (authorMatch) {
    NAME_RE.lastIndex = 0;
    const parts: string[] = [];
    for (let m = NAME_RE.exec(authorMatch[1]!); m; m = NAME_RE.exec(authorMatch[1]!)) {
      parts.push(m[2]!.replace(/\s+/g, " ").trim());
    }
    author = parts.filter(Boolean).join(" ");
  }
  return { title, author };
}
