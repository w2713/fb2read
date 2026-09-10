/**
 * Полка: порядок и подписи.
 *
 * Ни DOM, ни хранилища здесь нет — только решения о том, что читатель увидит
 * в списке своих книг.
 */

import type { PositionRecord } from "@fb2read/core";
import { describe, expect, it } from "vitest";
import type { BookMeta } from "../src/db.js";
import { bookSize, shelfOrder, whenRead } from "../src/shelf.js";

const book = (hash: string, extra: Partial<BookMeta> = {}): BookMeta => ({
  hash,
  name: `${hash}.fb2`,
  title: `Книга ${hash}`,
  author: "Автор",
  size: 1024,
  addedAt: 1000,
  ...extra,
});

const state = (hash: string, block: number, at: number): PositionRecord => ({
  block,
  title: "",
  author: "",
  total: 101,
  path: "",
  at,
  hash,
});

describe("порядок полки", () => {
  it("последнее читанное сверху", () => {
    // Книги положены давно (1000), читались позже: «c» вчера, «a» позавчера.
    const entries = shelfOrder(
      [book("a"), book("b"), book("c")],
      [state("a", 10, 5000), state("c", 10, 9000)],
    );
    // «b» не открывали вовсе — она идёт по времени, когда её положили, и
    // оказывается внизу: свежее всех тут та, которую читали вчера.
    expect(entries.map((e) => e.hash)).toEqual(["c", "a", "b"]);
  });

  it("только что положенная книга — сверху", () => {
    // Её ещё не читали, но открыть хотят именно её.
    const entries = shelfOrder(
      [book("старая"), book("новая", { addedAt: 9000 })],
      [state("старая", 10, 5000)],
    );
    expect(entries.map((e) => e.hash)).toEqual(["новая", "старая"]);
  });

  it("ни разу не открытая книга всё равно на полке", () => {
    const [entry] = shelfOrder([book("a")], []);
    expect(entry).toMatchObject({ hash: "a", percent: null, read: false, at: 1000 });
  });

  it("процент берётся из записи о месте", () => {
    const [entry] = shelfOrder([book("a")], [state("a", 50, 2000)]);
    expect(entry!.percent).toBe(50);
    expect(entry!.read).toBe(true);
  });

  it("имя файла выручает книгу без названия", () => {
    const [entry] = shelfOrder([book("a", { title: "", name: "Толстой.fb2" })], []);
    expect(entry!.title).toBe("Толстой.fb2");
  });

  it("чужая запись о месте книге не достаётся", () => {
    // Записи о местах живут дольше книг: удалённая книга свою оставляет.
    const [entry] = shelfOrder([book("a")], [state("другая", 90, 5000)]);
    expect(entry!.percent).toBeNull();
  });
});

describe("когда читали", () => {
  const день = 86_400;
  const полдень = new Date(2026, 8, 10, 12, 0, 0).getTime() / 1000;

  it("сегодня и вчера считаются по календарю", () => {
    // Книга, закрытая вчера в одиннадцать вечера, читалась вчера, а не
    // «пятнадцать часов назад».
    expect(whenRead(полдень - 3600, полдень)).toBe("сегодня");
    expect(whenRead(new Date(2026, 8, 9, 23, 0, 0).getTime() / 1000, полдень)).toBe("вчера");
  });

  it("на неделе — днями, и склонение верное", () => {
    expect(whenRead(полдень - 2 * день, полдень)).toBe("2 дня назад");
    expect(whenRead(полдень - 5 * день, полдень)).toBe("5 дней назад");
  });

  it("дальше — датой, а с прошлого года ещё и с годом", () => {
    expect(whenRead(new Date(2026, 7, 12, 10, 0, 0).getTime() / 1000, полдень)).toBe("12 августа");
    expect(whenRead(new Date(2025, 7, 12, 10, 0, 0).getTime() / 1000, полдень)).toBe(
      "12 августа 2025",
    );
  });

  it("никогда не читанная книга даты не получает", () => {
    expect(whenRead(0, полдень)).toBe("");
  });
});

describe("размер книги", () => {
  it("говорит понятными единицами", () => {
    expect(bookSize(512)).toBe("512 Б");
    expect(bookSize(2048)).toBe("2 КБ");
    expect(bookSize(5 * 1024 * 1024)).toBe("5.0 МБ");
  });
});
