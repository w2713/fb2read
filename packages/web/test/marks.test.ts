/**
 * Закладки в браузере.
 *
 * Правила те же, что в терминале, и проверять их надо порознь: закладка,
 * поставленная на ноутбуке, приезжает сюда через сервер, и расхождение в
 * мелочах развело бы одну и ту же книгу на двух устройствах.
 */

import { makeBlock, type Block, type Bookmark } from "@fb2read/core";
import { describe, expect, it } from "vitest";
import { liveMarks, marked, removeMark, sortedMarks, toggleMark } from "../src/marks.js";

const blocks: Block[] = [
  makeBlock("title", "Часть первая", 1),
  makeBlock("p", "Все счастливые семьи похожи друг на друга."),
  makeBlock("p", "Всё смешалось в доме Облонских."),
  makeBlock("empty", ""),
];

describe("постановка и снятие", () => {
  it("ставит закладку с подписью из текста", () => {
    const marks = toggleMark([], 1, blocks, 1000);
    expect(marks).toHaveLength(1);
    expect(marks[0]).toMatchObject({
      block: 1,
      name: "Все счастливые семьи похожи друг на друга.",
      at: 1000,
    });
    expect(marks[0]!.percent).toBeGreaterThan(0);
  });

  it("подпись берётся у ближайшего непустого блока", () => {
    // Закладка на отбивке — обычное дело: читатель встал на пустой строке.
    expect(toggleMark([], 3, blocks, 1000)[0]!.name).toBe("абзац 3");
  });

  it("снятая закладка остаётся надгробием, а не исчезает", () => {
    // Исчезни она — при следующей синхронизации её вернуло бы устройство,
    // которое о снятии не знает, и снять её стало бы невозможно вовсе.
    const set = toggleMark([], 2, blocks, 1000);
    const gone = toggleMark(set, 2, blocks, 2000);
    expect(gone).toEqual([{ block: 2, at: 2000, deleted: true }]);
    expect(liveMarks(gone)).toEqual([]);
    expect(marked(gone, 2)).toBe(false);
  });

  it("поставленная заново заменяет надгробие целиком", () => {
    const again = toggleMark(toggleMark(toggleMark([], 2, blocks, 1000), 2, blocks, 2000), 2, blocks, 3000);
    expect(again).toHaveLength(1);
    expect(again[0]).toMatchObject({ block: 2, at: 3000 });
    expect(again[0]!.deleted).toBeUndefined();
  });

  it("не трогает соседние закладки", () => {
    const two = toggleMark(toggleMark([], 1, blocks, 1000), 2, blocks, 1001);
    const one = toggleMark(two, 1, blocks, 1002);
    expect(liveMarks(one).map((m) => m.block)).toEqual([2]);
  });

  it("снятие по номеру блока делает то же самое", () => {
    const set = toggleMark([], 1, blocks, 1000);
    expect(removeMark(set, 1, 2000)).toEqual([{ block: 1, at: 2000, deleted: true }]);
  });

  it("исходный список не меняется", () => {
    // Список закладок хранится в открытой книге, и правка на месте развела бы
    // показанное на экране с записанным.
    const before: Bookmark[] = toggleMark([], 1, blocks, 1000);
    const copy = structuredClone(before);
    toggleMark(before, 2, blocks, 1001);
    removeMark(before, 1, 1002);
    expect(before).toEqual(copy);
  });
});

describe("список для показа", () => {
  it("идёт по порядку книги, а не по времени постановки", () => {
    const marks = toggleMark(toggleMark([], 2, blocks, 1000), 1, blocks, 2000);
    expect(sortedMarks(marks).map((m) => m.block)).toEqual([1, 2]);
  });

  it("надгробий в нём нет", () => {
    const marks = toggleMark(toggleMark([], 1, blocks, 1000), 1, blocks, 2000);
    expect(sortedMarks(marks)).toEqual([]);
  });
});
