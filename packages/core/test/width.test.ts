/** Ширина строк и перенос по словам. */

import { describe, expect, it } from "vitest";
import { cutToWidth, strWidth } from "../src/width.js";
import { wrapWords } from "../src/wrap.js";

describe("ширина строк", () => {
  it.each([
    ["日本語", 6],
    ["😀", 2],
    ["е́", 1], // буква с комбинирующим ударением
    ["обычный текст", 13],
    ["", 0],
  ])("ширина %j равна %i", (text, width) => {
    expect(strWidth(text)).toBe(width);
  });

  it("обрезка никогда не переливается через край", () => {
    const text = "Текст 日本語 с 😀 эмодзи";
    for (let limit = 0; limit < 24; limit++) {
      expect(strWidth(cutToWidth(text, limit))).toBeLessThanOrEqual(limit);
    }
  });
});

describe("перенос по словам", () => {
  it("держит ширину и возвращает точные срезы исходного текста", () => {
    const text =
      "Иероглифы 日本語 東京 大阪 и эмодзи 😀🎉 вперемешку " +
      "с обычным русским текстом для проверки переноса";
    for (let width = 8; width < 60; width++) {
      for (const [line, offset] of wrapWords(text, width)) {
        expect(strWidth(line)).toBeLessThanOrEqual(width);
        expect(text.slice(offset, offset + line.length)).toBe(line);
      }
    }
  });

  it("режет слово, которое шире строки", () => {
    const word = "О".repeat(100);
    const lines = wrapWords(word, 10);
    for (const [line] of lines) expect(strWidth(line)).toBeLessThanOrEqual(10);
    expect(lines.map(([line]) => line).join("")).toBe(word);
  });

  it("считает настоящие промежутки между словами", () => {
    // Между словами может быть не один пробел — ширина считается по факту.
    for (const [line] of wrapWords("Ячейка 1  |  Ячейка 2", 12)) {
      expect(strWidth(line)).toBeLessThanOrEqual(12);
    }
  });
});
