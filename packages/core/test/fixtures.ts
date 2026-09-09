/**
 * Книги-образцы для тестов.
 *
 * Тексты те же, что в tests/conftest.py и tests/epub_data.py эталонной
 * реализации: так один и тот же случай проверяется в обеих, и расхождение
 * означает разницу в разборе, а не в исходных данных.
 */

import { zipSync } from "fflate";
import { encodeLegacy } from "../src/encoding.js";
import { MemorySource } from "../src/source.js";
import { Book } from "../src/book.js";

export const HEAD = (enc: string): string =>
  `<?xml version="1.0" encoding="${enc}"?>` +
  '<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0" ' +
  'xmlns:l="http://www.w3.org/1999/xlink">';

export const SAMPLE =
  HEAD("windows-1251") +
  `
<description><title-info>
<author><first-name>Иван</first-name><last-name>Тестов</last-name></author>
<book-title>Проверка читалки</book-title>
<sequence name="Опыты" number="2"/>
</title-info></description>
<body>
<title><p>Проверка читалки</p></title>
<epigraph><p>Всякая книга есть письмо неизвестному другу.</p>
<text-author>Некто</text-author></epigraph>
<section>
<title><p>Глава первая</p><p>в которой всё начинается</p></title>
<p>Абзац с <emphasis>курсивом</emphasis> и <strong>полужирным</strong>,
а также сноской<a l:href="#n1" type="note">[1]</a> в конце. Текст должен
переноситься по словам и укладываться в заданную ширину колонки.</p>
<empty-line/>
<p>Второй абзац с ключесловом внутри, кавычками «ёлочками» и тире —.</p>
<subtitle>Подзаголовок</subtitle>
<poem><stanza><v>Мороз и солнце; день чудесный!</v>
<v>Ещё ты дремлешь, друг прелестный —</v></stanza>
<text-author>А. С. Пушкин</text-author></poem>
<cite><p>Цитата с отступом.</p><text-author>Источник</text-author></cite>
<section><title><p>Вложенный раздел</p></title><p>Текст раздела.</p></section>
</section>
<section><title><p>Глава вторая</p></title>
<p>Ещё текст для проверки прокрутки.</p>
<image l:href="#pic1"/>
<table><tr><td>Ячейка 1</td><td>Ячейка 2</td></tr></table>
</section>
</body>
<body name="notes"><section id="n1"><title><p>1</p></title>
<p>Это текст сноски.</p></section></body>
</FictionBook>`;

export const WIDE =
  HEAD("utf-8") +
  `
<description><title-info><book-title>日本語 и эмодзи</book-title>
<author><last-name>Тестов</last-name></author></title-info></description>
<body><section><title><p>Глава 日本語</p></title>
<p>Иероглифы 日本語 東京 大阪 и эмодзи 😀🎉 вперемешку с русским текстом.</p>
<p>Абзац с <emphasis>курсивом 日本</emphasis> и <strong>полужирным 東京</strong>.</p>
<p>ОченьДлинноеСловоБезПробеловКотороеПридётсяРазрезатьПоШиринеКолонки.</p>
</section></body></FictionBook>`;

/** Псевдослучайные числа с зерном: книга должна собираться одинаково всегда. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Книга на 40 глав — для проверки перелистывания и поиска. */
export function bigBook(): string {
  const rnd = mulberry32(1);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(rnd() * items.length)]!;
  const between = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
  const words = "время книга дорога вечер снег голос память город окно".split(" ");
  const parts: string[] = [];
  for (let chapter = 1; chapter <= 40; chapter++) {
    const paragraphs: string[] = [];
    for (let p = between(10, 20); p > 0; p--) {
      const sentences: string[] = [];
      for (let s = between(3, 6); s > 0; s--) {
        const line: string[] = [];
        for (let w = between(6, 12); w > 0; w--) line.push(pick(words));
        const text = line.join(" ");
        sentences.push(text.charAt(0).toUpperCase() + text.slice(1) + ".");
      }
      paragraphs.push(`<p>${sentences.join(" ")}</p>`);
    }
    parts.push(
      `<section><title><p>Глава ${chapter}</p></title>${paragraphs.join("")}</section>`,
    );
  }
  return (
    HEAD("utf-8") +
    "<description><title-info><book-title>Большая книга</book-title>" +
    "<author><last-name>Длинный</last-name></author></title-info>" +
    "</description><body><title><p>Большая книга</p></title>" +
    parts.join("") +
    "</body></FictionBook>"
  );
}

// --------------------------------------------------------------- EPUB

const CONTAINER = `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
<rootfiles><rootfile full-path="OEBPS/content.opf"
media-type="application/oebps-package+xml"/></rootfiles></container>`;

const OPF = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:title>Пример EPUB</dc:title><dc:creator>Анна Автор</dc:creator>
<dc:identifier id="id">urn:uuid:1</dc:identifier>
<meta name="calibre:series" content="Пробная серия"/></metadata>
<manifest>
<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
<item id="c1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/>
<item id="c2" href="text/ch2.xhtml" media-type="application/xhtml+xml"/>
<item id="nt" href="text/notes.xhtml" media-type="application/xhtml+xml"/>
<item id="img" href="images/cover.jpg" media-type="image/jpeg"/>
</manifest>
<spine><itemref idref="c1"/><itemref idref="c2"/><itemref idref="nt"/></spine>
</package>`;

const NAV = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>Оглавление</title></head><body>
<nav epub:type="toc"><ol>
<li><a href="text/ch1.xhtml">Глава первая</a>
  <ol><li><a href="text/ch1.xhtml#part2">Вторая часть главы</a></li></ol></li>
<li><a href="text/ch2.xhtml">Глава вторая</a></li>
<li><a href="text/notes.xhtml">Примечания</a></li>
</ol></nav></body></html>`;

const CHAPTER1 = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>Глава 1</title><link rel="stylesheet" href="../style.css"/></head>
<body><h1>Глава первая</h1>
<p>Абзац с <em>курсивом</em> и <strong>полужирным</strong>, а также
сноской<a epub:type="noteref" href="notes.xhtml#n1">[1]</a> в конце.</p>
<p>Второй абзац с ключесловом и неразрывным&#160;пробелом.</p>
<blockquote><p>Цитата с отступом.</p></blockquote>
<h2 id="part2">Вторая часть главы</h2>
<ul><li>первый пункт</li><li>второй пункт</li></ul>
<ol><li>раз</li><li>два</li></ol>
<img src="../images/cover.jpg" alt="обложка"/>
<div>Текст прямо в div без абзаца.</div>
<script>console.log("не показывать")</script>
</body></html>`;

const CHAPTER2 = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Глава 2</title></head>
<body><h1>Глава вторая</h1><p>Текст второй главы.</p></body></html>`;

const NOTES = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Примечания</title></head>
<body><h1>Примечания</h1><p id="n1">Это текст сноски из EPUB.</p></body></html>`;

const NCX = `<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
<navMap>
<navPoint id="p1" playOrder="1"><navLabel><text>Глава первая</text></navLabel>
<content src="text/ch1.xhtml"/></navPoint>
<navPoint id="p2" playOrder="2"><navLabel><text>Глава вторая</text></navLabel>
<content src="text/ch2.xhtml"/></navPoint>
</navMap></ncx>`;

const OPF_NCX = OPF.replace(
  '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
  '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>',
);

const EPUB_FILES: Record<string, string> = {
  "META-INF/container.xml": CONTAINER,
  "OEBPS/content.opf": OPF,
  "OEBPS/nav.xhtml": NAV,
  "OEBPS/text/ch1.xhtml": CHAPTER1,
  "OEBPS/text/ch2.xhtml": CHAPTER2,
  "OEBPS/text/notes.xhtml": NOTES,
};

const EPUB_FILES_NCX: Record<string, string> = {
  "META-INF/container.xml": CONTAINER,
  "OEBPS/content.opf": OPF_NCX,
  "OEBPS/toc.ncx": NCX,
  "OEBPS/text/ch1.xhtml": CHAPTER1,
  "OEBPS/text/ch2.xhtml": CHAPTER2,
  "OEBPS/text/notes.xhtml": NOTES,
};

const encoder = new TextEncoder();

function makeEpub(files: Record<string, string>): Uint8Array {
  const entries: Record<string, Uint8Array> = {
    mimetype: encoder.encode("application/epub+zip"),
    "OEBPS/images/cover.jpg": new Uint8Array([0xff, 0xd8, 0xff]),
  };
  for (const [name, text] of Object.entries(files)) entries[name] = encoder.encode(text);
  return zipSync(entries);
}

/** EPUB 3: навигация, списки, цитата и сноска в отдельном файле. */
export const epubBytes = (): Uint8Array => makeEpub(EPUB_FILES);

/** Старый EPUB 2: оглавление только в NCX. */
export const epubNcxBytes = (): Uint8Array => makeEpub(EPUB_FILES_NCX);

// -------------------------------------------------------------- картинка

/** Минимальная настоящая PNG: 8×8, красная. */
export function png(width = 8, height = 8, color = [200, 60, 60]): Uint8Array {
  const raw: number[] = [];
  for (let y = 0; y < height; y++) {
    raw.push(0);
    for (let x = 0; x < width; x++) raw.push(...color);
  }
  const table = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  const crc32 = (bytes: Uint8Array): number => {
    let c = 0xffffffff;
    for (const b of bytes) c = table[(c ^ b) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const be32 = (value: number): number[] => [
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ];
  const chunk = (tag: string, payload: number[]): number[] => {
    const body = [...encoder.encode(tag), ...payload];
    return [...be32(payload.length), ...body, ...be32(crc32(new Uint8Array(body)))];
  };
  // zlib-обёртка вокруг несжатого блока: разбор PNG нам не нужен, нужна
  // только настоящая подпись и корректные контрольные суммы.
  const adler = (bytes: number[]): number[] => {
    let a = 1;
    let b = 0;
    for (const byte of bytes) {
      a = (a + byte) % 65521;
      b = (b + a) % 65521;
    }
    return be32(((b << 16) | a) >>> 0);
  };
  const stored: number[] = [0x78, 0x01];
  for (let i = 0; i < raw.length; i += 65535) {
    const part = raw.slice(i, i + 65535);
    const last = i + 65535 >= raw.length ? 1 : 0;
    stored.push(last, part.length & 0xff, (part.length >> 8) & 0xff);
    stored.push(~part.length & 0xff, (~part.length >> 8) & 0xff);
    stored.push(...part);
  }
  stored.push(...adler(raw));

  return new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...chunk("IHDR", [...be32(width), ...be32(height), 8, 2, 0, 0, 0]),
    ...chunk("IDAT", stored),
    ...chunk("IEND", []),
  ]);
}

function base64(bytes: Uint8Array): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!;
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    out += alphabet[a >> 2];
    out += alphabet[((a & 3) << 4) | ((b ?? 0) >> 4)];
    out += b === undefined ? "=" : alphabet[((b & 15) << 2) | ((c ?? 0) >> 6)];
    out += c === undefined ? "=" : alphabet[c & 63];
  }
  return out;
}

/** FB2 с картинкой: разбор её пропускает, показ достаёт по требованию. */
export function pictureBook(): string {
  return (
    HEAD("utf-8") +
    "<description><title-info><book-title>С картинкой</book-title>" +
    "</title-info></description><body><section>" +
    "<title><p>Глава</p></title><p>Текст перед картинкой.</p>" +
    '<image l:href="#pic1"/><p>Текст после.</p></section></body>' +
    '<binary id="pic1" content-type="image/png">' +
    base64(png()) +
    "</binary></FictionBook>"
  );
}

// ------------------------------------------------------------ помощники

/** Книга из текста XML. */
export function bookFromText(text: string, name = "book.fb2"): Promise<Book> {
  return Book.open(new MemorySource(name, encoder.encode(text)));
}

/** Книга из готовых байтов: архивы и книги в других кодировках. */
export function bookFromBytes(data: Uint8Array, name = "book.fb2"): Promise<Book> {
  return Book.open(new MemorySource(name, data));
}

/** Книга из одного тела: короткая запись для проверок разбора. */
export function bookFromBody(body: string, enc = "utf-8"): Promise<Book> {
  const text = HEAD(enc) + body + "</FictionBook>";
  const bytes = enc === "utf-8" ? encoder.encode(text) : encodeLegacy(text, enc);
  return bookFromBytes(bytes);
}

/** Тот же .fb2, упакованный в zip. */
export function zipped(text: string, inner = "sample.fb2"): Uint8Array {
  return zipSync({ [inner]: encodeLegacy(text, "cp1251") });
}

export const sampleBytes = (): Uint8Array => encodeLegacy(SAMPLE, "cp1251");
export const sampleBook = (): Promise<Book> => bookFromBytes(sampleBytes(), "sample.fb2");
export const wideBook = (): Promise<Book> => bookFromText(WIDE, "wide.fb2");
export const bigBookParsed = (): Promise<Book> => bookFromText(bigBook(), "big.fb2");
export const epubBook = (): Promise<Book> => bookFromBytes(epubBytes(), "book.epub");
export const epubNcxBook = (): Promise<Book> => bookFromBytes(epubNcxBytes(), "old.epub");
export const pictureBookParsed = (): Promise<Book> =>
  bookFromText(pictureBook(), "picture.fb2");
