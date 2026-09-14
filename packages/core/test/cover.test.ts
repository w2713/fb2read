/**
 * Обложка книги.
 *
 * Она лежит не в тексте, а в описании, и до сих пор читалка её не замечала:
 * терминалу обложка не нужна, а полка в браузере была текстовой. Помечают её
 * по-разному — в FB2 через `<coverpage>`, в EPUB двумя способами, старым и
 * новым, — и здесь проверяется, что все они находятся.
 */

import { describe, expect, it } from "vitest";
import {
  bookFromBytes,
  bookFromText,
  coverBookParsed,
  epubBook,
  epubNcxBook,
  makeEpubWith,
  pictureBookParsed,
  sampleBook,
} from "./fixtures.js";

describe("обложка в FB2", () => {
  it("находится в описании книги", async () => {
    const book = await coverBookParsed();
    expect(book.cover).toBe("cover.png");
  });

  it("отдаётся байтами, и это настоящая PNG", async () => {
    const image = await (await coverBookParsed()).coverData();
    expect(image).not.toBeNull();
    expect([...image!.data.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(image!.mime).toBe("image/png");
  });

  it("у книги без обложки её нет, и спрашивать не больно", async () => {
    const book = await sampleBook();
    expect(book.cover).toBe("");
    expect(await book.coverData()).toBeNull();
  });

  it("картинка в тексте обложкой не считается", async () => {
    // В книге с иллюстрацией внутри `<coverpage>` нет — значит, и обложки нет.
    expect((await pictureBookParsed()).cover).toBe("");
  });

  it("пустой `coverpage` не выдаёт себя за обложку", async () => {
    const book = await bookFromText(
      '<?xml version="1.0" encoding="utf-8"?>' +
        '<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0" ' +
        'xmlns:l="http://www.w3.org/1999/xlink">' +
        "<description><title-info><book-title>Без картинки</book-title>" +
        "<coverpage></coverpage></title-info></description>" +
        "<body><section><p>Текст.</p></section></body></FictionBook>",
    );
    expect(book.cover).toBe("");
  });
});

describe("обложка в EPUB", () => {
  it("EPUB 3: помечена на самом файле", async () => {
    const book = await epubBook();
    expect(book.cover).toBe("OEBPS/images/cover.jpg");
  });

  it("EPUB 2: названа в метаданных по идентификатору", async () => {
    // Старый способ: `<meta name="cover" content="img"/>`.
    const book = await epubNcxBook();
    expect(book.cover).toBe("OEBPS/images/cover.jpg");
  });

  it("отдаётся байтами из архива", async () => {
    const image = await (await epubBook()).coverData();
    expect(image).not.toBeNull();
    expect([...image!.data.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
    expect(image!.mime).toBe("image/jpeg");
  });

  it("метка на странице, а не на картинке, за обложку не принимается", async () => {
    // Так бывает в старых книгах: `name="cover"` указывает на xhtml со
    // страницей обложки. Показать её как картинку нельзя.
    const book = await bookFromBytes(
      makeEpubWith((opf) =>
        opf
          .replace(' properties="cover-image"', "")
          .replace("</metadata>", '<meta name="cover" content="c1"/></metadata>'),
      ),
      "старый.epub",
    );
    expect(book.cover).toBe("");
    expect(await book.coverData()).toBeNull();
  });
});
