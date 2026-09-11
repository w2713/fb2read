/**
 * Размер текста: шаги, пределы и чтение из настроек.
 *
 * Настройка мелкая, а испортить чтение ею проще всего: заворот на краю списка
 * делает текст нечитаемым одним лишним нажатием, а мусор в настройках — при
 * первом же запуске.
 */

import { describe, expect, it } from "vitest";
import {
  COLUMN_WIDTHS,
  DEFAULT_COLUMN,
  DEFAULT_COUNT,
  DEFAULT_SPACING,
  DEFAULT_TEXT,
  TEXT_SIZES,
  atEdge,
  columnCount,
  columnWidth,
  flagOf,
  lineHeight,
  nextSpacing,
  spacingOf,
  stepColumn,
  stepSize,
  textSize,
} from "../src/look.js";

describe("размер текста", () => {
  it("шаг ведёт по списку в обе стороны", () => {
    expect(stepSize(1.125, 1)).toBe(1.25);
    expect(stepSize(1.125, -1)).toBe(1.0625);
  });

  it("на краях список не заворачивается", () => {
    // Иначе «крупнее» на самом крупном давало бы самый мелкий — одно лишнее
    // нажатие, и книгу не прочесть.
    const крупнейший = TEXT_SIZES[TEXT_SIZES.length - 1]!;
    const мельчайший = TEXT_SIZES[0]!;
    expect(stepSize(крупнейший, 1)).toBe(крупнейший);
    expect(stepSize(мельчайший, -1)).toBe(мельчайший);
  });

  it("край виден заранее", () => {
    expect(atEdge(TEXT_SIZES[TEXT_SIZES.length - 1]!, 1)).toBe(true);
    expect(atEdge(TEXT_SIZES[0]!, -1)).toBe(true);
    expect(atEdge(DEFAULT_TEXT, 1)).toBe(false);
    expect(atEdge(DEFAULT_TEXT, -1)).toBe(false);
  });

  it("шаг от размера не из списка идёт от ближайшего", () => {
    // Размер мог прийти из чужой версии, где список был другим.
    expect(stepSize(1.2, 1)).toBe(1.375);
    expect(stepSize(1.2, -1)).toBe(1.125);
  });

  it("настройки прошлого раза читаются, а мусор не портит чтение", () => {
    expect(textSize(1.5)).toBe(1.5);
    expect(textSize(undefined)).toBe(DEFAULT_TEXT);
    expect(textSize("крупнее")).toBe(DEFAULT_TEXT);
    expect(textSize(Number.NaN)).toBe(DEFAULT_TEXT);
    // Сорок рем — не размер для чтения, откуда бы он ни взялся.
    expect(textSize(40)).toBe(TEXT_SIZES[TEXT_SIZES.length - 1]);
    expect(textSize(0)).toBe(TEXT_SIZES[0]);
  });

  it("размер по умолчанию — тот, что был до появления настройки", () => {
    // Иначе у всех, кто уже читает, текст поехал бы при обновлении.
    expect(DEFAULT_TEXT).toBe(1.125);
    expect(TEXT_SIZES).toContain(DEFAULT_TEXT);
  });
});

describe("ширина колонки", () => {
  it("шаг ведёт по списку и на краях не заворачивается", () => {
    expect(stepColumn(34, 1)).toBe(38);
    expect(stepColumn(34, -1)).toBe(30);
    expect(stepColumn(COLUMN_WIDTHS[COLUMN_WIDTHS.length - 1]!, 1)).toBe(44);
    expect(stepColumn(COLUMN_WIDTHS[0]!, -1)).toBe(26);
  });

  it("по умолчанию колонка та же, что была до настройки", () => {
    // Иначе у всех, кто уже читает, при обновлении съедет вёрстка.
    expect(columnWidth(undefined)).toBe(34);
    expect(DEFAULT_COLUMN).toBe(34);
  });

  it("мусор в настройках притягивается к списку", () => {
    expect(columnWidth("широкая")).toBe(34);
    expect(columnWidth(31)).toBe(30);
    expect(columnWidth(1000)).toBe(44);
  });
});

describe("число колонок", () => {
  it("по умолчанию — сколько поместится", () => {
    expect(columnCount(undefined)).toBe(0);
    expect(DEFAULT_COUNT).toBe(0);
  });

  it("свои числа берутся, чужие — нет", () => {
    expect(columnCount(3)).toBe(3);
    // Семь колонок из чужой версии не притягиваются к четырём, а отбрасываются:
    // «сколько поместится» — ответ, годный для любой записи.
    expect(columnCount(7)).toBe(0);
    expect(columnCount(1)).toBe(0);
  });
});

describe("межстрочный интервал", () => {
  it("обычный интервал — тот, которым верстали до настройки", () => {
    expect(lineHeight(DEFAULT_SPACING)).toBe(1.65);
    expect(spacingOf(undefined)).toBe(DEFAULT_SPACING);
  });

  it("интервалы идут по возрастанию", () => {
    expect(lineHeight(1)).toBeLessThan(lineHeight(2));
    expect(lineHeight(2)).toBeLessThan(lineHeight(3));
  });

  it("перебор идёт по кругу — как клавиша s в терминале", () => {
    expect(nextSpacing(1)).toBe(2);
    expect(nextSpacing(2)).toBe(3);
    expect(nextSpacing(3)).toBe(1);
  });
});

describe("выключка и переносы", () => {
  it("чего не было в записи — остаётся как было", () => {
    // В браузерной читалке выключка и переносы работали с самого начала, и
    // отсутствие записи значит «как было», а не «выключено».
    expect(flagOf(undefined, true)).toBe(true);
    expect(flagOf(null, true)).toBe(true);
  });

  it("записанный отказ слушается", () => {
    expect(flagOf(false, true)).toBe(false);
    expect(flagOf(true, false)).toBe(true);
  });
});
