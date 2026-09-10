/**
 * Размер текста: шаги, пределы и чтение из настроек.
 *
 * Настройка мелкая, а испортить чтение ею проще всего: заворот на краю списка
 * делает текст нечитаемым одним лишним нажатием, а мусор в настройках — при
 * первом же запуске.
 */

import { describe, expect, it } from "vitest";
import { DEFAULT_TEXT, TEXT_SIZES, atEdge, stepSize, textSize } from "../src/look.js";

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
