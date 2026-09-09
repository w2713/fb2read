/**
 * Книга: то, что получилось из файла и с чем дальше работают вёрстка и чтение.
 *
 * Картинки не грузятся при открытии — запоминается, где они лежат, и байты
 * читаются в момент показа. Поэтому книга с иллюстрациями открывается вдвое
 * быстрее и не занимает лишнюю память.
 */

import type { Block, TocEntry } from "./block.js";
import { fb2Meta, parseFb2Bodies } from "./fb2.js";
import { parseEpub } from "./epub.js";
import { guessType } from "./mime.js";
import type { ByteSource } from "./source.js";
import { parseXml } from "./xml.js";
import type { BinaryIndex } from "./repair.js";
import { isEpubData, isZip, readBookData, zipRead } from "./zip.js";
import { sha256Hex } from "./hash.js";

/** Байты картинки и её тип. */
export interface ImageData {
  data: Uint8Array;
  mime: string;
}

export class Book {
  format: "FB2" | "EPUB" = "FB2";
  title = "";
  author = "";
  series = "";
  repairs: string[] = [];
  blocks: Block[] = [];
  toc: TocEntry[] = [];
  /** Ссылка в номер блока: цели сносок. */
  anchors: Record<string, number> = {};
  /** Отпечаток содержимого: по нему книга узнаётся на другом устройстве. */
  hash = "";

  private images: BinaryIndex = {};
  private zipped = false;

  private constructor(private readonly source: ByteSource) {}

  /** Разбирает книгу из источника байтов. */
  static async open(source: ByteSource): Promise<Book> {
    const book = new Book(source);
    const raw = await source.bytes();
    book.hash = await sha256Hex(raw);

    if (isEpubData(raw)) {
      book.format = "EPUB";
      const parsed = parseEpub(raw);
      book.blocks = parsed.blocks;
      book.toc = parsed.toc;
      book.anchors = parsed.anchors;
      book.repairs = parsed.repairs;
      book.title = parsed.title;
      book.author = parsed.author;
      book.series = parsed.series;
    } else {
      book.format = "FB2";
      book.zipped = isZip(raw);
      const data = readBookData(raw);
      const parsed = parseXml(data);
      book.repairs = parsed.notes;
      book.images = parsed.images;
      const meta = fb2Meta(parsed.root);
      book.title = meta.title;
      book.author = meta.author;
      book.series = meta.series;
      const body = parseFb2Bodies(parsed.root);
      book.blocks = body.blocks;
      book.toc = body.toc;
      book.anchors = body.anchors;
    }

    // Одни и те же правки в нескольких файлах книги не повторяем.
    book.repairs = [...new Set(book.repairs)];

    if (!book.blocks.length) throw new Error("в файле не найдено текста книги");
    if (!book.title) book.title = source.name;
    return book;
  }

  /** Байты картинки и её тип; читаются только в момент показа. */
  async imageData(src: string): Promise<ImageData | null> {
    if (!src) return null;
    try {
      if (this.format === "EPUB") {
        const archive = await this.source.bytes();
        const data = zipRead(archive, src);
        return data ? { data, mime: guessType(src) } : null;
      }
      const spot = this.images[src];
      if (!spot) return null;
      // В голом FB2 читаем только нужный кусок файла; в архиве приходится
      // распаковать книгу целиком — смещения считались уже по её байтам.
      const raw = this.zipped
        ? readBookData(await this.source.bytes()).subarray(spot.start, spot.end)
        : await this.source.slice(spot.start, spot.end);
      return { data: decodeBase64(raw), mime: spot.type };
    } catch {
      return null;
    }
  }
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_INDEX = (() => {
  const table = new Int16Array(256).fill(-1);
  for (let i = 0; i < B64.length; i++) table[B64.charCodeAt(i)] = i;
  return table;
})();

/** Base64 в байты, снисходительно к переносам строк и мусору. */
function decodeBase64(input: Uint8Array): Uint8Array {
  const out = new Uint8Array(((input.length * 3) >> 2) + 3);
  let written = 0;
  let acc = 0;
  let bits = 0;
  for (const byte of input) {
    const value = B64_INDEX[byte]!;
    if (value < 0) continue; // перевод строки, пробел, «=» — всё пропускаем
    acc = (acc << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[written++] = (acc >> bits) & 0xff;
    }
  }
  return out.subarray(0, written);
}
