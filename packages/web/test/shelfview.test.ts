/**
 * Полка: порядок, отбор и поиск по названию.
 *
 * Проверяется то, что читатель увидит в списке своих книг, когда книг там
 * десятки: чем разложено, что скрыто и находится ли книга по половине имени
 * автора.
 */

import { describe, expect, it } from "vitest";
import type { ShelfEntry } from "../src/shelf.js";
import {
  DEFAULT_KIND,
  DEFAULT_ORDER,
  DEFAULT_VIEW,
  DONE_PERCENT,
  arrangeShelf,
  inKind,
  isDone,
  isFresh,
  kindOf,
  matchBook,
  orderOf,
  shelfCounts,
} from "../src/shelfview.js";

/** Книга на полке; всё, о чём проверка не говорит, ничего не значит. */
function entry(extra: Partial<ShelfEntry> = {}): ShelfEntry {
  return {
    hash: extra.title ?? "h",
    title: "Книга",
    author: "Автор",
    percent: 10,
    at: 1000,
    read: true,
    size: 1024,
    ...extra,
  };
}

/** Полка в одну строку: так порядок читается глазом. */
function titles(entries: readonly ShelfEntry[]): string {
  return entries.map((e) => e.title).join(" ");
}

/** Как разложилась полка при таком порядке. */
function order(entries: readonly ShelfEntry[], by: "recent" | "title" | "author" | "size"): string {
  return titles(arrangeShelf(entries, { ...DEFAULT_VIEW, order: by }));
}

/** Что осталось на полке при таком отборе. */
function kept(entries: readonly ShelfEntry[], kind: "all" | "reading" | "fresh" | "done"): string {
  return titles(arrangeShelf(entries, { ...DEFAULT_VIEW, kind }));
}

describe("порядок по времени", () => {
  it("последнее читанное сверху — как было всегда", () => {
    const полка = [
      entry({ title: "Старая", at: 100 }),
      entry({ title: "Свежая", at: 300 }),
      entry({ title: "Средняя", at: 200 }),
    ];
    expect(order(полка, "recent")).toBe("Свежая Средняя Старая");
    expect(DEFAULT_ORDER).toBe("recent");
    expect(DEFAULT_KIND).toBe("all");
  });
});

describe("порядок по названию", () => {
  it("по алфавиту, и ё стоит там же, где е", () => {
    // Сравнение по знакам поставило бы «ёлку» после «Жары»: строчная ё лежит в
    // таблице далеко за прописными.
    const полка = [entry({ title: "Жара" }), entry({ title: "ёлка" }), entry({ title: "Арбуз" })];
    expect(order(полка, "title")).toBe("Арбуз ёлка Жара");
  });

  it("номера в названии идут числами, а не строками", () => {
    // «Том 10» после «Тома 2», хотя по знакам «1» меньше «2».
    const полка = [entry({ title: "Том 10" }), entry({ title: "Том 2" })];
    expect(order(полка, "title")).toBe("Том 2 Том 10");
  });

  it("одинаковые названия становятся лентой: свежее выше", () => {
    const полка = [
      entry({ title: "Сказки", hash: "старые", at: 100 }),
      entry({ title: "Сказки", hash: "свежие", at: 900 }),
    ];
    const порядок = arrangeShelf(полка, { ...DEFAULT_VIEW, order: "title" });
    expect(порядок.map((e) => e.hash)).toEqual(["свежие", "старые"]);
  });
});

describe("порядок по автору", () => {
  it("авторы по алфавиту, а книги одного автора — по названию", () => {
    const полка = [
      entry({ title: "Юность", author: "Толстой", at: 900 }),
      entry({ title: "Детство", author: "Толстой", at: 100 }),
      entry({ title: "Шинель", author: "Гоголь" }),
    ];
    // Внутри автора не лента: два тома одной книги должны стоять по порядку, а
    // не по тому, какой из них открывали позже.
    expect(order(полка, "author")).toBe("Шинель Детство Юность");
  });

  it("книга без автора уходит в конец, а не возглавляет полку", () => {
    // У самодельных файлов автора часто нет вовсе, и пустое имя по алфавиту
    // оказалось бы первым.
    const полка = [
      entry({ title: "Безымянная", author: "" }),
      entry({ title: "Шинель", author: "Гоголь" }),
    ];
    expect(order(полка, "author")).toBe("Шинель Безымянная");
  });
});

describe("порядок по размеру", () => {
  it("крупные сверху: по размеру смотрят, когда решают, что убрать", () => {
    const полка = [
      entry({ title: "Рассказ", size: 20_000 }),
      entry({ title: "Роман", size: 5_000_000 }),
    ];
    expect(order(полка, "size")).toBe("Роман Рассказ");
  });
});

describe("отборы", () => {
  const полка = [
    entry({ title: "Читаю", percent: 40, read: true }),
    entry({ title: "Только положена", percent: 0, read: true }),
    entry({ title: "С сервера", percent: null, read: false }),
    entry({ title: "Дочитанная", percent: 100, read: true }),
  ];

  it("«читаю» — начатое и недочитанное", () => {
    expect(kept(полка, "reading")).toBe("Читаю");
  });

  it("«не начатые» — и приезжие, и те, что только положили на полку", () => {
    // В браузере книгу открывают тем же движением, каким кладут на полку, —
    // значит, «открывали ли её» о нетронутости ничего не говорит.
    expect(kept(полка, "fresh")).toBe("Только положена С сервера");
    expect(isFresh(entry({ percent: 0, read: true }))).toBe(true);
    expect(isFresh(entry({ percent: null, read: false }))).toBe(true);
    expect(isFresh(entry({ percent: 1, read: true }))).toBe(false);
  });

  it("«дочитанные» — то, что дошло до конца", () => {
    expect(kept(полка, "done")).toBe("Дочитанная");
  });

  it("«все» не скрывает ничего", () => {
    expect(arrangeShelf(полка, DEFAULT_VIEW)).toHaveLength(4);
  });

  it("до конца книги процент не доходит, и порог стоит ниже сотни", () => {
    // Процент считается по абзацу у верхнего края, поэтому последний экран
    // текста остаётся ниже отметки: книга в 200 абзацев, прокрученная до самого
    // низа, показывает 95 процентов — измерено в Chromium. Числа здесь нарочно
    // свои, а не DONE_PERCENT: проверка должна говорить, где стоит порог, а не
    // повторять за кодом.
    expect(DONE_PERCENT).toBe(95);
    expect(isDone(entry({ percent: 95 }))).toBe(true);
    expect(isDone(entry({ percent: 94 }))).toBe(false);
    expect(inKind(entry({ percent: 94, read: true }), "reading")).toBe(true);
  });

  it("ни разу не открытая книга не дочитана, даже без процента", () => {
    expect(isDone(entry({ percent: null, read: false }))).toBe(false);
  });

  it("числа у отборов считаются по всей полке", () => {
    expect(shelfCounts(полка)).toEqual({ all: 4, reading: 1, fresh: 2, done: 1 });
  });
});

describe("поиск по названию и автору", () => {
  const книга = entry({ title: "Ёлки-палки", author: "Лев Толстой" });

  it("регистр не важен, ё и е — одна буква", () => {
    expect(matchBook(книга, "елки")).toBe(true);
    expect(matchBook(книга, "ЁЛКИ")).toBe(true);
    expect(matchBook(книга, "толстой")).toBe(true);
  });

  it("слова могут прийти из разных полей и в другом порядке", () => {
    // Так ищут на самом деле: помнят автора и половину названия.
    expect(matchBook(книга, "толстой палки")).toBe(true);
    expect(matchBook(книга, "палки чехов")).toBe(false);
  });

  it("пустое поле показывает всё", () => {
    expect(matchBook(книга, "")).toBe(true);
    expect(matchBook(книга, "   ")).toBe(true);
  });

  it("отбор и поиск действуют вместе", () => {
    const полка = [
      entry({ title: "Война и мир", author: "Толстой", percent: 100 }),
      entry({ title: "Детство", author: "Толстой", percent: 30 }),
      entry({ title: "Шинель", author: "Гоголь", percent: 30 }),
    ];
    const видно = arrangeShelf(полка, { order: "title", kind: "reading", query: "толстой" });
    expect(titles(видно)).toBe("Детство");
  });
});

describe("исходный список", () => {
  it("не переставляется", () => {
    // Из него же считаются числа у отборов, и перестановка на месте сдвинула бы
    // полку под читателем.
    const полка = [entry({ title: "Б", at: 100 }), entry({ title: "А", at: 900 })];
    arrangeShelf(полка, { ...DEFAULT_VIEW, order: "title" });
    expect(titles(полка)).toBe("Б А");
  });
});

describe("запомненный выбор", () => {
  it("своё значение читается", () => {
    expect(orderOf("author")).toBe("author");
    expect(kindOf("fresh")).toBe("fresh");
  });

  it("чужое не угадывается, а отбрасывается", () => {
    // В хранилище оно могло попасть из будущей версии читалки.
    expect(orderOf("по-моему")).toBe(DEFAULT_ORDER);
    expect(orderOf(undefined)).toBe(DEFAULT_ORDER);
    expect(orderOf(2)).toBe(DEFAULT_ORDER);
    expect(kindOf("всякие")).toBe(DEFAULT_KIND);
    expect(kindOf(null)).toBe(DEFAULT_KIND);
  });
});
