/** Разбор FB2: метаданные, структура, начертание, починка поломок. */

import { describe, expect, it } from "vitest";
import { encodeLegacy } from "../src/encoding.js";
import {
  HEAD,
  SAMPLE,
  bookFromBody,
  bookFromBytes,
  bookFromText,
  sampleBook,
  zipped,
} from "./fixtures.js";

const texts = (book: { blocks: { text: string }[] }) =>
  book.blocks.map((b) => b.text).filter(Boolean);

describe("метаданные и кодировка", () => {
  it("читает название, автора и серию из книги в cp1251", async () => {
    const book = await sampleBook();
    expect(book.title).toBe("Проверка читалки");
    expect(book.author).toBe("Иван Тестов");
    expect(book.series).toBe("Опыты #2");
  });

  it("читает книгу из zip", async () => {
    const book = await bookFromBytes(zipped(SAMPLE), "sample.fb2.zip");
    expect(book.title).toBe("Проверка читалки");
  });
});

describe("структура книги", () => {
  it("собирает оглавление из заголовков и тела сносок", async () => {
    const titles = (await sampleBook()).toc.map((t) => t.title);
    expect(titles).toContain("Глава первая в которой всё начинается");
    expect(titles).toContain("Вложенный раздел");
    expect(titles).toContain("Примечания");
  });

  it("вложенный раздел лежит глубже соседней главы", async () => {
    const book = await sampleBook();
    const level = (name: string) => book.toc.find((t) => t.title === name)!.level;
    expect(level("Вложенный раздел")).toBeGreaterThan(level("Глава вторая"));
  });

  it("сноска ведёт на текст примечания", async () => {
    const book = await sampleBook();
    const refs = book.blocks.flatMap((b) => b.refs);
    expect(refs).toContainEqual(["[1]", "n1"]);
    const target = book.anchors["n1"]!;
    const tail = book.blocks
      .slice(target)
      .map((b) => b.text)
      .join(" ");
    expect(tail).toContain("Это текст сноски");
  });

  it("курсив и полужирный указывают на нужные слова", async () => {
    const book = await sampleBook();
    const block = book.blocks.find((b) => b.spans.length)!;
    const styles = Object.fromEntries(
      block.spans.map(([a, b, kind]) => [kind, block.text.slice(a, b)]),
    );
    expect(styles).toEqual({ em: "курсивом", strong: "полужирным" });
  });

  it("строки стихотворения не слипаются", async () => {
    const verses = (await sampleBook()).blocks.filter((b) => b.kind === "v").map((b) => b.text);
    expect(verses).toContain("Мороз и солнце; день чудесный!");
  });

  it("вложение вырезается до разбора и не попадает в текст", async () => {
    const book = await bookFromBody(
      "<body><section><p>Текст.</p></section></body>" +
        '<binary id="p1" content-type="image/jpeg">' +
        "A".repeat(50000) +
        "</binary>",
    );
    expect(book.repairs.some((n) => n.includes("вложений"))).toBe(true);
    expect(texts(book)).toEqual(["Текст."]);
  });
});

describe("починка поломок", () => {
  it.each([
    ["<body><section><p>Тула &amp; Смит & Вессон</p></section></body>", "Тула & Смит & Вессон"],
    ["<body><section><p>Слово&nbsp;и&mdash;тире</p></section></body>", "Слово и—тире"],
    ["<body><section><p>Знак &unknown; внутри</p></section></body>", "Знак &unknown; внутри"],
    ["<body><section><p>Текст\x07с\x00мусором</p></section></body>", "Текстсмусором"],
  ])("чинит %j", async (body, expected) => {
    const book = await bookFromBody(body);
    expect(texts(book)[0]).toBe(expected);
    expect(book.repairs.length).toBeGreaterThan(0);
  });

  it("отбрасывает мусор до и после документа", async () => {
    const book = await bookFromText(
      "мусор\n" +
        HEAD("utf-8") +
        "<body><section><p>Текст книги.</p></section></body></FictionBook>\nхвост",
    );
    expect(texts(book)).toEqual(["Текст книги."]);
    expect(book.repairs).toHaveLength(2);
  });

  it("определяет cp1251 без объявления в прологе", async () => {
    const text =
      '<?xml version="1.0"?>' +
      '<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0" ' +
      'xmlns:l="http://www.w3.org/1999/xlink">' +
      "<body><section><p>Текст в кодировке.</p></section></body></FictionBook>";
    const book = await bookFromBytes(encodeLegacy(text, "cp1251"));
    expect(texts(book)).toEqual(["Текст в кодировке."]);
    expect(book.repairs.some((n) => n.includes("cp1251"))).toBe(true);
  });

  it("на файле, который не книга, честно говорит об этом", async () => {
    await expect(bookFromText("это просто текст, а не книга")).rejects.toThrow();
  });
});
