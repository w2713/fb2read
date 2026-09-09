/**
 * Чтение одной книги в рамках сеанса.
 *
 * Собирает читалку и подключает к ней показ иллюстраций: рисовать картинку
 * умеет терминал, а не читалка, поэтому сюда вынесено всё, что знает про
 * протоколы и про то, чем этот терминал вообще располагает.
 */

import type { Block, Bookmark, ImageBackend } from "@fb2read/core";
import type { Session } from "./session.js";
import { Reader, type ReaderOptions } from "./reader.js";
import { detectBackend, renderImage } from "./images.js";

export interface ReadOptions extends Omit<ReaderOptions, "showImage"> {
  images: ImageBackend;
}

/** Что осталось после чтения: где остановились и с какими закладками. */
export interface ReadResult {
  block: number;
  bookmarks: Bookmark[];
  reader: Reader;
}

/**
 * Собирает читалку и подключает к ней показ иллюстраций.
 *
 * Отделено от показа, чтобы её можно было получить до того, как начнётся
 * ожидание: так стенд в тестах добирается до читалки, не заглядывая внутрь
 * сеанса.
 */
export function createReader(session: Session, options: ReadOptions): Reader {
  const backend = options.images === "auto" ? detectBackend() : options.images;

  return new Reader({
    ...options,
    requestPaint: () => session.paint(),
    showImage: async (block) => {
      const image = await options.book.imageData(block.src);
      if (!image) return "картинку не удалось прочитать";

      const caption = captionOf(block);
      const shown = await session.takeOver((write, columns, rows) => {
        // Место под подпись и запас по краям — как в эталонной реализации.
        const drawn = renderImage(write, image, backend, columns - 2, rows - 3);
        if (drawn) write(`\r\n${caption} — любая клавиша\r\n`);
        return drawn;
      });

      return shown
        ? ""
        : "терминал не умеет показывать картинки; поставьте chafa или используйте kitty/iTerm2";
    },
  });
}

/** Показывает книгу и ждёт, пока читатель её закроет. */
export async function readBook(session: Session, options: ReadOptions): Promise<ReadResult> {
  const reader = createReader(session, options);
  await session.show(reader);
  return { block: reader.currentBlock(), bookmarks: reader.bookmarks, reader };
}

/** Подпись под картинкой: альтернативный текст без скобок. */
function captionOf(block: Block): string {
  const text = block.text.replace(/^[[\s]+|[\]\s]+$/g, "").trim();
  return text || "картинка";
}
