/** EPUB: порядок чтения, оглавление, сноски между файлами, списки, картинки. */

import { describe, expect, it } from "vitest";
import { layout } from "../src/layout.js";
import { epubMeta } from "../src/meta.js";
import { strWidth } from "../src/width.js";
import { isEpubData } from "../src/zip.js";
import {
  bookFromBytes,
  epubBook,
  epubBytes,
  epubNcxBook,
  sampleBytes,
} from "./fixtures.js";

const texts = (book: { blocks: { text: string }[] }) =>
  book.blocks.map((b) => b.text).filter(Boolean);

describe("EPUB", () => {
  it("узнаётся по содержимому, а не по имени", async () => {
    expect(isEpubData(epubBytes())).toBe(true);
    expect(isEpubData(sampleBytes())).toBe(false);
    expect((await epubBook()).format).toBe("EPUB");
    expect((await bookFromBytes(sampleBytes())).format).toBe("FB2");
  });

  it("читает название, автора и серию", async () => {
    const book = await epubBook();
    expect([book.title, book.author, book.series]).toEqual([
      "Пример EPUB",
      "Анна Автор",
      "Пробная серия",
    ]);
  });

  it("идёт по документам в порядке spine", async () => {
    const all = texts(await epubBook());
    expect(all.indexOf("Глава первая")).toBeLessThan(all.indexOf("Глава вторая"));
    expect(all.indexOf("Глава вторая")).toBeLessThan(all.indexOf("Примечания"));
  });

  it("берёт оглавление из nav вместе с вложенностью", async () => {
    const book = await epubBook();
    expect(book.toc.map((t) => t.title)).toEqual([
      "Глава первая",
      "Вторая часть главы",
      "Глава вторая",
      "Примечания",
    ]);
    const level = (name: string) => book.toc.find((t) => t.title === name)!.level;
    expect(level("Вторая часть главы")).toBeGreaterThan(level("Глава первая"));
  });

  it("в старом EPUB берёт оглавление из NCX", async () => {
    const titles = (await epubNcxBook()).toc.map((t) => t.title);
    expect(titles.slice(0, 2)).toEqual(["Глава первая", "Глава вторая"]);
  });

  it("сноска ведёт в соседний файл книги", async () => {
    const book = await epubBook();
    const [marker, target] = book.blocks.flatMap((b) => b.refs)[0]!;
    expect(marker).toBe("[1]");
    expect(book.blocks[book.anchors[target]!]!.text).toBe("Это текст сноски из EPUB.");
  });

  it("курсив и полужирный доходят из XHTML", async () => {
    const book = await epubBook();
    const block = book.blocks.find((b) => b.spans.length)!;
    const styles = Object.fromEntries(
      block.spans.map(([a, b, kind]) => [kind, block.text.slice(a, b)]),
    );
    expect(styles).toEqual({ em: "курсивом", strong: "полужирным" });
  });

  it("раскладывает списки и цитату", async () => {
    const book = await epubBook();
    const all = texts(book);
    expect(all).toContain("• первый пункт");
    expect(all).toContain("1. раз");
    expect(book.blocks.find((b) => b.text === "Цитата с отступом.")!.kind).toBe("cite");
  });

  it("пропускает скрипты и оставляет текст прямо в div", async () => {
    const all = texts(await epubBook());
    expect(all.join(" ")).not.toContain("не показывать");
    expect(all).toContain("Текст прямо в div без абзаца.");
  });

  it("раскрывает числовые сущности", async () => {
    const all = texts(await epubBook()).join(" ");
    expect(all).not.toContain("&#160;");
    expect(all).toContain("неразрывным пробелом");
  });

  it("верстается и ищется так же, как FB2", async () => {
    const book = await epubBook();
    const lines = layout(book.blocks, 50);
    for (const line of lines) expect(strWidth(line.text)).toBeLessThanOrEqual(50);
    expect(lines.some((l) => l.text.includes("ключесловом"))).toBe(true);
  });

  it("картинка помнит путь и подпись", async () => {
    const block = (await epubBook()).blocks.find((b) => b.kind === "image")!;
    expect(block.src).toBe("OEBPS/images/cover.jpg");
    expect(block.text).toBe("[ обложка ]");
  });

  it("данные картинки достаются из архива", async () => {
    const book = await epubBook();
    const block = book.blocks.find((b) => b.kind === "image")!;
    const image = await book.imageData(block.src);
    expect([...image!.data]).toEqual([0xff, 0xd8, 0xff]);
    expect(image!.mime).toBe("image/jpeg");
  });

  it("метаданные читаются без разбора всей книги", () => {
    expect(epubMeta(epubBytes())).toEqual({ title: "Пример EPUB", author: "Анна Автор" });
  });

  it("на битом архиве честно сообщает об ошибке", async () => {
    const broken = epubBytes().slice(0, 200);
    await expect(bookFromBytes(broken, "broken.epub")).rejects.toThrow();
  });
});
