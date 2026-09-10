/**
 * Порядок обхода найденного.
 *
 * Сам поиск проверен в ядре; здесь — только то, куда читатель попадёт после
 * запроса и после «дальше».
 */

import type { Match } from "@fb2read/core";
import { describe, expect, it } from "vitest";
import { firstFrom, step } from "../src/find.js";

const matches: Match[] = [
  { block: 3, offset: 0 },
  { block: 10, offset: 5 },
  { block: 10, offset: 40 },
  { block: 25, offset: 1 },
];

describe("первое совпадение", () => {
  it("ближайшее вперёд, а не начало книги", () => {
    expect(firstFrom(matches, 10)).toBe(1);
    expect(firstFrom(matches, 11)).toBe(3);
  });

  it("из начала книги — самое первое", () => {
    expect(firstFrom(matches, 0)).toBe(0);
  });

  it("после последнего — снова первое", () => {
    // Иначе поиск с конца книги не давал бы ничего, хотя совпадения есть.
    expect(firstFrom(matches, 900)).toBe(0);
  });

  it("на пустом списке не падает", () => {
    expect(firstFrom([], 7)).toBe(0);
  });
});

describe("следующее и предыдущее", () => {
  it("идёт вперёд", () => {
    expect(step(0, 1, 4)).toEqual({ index: 1, wrapped: false });
  });

  it("с конца заходит на новый круг и говорит об этом", () => {
    // Молча вернуться в начало — значит показать читателю то же самое и
    // оставить его думать, что поиск сломался.
    expect(step(3, 1, 4)).toEqual({ index: 0, wrapped: true });
  });

  it("назад с первого уводит в конец", () => {
    expect(step(0, -1, 4)).toEqual({ index: 3, wrapped: true });
  });

  it("от «ещё нигде» первое нажатие даёт первое совпадение", () => {
    expect(step(-1, 1, 4)).toEqual({ index: 0, wrapped: false });
  });

  it("на пустом списке остаётся на месте", () => {
    expect(step(0, 1, 0)).toEqual({ index: 0, wrapped: false });
  });
});
