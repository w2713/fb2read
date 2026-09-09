/**
 * Книги-образцы для проверок интерфейса.
 *
 * Здесь нужна не та книга, что при проверке разбора: важнее длина для
 * перелистывания, сноска для перехода, начертание для проверки курсива и
 * картинка для щелчка по ней.
 */

import { Book, MemorySource, encodeLegacy } from "@fb2read/core";

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

export const sampleBytes = (): Uint8Array => encodeLegacy(SAMPLE, "cp1251");

export const sampleBook = (): Promise<Book> =>
  Book.open(new MemorySource("sample.fb2", sampleBytes()));

export const wideBook = (): Promise<Book> =>
  Book.open(new MemorySource("wide.fb2", new TextEncoder().encode(WIDE)));
