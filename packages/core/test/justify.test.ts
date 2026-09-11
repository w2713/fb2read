/**
 * Выключка по формату.
 *
 * Проверяется и сам ровный край, и то, что при вставке пробелов не съехало
 * начертание: отрезок курсива хранит колонку и текст, и оба меняются.
 */

import { describe, expect, it } from "vitest";
import { justify } from "../src/justify.js";
import type { LineStyle } from "../src/layout.js";
import { strWidth } from "../src/width.js";

describe("выключка", () => {
  it("правый край встаёт ровно на ширине", () => {
    const { text } = justify("аб вг де", [], 12);
    expect(strWidth(text)).toBe(12);
  });

  it("строку из одного слова не растягивают", () => {
    // Растягивать нечего: промежутков нет, и расширять пришлось бы буквы.
    const { text } = justify("слово", [], 20);
    expect(text).toBe("слово");
  });

  it("строку, уже занявшую ширину, не трогают", () => {
    const было = "аб вг де";
    expect(justify(было, [], strWidth(было)).text).toBe(было);
    expect(justify(было, [], 3).text).toBe(было);
  });

  it("красную строку не растягивают", () => {
    // Отступ задан видом блока; расширить его значит сдвинуть начало абзаца.
    const { text } = justify("   аб вг", [], 12);
    expect(text.startsWith("   аб")).toBe(true);
    expect(strWidth(text)).toBe(12);
  });

  it("неразрывный пробел остаётся собой", () => {
    // Его для того и ставят, чтобы он не разошёлся: «И. И. Иванов».
    const { text } = justify("аб вг де", [], 12);
    expect(text).toContain("аб вг");
    expect(strWidth(text)).toBe(12);
  });

  it("остаток уходит правым промежуткам", () => {
    // Иначе широкая дыра встаёт сразу после красной строки, где заметнее всего.
    // Три промежутка, добавить нужно один — он достаётся последнему.
    const { text } = justify("а б в г", [], 8);
    expect(text).toBe("а б в  г");
  });

  it("курсив остаётся на своём слове", () => {
    const было: LineStyle[] = [[3, "вг", "em"]];
    const { text, styles } = justify("аб вг де", было, 12);
    const [column, fragment] = styles[0]!;
    expect(fragment).toBe("вг");
    expect(text.slice(column, column + fragment.length)).toBe("вг");
  });

  it("курсив на двух словах вбирает разошедшийся промежуток", () => {
    // Отрезок хранит текст, которым его перерисуют поверх строки. Не добавить
    // в него те же пробелы — значит наехать на соседние буквы справа.
    const было: LineStyle[] = [[0, "аб вг", "em"]];
    const { text, styles } = justify("аб вг де", было, 12);
    const [column, fragment] = styles[0]!;
    expect(fragment).toBe("аб   вг");
    expect(text.slice(column, column + fragment.length)).toBe(fragment);
  });

  it("отрезок с широкими символами не сбивает колонку", () => {
    // Колонка считается в знакоместах, срез строки — в единицах UTF-16.
    // «日本» занимает четыре знакоместа при двух символах, поэтому «фыва»
    // начинается на пятой колонке, а не на третьей.
    const было: LineStyle[] = [[5, "фыва", "strong"]];
    const { text, styles } = justify("日本 фыва де", было, 16);
    const [column, fragment] = styles[0]!;
    expect(fragment).toBe("фыва");
    expect(strWidth(text.slice(0, text.indexOf("фыва")))).toBe(column);
  });
});
