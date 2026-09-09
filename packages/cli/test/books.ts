/**
 * Книги-образцы для проверок интерфейса.
 *
 * Здесь нужна не та книга, что при проверке разбора: важнее длина для
 * перелистывания, сноска для перехода, начертание для проверки курсива и
 * картинка для щелчка по ней.
 */

import { zipSync } from "fflate";
import { Book, MemorySource, encodeLegacy } from "@fb2read/core";

/**
 * Настоящая PNG 1×1: протокол kitty принимает только этот формат и
 * проверяет подпись файла, поэтому выдумать байты нельзя.
 */
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const HEAD =
  '<?xml version="1.0" encoding="{enc}"?>' +
  '<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0" ' +
  'xmlns:l="http://www.w3.org/1999/xlink">';

/** Книга со всеми видами разметки: сноска, курсив, картинка, две главы. */
export const SAMPLE =
  HEAD.replace("{enc}", "windows-1251") +
  "<description><title-info>" +
  "<author><first-name>Иван</first-name><last-name>Тестов</last-name></author>" +
  "<book-title>Проверка читалки</book-title>" +
  '<sequence name="Опыты" number="2"/>' +
  "</title-info></description>" +
  "<body>" +
  "<title><p>Проверка читалки</p></title>" +
  "<section><title><p>Глава первая</p></title>" +
  "<p>Абзац с <emphasis>курсивом</emphasis> и <strong>полужирным</strong>, " +
  'а также сноской<a l:href="#n1" type="note">[1]</a> в конце.</p>' +
  "<p>Второй абзац с ключесловом внутри и кавычками «ёлочками».</p>" +
  '<image l:href="#pic1"/>' +
  "</section>" +
  "<section><title><p>Глава вторая</p></title>" +
  Array.from({ length: 60 }, (_, i) => `<p>Абзац номер ${i} второй главы.</p>`).join("") +
  "</section>" +
  "<section><title><p>Глава третья</p></title>" +
  Array.from({ length: 60 }, (_, i) => `<p>Строка ${i} третьей главы.</p>`).join("") +
  "</section>" +
  "</body>" +
  '<body name="notes"><section id="n1"><title><p>1</p></title>' +
  "<p>Это текст сноски.</p></section></body>" +
  '<binary id="pic1" content-type="image/png">iVBORw0KGgo=</binary>' +
  "</FictionBook>";

/** Книга с иероглифами и эмодзи: проверка ширины символов на экране. */
export const WIDE =
  HEAD.replace("{enc}", "utf-8") +
  "<description><title-info><book-title>日本語 и эмодзи</book-title>" +
  "</title-info></description>" +
  "<body><section><title><p>Глава 日本語</p></title>" +
  "<p>Иероглифы 日本語 東京 大阪 и эмодзи 😀🎉 вперемешку с русским текстом.</p>" +
  "</section></body></FictionBook>";

/** Книга с настоящей PNG внутри: показ картинок проверяется на ней. */
export const PICTURE =
  HEAD.replace("{enc}", "utf-8") +
  "<description><title-info><book-title>С картинкой</book-title>" +
  "</title-info></description><body><section>" +
  "<title><p>Глава</p></title><p>Текст перед картинкой.</p>" +
  '<image l:href="#pic1"/><p>Текст после.</p></section></body>' +
  '<binary id="pic1" content-type="image/png">' +
  PNG_BASE64 +
  "</binary></FictionBook>";

export const sampleBytes = (): Uint8Array => encodeLegacy(SAMPLE, "cp1251");

export const sampleBook = (): Promise<Book> =>
  Book.open(new MemorySource("sample.fb2", sampleBytes()));

export const wideBook = (): Promise<Book> =>
  Book.open(new MemorySource("wide.fb2", new TextEncoder().encode(WIDE)));

/** EPUB 3 с оглавлением, сноской в отдельном файле и картинкой. */
export function epubBytes(): Uint8Array {
  const encoder = new TextEncoder();
  const page = (title: string, body: string) =>
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<html xmlns="http://www.w3.org/1999/xhtml" ' +
    'xmlns:epub="http://www.idpf.org/2007/ops">' +
    `<head><title>${title}</title></head><body>${body}</body></html>`;

  return zipSync({
    mimetype: encoder.encode("application/epub+zip"),
    "META-INF/container.xml": encoder.encode(
      '<?xml version="1.0"?><container version="1.0" ' +
        'xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles>' +
        '<rootfile full-path="OEBPS/content.opf" ' +
        'media-type="application/oebps-package+xml"/></rootfiles></container>',
    ),
    "OEBPS/content.opf": encoder.encode(
      '<?xml version="1.0" encoding="utf-8"?>' +
        '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">' +
        '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">' +
        "<dc:title>Пример EPUB</dc:title><dc:creator>Анна Автор</dc:creator>" +
        '<dc:identifier id="id">urn:uuid:1</dc:identifier></metadata><manifest>' +
        '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>' +
        '<item id="c1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/>' +
        '<item id="c2" href="text/ch2.xhtml" media-type="application/xhtml+xml"/>' +
        '<item id="nt" href="text/notes.xhtml" media-type="application/xhtml+xml"/>' +
        "</manifest><spine>" +
        '<itemref idref="c1"/><itemref idref="c2"/><itemref idref="nt"/>' +
        "</spine></package>",
    ),
    "OEBPS/nav.xhtml": encoder.encode(
      page(
        "Оглавление",
        '<nav epub:type="toc"><ol>' +
          '<li><a href="text/ch1.xhtml">Глава первая</a></li>' +
          '<li><a href="text/ch2.xhtml">Глава вторая</a></li>' +
          '<li><a href="text/notes.xhtml">Примечания</a></li></ol></nav>',
      ),
    ),
    "OEBPS/text/ch1.xhtml": encoder.encode(
      page(
        "Глава 1",
        "<h1>Глава первая</h1><p>Абзац с ключесловом и " +
          '<em>курсивом</em>, а также сноской<a epub:type="noteref" ' +
          'href="notes.xhtml#n1">[1]</a> в конце.</p>' +
          // Книга должна быть длиннее экрана, иначе переходить некуда.
          Array.from({ length: 40 }, (_, i) => `<p>Строка ${i} первой главы.</p>`).join(""),
      ),
    ),
    "OEBPS/text/ch2.xhtml": encoder.encode(
      page(
        "Глава 2",
        "<h1>Глава вторая</h1><p>Текст второй главы.</p>" +
          Array.from({ length: 40 }, (_, i) => `<p>Строка ${i} второй главы.</p>`).join(""),
      ),
    ),
    "OEBPS/text/notes.xhtml": encoder.encode(
      page("Примечания", '<h1>Примечания</h1><p id="n1">Это текст сноски из EPUB.</p>'),
    ),
  });
}

export const epubBook = (): Promise<Book> =>
  Book.open(new MemorySource("book.epub", epubBytes()));
