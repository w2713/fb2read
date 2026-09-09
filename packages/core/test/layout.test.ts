/** Вёрстка: ширина, начертание в строке, интервал, хвостовые пустоты. */

import { describe, expect, it } from "vitest";
import { layout } from "../src/layout.js";
import { strWidth } from "../src/width.js";
import { bigBookParsed, sampleBook, wideBook } from "./fixtures.js";

describe("вёрстка", () => {
  it.each([
    [20, 1],
    [40, 1],
    [80, 2],
    [120, 3],
  ])("не выходит за ширину %i при интервале %i", async (width, spacing) => {
    for (const book of [await sampleBook(), await wideBook(), await bigBookParsed()]) {
      for (const line of layout(book.blocks, width, spacing)) {
        expect(strWidth(line.text)).toBeLessThanOrEqual(Math.max(width, 20));
      }
    }
  });

  it("отрезки начертания попадают внутрь своей строки", async () => {
    const book = await wideBook();
    for (const line of layout(book.blocks, 30)) {
      for (const [column, fragment] of line.styles) {
        expect(column).toBeGreaterThanOrEqual(0);
        expect(line.text).toContain(fragment);
        expect(column + strWidth(fragment)).toBeLessThanOrEqual(strWidth(line.text));
      }
    }
  });

  it("двойной интервал добавляет пустые строки, не трогая текст", async () => {
    const book = await sampleBook();
    const single = layout(book.blocks, 60, 1);
    const double = layout(book.blocks, 60, 2);
    expect(double.length).toBeGreaterThan(single.length);
    const nonEmpty = (lines: typeof single) => lines.map((l) => l.text).filter(Boolean);
    expect(nonEmpty(single)).toEqual(nonEmpty(double));
  });

  it("не оставляет пустых строк в конце", async () => {
    const lines = layout((await sampleBook()).blocks, 60);
    expect(lines[lines.length - 1]!.text.trim()).toBeTruthy();
  });

  it("каждая строка помнит свой блок", async () => {
    const book = await sampleBook();
    for (const line of layout(book.blocks, 50)) {
      expect(line.block).toBeGreaterThanOrEqual(0);
      expect(line.block).toBeLessThan(book.blocks.length);
    }
  });
});
