/**
 * Разбор книги в отдельном потоке.
 *
 * Книга на сорок мегабайт разбирается заметное время, и делать это в основном
 * потоке значит заморозить страницу: на телефоне это выглядит как зависшее
 * приложение. Здесь же считается и отпечаток — он нужен, чтобы узнать книгу на
 * другом устройстве, и его тоже незачем считать на виду у читателя.
 *
 * Наружу уходят только простые данные: File и результат разбора переживают
 * передачу между потоками, а объект Book — нет.
 */

import { Book } from "@fb2read/core";
import { BrowserFileSource } from "./source.js";

/** Что поток отдаёт обратно: всё, что нужно показать книгу. */
export interface ParsedBook {
  title: string;
  author: string;
  series: string;
  format: string;
  hash: string;
  blocks: Book["blocks"];
  toc: Book["toc"];
  repairs: string[];
}

export interface ParseRequest {
  id: number;
  file: File;
}

export type ParseReply =
  | { id: number; ok: true; book: ParsedBook }
  | { id: number; ok: false; error: string };

self.addEventListener("message", (event: MessageEvent<ParseRequest>) => {
  const { id, file } = event.data;
  void (async () => {
    try {
      const book = await Book.open(new BrowserFileSource(file));
      const reply: ParseReply = {
        id,
        ok: true,
        book: {
          title: book.title,
          author: book.author,
          series: book.series,
          format: book.format,
          hash: book.hash,
          blocks: book.blocks,
          toc: book.toc,
          repairs: book.repairs,
        },
      };
      self.postMessage(reply);
    } catch (e) {
      // Ошибку нельзя передать как есть: между потоками ездят только данные.
      self.postMessage({ id, ok: false, error: (e as Error).message } satisfies ParseReply);
    }
  })();
});
