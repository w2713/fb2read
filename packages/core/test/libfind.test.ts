/**
 * Поиск по библиотеке: пределы, порядок и слова о ходе дела.
 *
 * Сам поиск — в ядре и проверен там; здесь то, что решается про библиотеку целиком.
 */

import { describe, expect, it } from "vitest";
import { MIN_QUERY, PER_BOOK, capHits, findOrder, progressLine, worthFinding } from "../src/libfind.js";

/** Книга для перебора: важно в ней только время последнего чтения. */
function entry(title: string, at: number): { title: string; at: number } {
  return { title, at };
}

describe("стоит ли искать", () => {
  it("одна буква — не запрос", () => {
    // Совпадёт всё подряд, а стоить будет полного перебора библиотеки.
    expect(worthFinding("а")).toBe(false);
    expect(worthFinding("  о  ")).toBe(false);
  });

  it("две буквы — уже запрос: по-русски это слово", () => {
    expect(worthFinding("он")).toBe(true);
    expect(MIN_QUERY).toBe(2);
  });

  it("пустое поле не ищется", () => {
    expect(worthFinding("")).toBe(false);
    expect(worthFinding("   ")).toBe(false);
  });
});

describe("порядок обхода", () => {
  it("недавно читанные первыми", () => {
    // От порядка зависит, через сколько читатель увидит первую находку: ищут
    // обычно в том, что читают.
    const полка = [entry("Старая", 100), entry("Свежая", 300), entry("Средняя", 200)];
    expect(findOrder(полка).map((e) => e.title)).toEqual(["Свежая", "Средняя", "Старая"]);
  });

  it("исходный список не переставляется", () => {
    // Полку рисуют из него же, и перестановка на месте сдвинула бы её под
    // читателем.
    const полка = [entry("Старая", 100), entry("Свежая", 300)];
    findOrder(полка);
    expect(полка.map((e) => e.title)).toEqual(["Старая", "Свежая"]);
  });
});

describe("предел на книгу", () => {
  it("длинный список обрезается, и остаток назван", () => {
    const много = Array.from({ length: 25 }, (_, i) => i);
    const { shown, more } = capHits(много);
    expect(shown.length).toBe(PER_BOOK);
    expect(more).toBe(25 - PER_BOOK);
    expect(shown[0]).toBe(0);
  });

  it("короткий список не трогается и остатка не имеет", () => {
    const { shown, more } = capHits([1, 2, 3]);
    expect(shown).toEqual([1, 2, 3]);
    expect(more).toBe(0);
  });
});

describe("слова о ходе дела", () => {
  it("пока идёт — считаются книги", () => {
    expect(progressLine(3, 8, 12)).toBe("просмотрено 3 из 8 · нашлось 12");
    expect(progressLine(1, 8, 0)).toBe("просмотрено 1 из 8 · пока пусто");
  });

  it("когда всё просмотрено — счёт книг уже не нужен", () => {
    expect(progressLine(8, 8, 12)).toBe("нашлось 12");
    expect(progressLine(8, 8, 0)).toBe("ничего не нашлось");
  });

  it("пустая полка не притворяется, будто что-то ищет", () => {
    expect(progressLine(0, 0, 0)).toBe("ничего не нашлось");
  });
});
