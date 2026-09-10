/**
 * Разбор книги и выдача картинок в отдельном потоке.
 *
 * Книга на сорок мегабайт разбирается заметное время, и делать это в основном
 * потоке значит заморозить страницу: на телефоне это выглядит как зависшее
 * приложение. Здесь же считается и отпечаток — он нужен, чтобы узнать книгу на
 * другом устройстве.
 *
 * Разобранная книга остаётся здесь целиком, и картинки достаются отсюда же.
 * Иначе за каждой картинкой пришлось бы разбирать книгу заново — и как раз в
 * основном потоке, ради избавления от которого поток и заведён.
 *
 * Наружу уходят только простые данные: File и результат разбора переживают
 * передачу между потоками, объект Book — нет.
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
  /** Якоря сносок: идентификатор цели — номер блока с примечанием. */
  anchors: Book["anchors"];
  repairs: string[];
}

export type Request =
  // Книга едет сюда как Blob, а не как File: с полки она приходит именно так,
  // и пересобирать её в File значило бы скопировать все сорок мегабайт.
  | { id: number; kind: "parse"; data: Blob; name: string }
  | { id: number; kind: "image"; src: string };

/**
 * Просьба без номера.
 *
 * Просто `Omit<Request, "id">` не годится: над объединением он оставляет только
 * общие поля, и `file` с `src` пропадают. Здесь же снятие идёт по каждому виду
 * просьбы отдельно.
 */
export type Ask<T = Request> = T extends { id: number } ? Omit<T, "id"> : never;

export type Reply =
  | { id: number; ok: true; kind: "parse"; book: ParsedBook }
  | { id: number; ok: true; kind: "image"; image: Blob | null }
  | { id: number; ok: false; error: string };

/** Последняя разобранная книга: из неё и достаются картинки. */
let current: Book | null = null;

async function handle(request: Request): Promise<Reply> {
  if (request.kind === "parse") {
    const book = await Book.open(new BrowserFileSource(request.data, request.name));
    current = book;
    return {
      id: request.id,
      ok: true,
      kind: "parse",
      book: {
        title: book.title,
        author: book.author,
        series: book.series,
        format: book.format,
        hash: book.hash,
        blocks: book.blocks,
        toc: book.toc,
        anchors: book.anchors,
        repairs: book.repairs,
      },
    };
  }

  const image = current ? await current.imageData(request.src) : null;
  return {
    id: request.id,
    ok: true,
    kind: "image",
    // Blob собирается здесь: он переживает передачу между потоками, и основному
    // потоку остаётся только показать его, ничего не пересобирая.
    // Приведение — из-за описания Uint8Array в ядре: он объявлен над
    // ArrayBufferLike, куда формально входит и разделяемая память, которой тут
    // взяться неоткуда.
    image: image ? new Blob([image.data as BlobPart], { type: image.mime || "image/jpeg" }) : null,
  };
}

self.addEventListener("message", (event: MessageEvent<Request>) => {
  void handle(event.data).then(
    (reply) => self.postMessage(reply),
    // Ошибку нельзя передать как есть: между потоками ездят только данные.
    (e: unknown) =>
      self.postMessage({ id: event.data.id, ok: false, error: (e as Error).message } satisfies Reply),
  );
});
