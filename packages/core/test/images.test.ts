/** Картинки в FB2: разбор их пропускает, показ достаёт по требованию. */

import { describe, expect, it } from "vitest";
import { pictureBookParsed } from "./fixtures.js";

describe("иллюстрации", () => {
  it("блок картинки помнит, где лежат данные", async () => {
    const block = (await pictureBookParsed()).blocks.find((b) => b.kind === "image")!;
    expect(block.src).toBe("pic1");
    expect(block.text).toBe("[ иллюстрация ]");
  });

  it("данные читаются по требованию и это настоящая PNG", async () => {
    const book = await pictureBookParsed();
    const image = await book.imageData("pic1");
    expect(image).not.toBeNull();
    expect([...image!.data.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(image!.mime).toBe("image/png");
  });

  it("на неизвестной картинке молчит, а не падает", async () => {
    expect(await (await pictureBookParsed()).imageData("нет-такой")).toBeNull();
  });

  it("base64 вложения не просачивается в текст книги", async () => {
    const all = (await pictureBookParsed()).blocks.map((b) => b.text).join(" ");
    expect(all).not.toContain("iVBOR");
    expect(all).toContain("[ иллюстрация ]");
  });
});
