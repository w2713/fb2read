/** Вёрстка: ширина, начертание в строке, интервал, хвостовые пустоты. */

import { describe, expect, it } from "vitest";
import { layout } from "../src/layout.js";
import { strWidth } from "../src/width.js";
import { bigBookParsed, bookFromBody, sampleBook, wideBook } from "./fixtures.js";

/**
 * Абзац, у которого в последней строке несколько слов.
 *
 * Это не придирка к образцу: выключка не трогает строку из одного слова —
 * растягивать в ней нечего, — и на таком абзаце проверка «последнюю не
 * растягивают» прошла бы даже со сломанным кодом. Поймано мутацией.
 */
const хвостИзНесколькихСлов = (): Promise<Awaited<ReturnType<typeof sampleBook>>> =>
  bookFromBody(
    "<body><section><p>" +
      "Раз два три четыре пять шесть семь восемь девять десять " +
      "одиннадцать двенадцать тринадцать четырнадцать пятнадцать " +
      "а тут конец" +
      "</p></section></body>",
  );

/**
 * Где в строке начинается эта колонка.
 *
 * Колонка считается в знакоместах, а срез строки — в единицах UTF-16, и на
 * широких символах это разные числа.
 */
function atColumn(text: string, column: number): number {
  let width = 0;
  let index = 0;
  for (const ch of text) {
    if (width >= column) break;
    width += strWidth(ch);
    index += ch.length;
  }
  return index;
}

/** Строки первого блока нужного вида, у которого их набралось хотя бы три. */
function строкиБлока(
  lines: ReturnType<typeof layout>,
  blocks: { kind: string }[],
  kind: string,
): ReturnType<typeof layout> {
  const счёт = new Map<number, number>();
  for (const line of lines) {
    if (blocks[line.block]?.kind !== kind || !line.text.trim()) continue;
    счёт.set(line.block, (счёт.get(line.block) ?? 0) + 1);
  }
  for (const [block, сколько] of счёт) {
    if (сколько >= 3) return lines.filter((line) => line.block === block && line.text.trim());
  }
  return [];
}

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

  it("отрезок начертания стоит ровно на своей колонке", async () => {
    // Требовать, чтобы строка просто «содержала» отрезок, недостаточно: при
    // съехавшей колонке курсив ляжет на чужие буквы, а такая проверка этого не
    // заметит. Поэтому сверяется сам срез строки по колонке.
    const book = await wideBook();
    for (const line of layout(book.blocks, 30)) {
      for (const [column, fragment] of line.styles) {
        expect(column).toBeGreaterThanOrEqual(0);
        const at = atColumn(line.text, column);
        expect(line.text.slice(at, at + fragment.length)).toBe(fragment);
        expect(column + strWidth(fragment)).toBeLessThanOrEqual(strWidth(line.text));
      }
    }
  });

  it("выключка равняет правый край, кроме последней строки абзаца", async () => {
    const book = await хвостИзНесколькихСлов();
    const ширина = 40;
    const абзац = строкиБлока(
      layout(book.blocks, ширина, 1, { justify: true }),
      book.blocks,
      "p",
    );
    expect(абзац.length).toBeGreaterThanOrEqual(3);
    for (const line of абзац.slice(0, -1)) expect(strWidth(line.text)).toBe(ширина);

    // Последнюю не растягивают: иначе конец абзаца выйдет разреженным. В ней
    // нарочно несколько слов — иначе выключке и так было бы нечего делать.
    const последняя = абзац[абзац.length - 1]!.text;
    expect(последняя.trim()).toContain(" ");
    expect(strWidth(последняя)).toBeLessThan(ширина);
  });

  it("без просьбы правый край остаётся неровным", async () => {
    // Умолчание обязано совпадать с эталонной реализацией до байта, и это
    // сверяет diff-dump.sh. Здесь — то же обещание в одну строку.
    const book = await хвостИзНесколькихСлов();
    const абзац = строкиБлока(layout(book.blocks, 40), book.blocks, "p");
    expect(абзац.length).toBeGreaterThanOrEqual(3);
    expect(абзац.slice(0, -1).every((line) => strWidth(line.text) === 40)).toBe(false);
  });

  it("стихи не выключают", async () => {
    // В стихах ровный правый край не нужен и мешает: строка кончается там, где
    // её кончил поэт.
    const book = await sampleBook();
    const было = layout(book.blocks, 20);
    const стало = layout(book.blocks, 20, 1, { justify: true });
    const стихи = (lines: typeof было) =>
      lines.filter((line) => book.blocks[line.block]?.kind === "v").map((line) => line.text);
    expect(стихи(стало)).toEqual(стихи(было));
    expect(стихи(было).length).toBeGreaterThan(0);
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
