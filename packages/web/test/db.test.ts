/**
 * Хранилище состояния в браузере.
 *
 * IndexedDB здесь поддельная, но настоящая по поведению: тот же обход версий,
 * те же транзакции. Проверяется то, что обещает интерфейс из ядра, — и то,
 * ради чего он вообще асинхронный.
 */

import "fake-indexeddb/auto";
import type { SyncState } from "@fb2read/core";
import { beforeEach, describe, expect, it } from "vitest";
import { IdbStore } from "../src/db.js";

/** Каждому тесту своя база: иначе они видят чужие записи. */
let counter = 0;
let store: IdbStore;
const КНИГА = "a".repeat(64);
const ДРУГАЯ = "b".repeat(64);

beforeEach(() => {
  store = new IdbStore(`проба-${++counter}`);
});

const record = (block: number) => ({
  block,
  title: "Анна Каренина",
  author: "Лев Толстой",
  total: 500,
  path: "",
  at: Date.now() / 1000,
  hash: КНИГА,
});

describe("позиция", () => {
  it("незнакомая книга открывается с начала", async () => {
    expect(await store.loadPosition(КНИГА)).toBe(0);
  });

  it("сохраняется и читается обратно", async () => {
    await store.savePosition(КНИГА, record(120));
    expect(await store.loadPosition(КНИГА)).toBe(120);
  });

  it("переживает переоткрытие базы", async () => {
    // Ради этого всё и затевалось: закрыл вкладку — вернулся на то же место.
    const name = `переоткрытие-${++counter}`;
    await new IdbStore(name).savePosition(КНИГА, record(77));
    expect(await new IdbStore(name).loadPosition(КНИГА)).toBe(77);
  });

  it("у каждой книги своя", async () => {
    await store.savePosition(КНИГА, record(120));
    expect(await store.loadPosition(ДРУГАЯ)).toBe(0);
  });

  it("не теряет закладки при записи позиции", async () => {
    // Позиция пишется на каждой прокрутке, а закладки к ней отношения не имеют.
    await store.saveBookmarks(КНИГА, [{ block: 5, at: 1, name: "мысль" }], { title: "Книга" });
    await store.savePosition(КНИГА, record(300));
    expect((await store.loadBookmarks(КНИГА)).map((m) => m.name)).toEqual(["мысль"]);
  });
});

describe("закладки", () => {
  it("сохраняются по порядку блоков", async () => {
    await store.saveBookmarks(
      КНИГА,
      [
        { block: 9, at: 2 },
        { block: 3, at: 1 },
      ],
      { title: "Книга" },
    );
    expect((await store.loadBookmarks(КНИГА)).map((m) => m.block)).toEqual([3, 9]);
  });

  it("мусор в записи не рушит чтение", async () => {
    await store.saveBookmarks(КНИГА, [null, { block: 4, at: 1 }] as never, { title: "Книга" });
    expect((await store.loadBookmarks(КНИГА)).map((m) => m.block)).toEqual([4]);
  });
});

describe("настройки", () => {
  it("пустые, пока ничего не выбрано", async () => {
    expect(await store.loadSettings()).toEqual({});
  });

  it("дописываются, а не затирают друг друга", async () => {
    await store.saveSettings({ theme: "night" });
    await store.saveSettings({ spacing: 2 });
    expect(await store.loadSettings()).toEqual({ theme: "night", spacing: 2 });
  });
});

describe("состояние с сервера", () => {
  const пришло = (patch: Partial<SyncState> = {}): SyncState => ({
    hash: КНИГА,
    block: 250,
    total: 500,
    title: "Анна Каренина",
    author: "Лев Толстой",
    at: 2000,
    bookmarks: [],
    ...patch,
  });

  it("ложится в запись книги", async () => {
    await store.applyState(КНИГА, пришло());
    expect(await store.loadPosition(КНИГА)).toBe(250);
  });

  it("сливает закладки, а не затирает местные", async () => {
    // Между отправкой и ответом читатель мог поставить ещё одну.
    await store.saveBookmarks(КНИГА, [{ block: 3, at: 100, name: "моя" }], { title: "Книга" });
    await store.applyState(КНИГА, пришло({ bookmarks: [{ block: 7, at: 200, name: "с телефона" }] }));
    const marks = await store.loadBookmarks(КНИГА);
    expect(marks.map((m) => m.name).sort()).toEqual(["моя", "с телефона"]);
  });

  it("надгробие с сервера побеждает местную закладку", async () => {
    await store.saveBookmarks(КНИГА, [{ block: 3, at: 100, name: "моя" }], { title: "Книга" });
    await store.applyState(КНИГА, пришло({ bookmarks: [{ block: 3, at: 300, deleted: true }] }));
    const marks = await store.loadBookmarks(КНИГА);
    expect(marks.filter((m) => !m.deleted)).toEqual([]);
  });
});

describe("недавние", () => {
  it("самые свежие сверху", async () => {
    await store.savePosition(КНИГА, { ...record(10), at: 100 });
    await store.savePosition(ДРУГАЯ, { ...record(20), at: 200, hash: ДРУГАЯ });
    expect((await store.recent()).map((e) => e.path)).toEqual([ДРУГАЯ, КНИГА]);
  });

  it("считают прочитанный процент", async () => {
    await store.savePosition(КНИГА, record(250));
    expect((await store.recent())[0]!.percent).toBe(50);
  });
});

describe("книги на полке", () => {
  const байты = (text: string) => new Blob([new TextEncoder().encode(text)]);
  const описание = (hash: string, extra = {}) => ({
    hash,
    name: "Каренина.fb2",
    title: "Анна Каренина",
    author: "Лев Толстой",
    size: 12,
    addedAt: 1000,
    ...extra,
  });

  it("книга кладётся и читается обратно", async () => {
    await store.putBook(описание(КНИГА), байты("это книга"));
    const back = await store.bookFile(КНИГА);
    expect(await back!.text()).toBe("это книга");
    expect((await store.bookMeta(КНИГА))!.title).toBe("Анна Каренина");
  });

  it("та же книга второй раз не удваивается", async () => {
    await store.putBook(описание(КНИГА), байты("это книга"));
    await store.putBook(описание(КНИГА, { name: "другое имя.fb2" }), байты("это книга"));
    const { books } = await store.shelf();
    expect(books).toHaveLength(1);
    // Имя обновилось, а время добавления осталось прежним: книга на полке давно.
    expect(books[0]).toMatchObject({ name: "другое имя.fb2", addedAt: 1000 });
  });

  it("удаление убирает и описание, и байты", async () => {
    await store.putBook(описание(КНИГА), байты("это книга"));
    await store.dropBook(КНИГА);
    expect(await store.bookMeta(КНИГА)).toBeNull();
    expect(await store.bookFile(КНИГА)).toBeNull();
  });

  it("удаление книги не трогает место и закладки", async () => {
    // Место занимает считаные байты, а синхронизация на нём держится: вернув
    // ту же книгу, читатель должен попасть туда, где бросил.
    await store.putBook(описание(КНИГА), байты("это книга"));
    await store.savePosition(КНИГА, record(300));
    await store.saveBookmarks(КНИГА, [{ block: 42, name: "тут" }], {});
    await store.dropBook(КНИГА);

    expect(await store.loadPosition(КНИГА)).toBe(300);
    expect(await store.loadBookmarks(КНИГА)).toHaveLength(1);
  });

  it("снятая книга запоминается снятой", async () => {
    // Ради этого список и заведён: без отметки обмен видит, что книги нет, и
    // добросовестно скачивает её обратно — «убрать» не работает вовсе.
    await store.putBook(описание(КНИГА), байты("это книга"));
    expect(await store.dropped()).toEqual(new Set());

    await store.dropBook(КНИГА);
    expect(await store.dropped()).toEqual(new Set([КНИГА]));
  });

  it("отметка о снятии переживает переоткрытие базы", async () => {
    // Иначе она пропадала бы при каждом запуске, а книга возвращалась.
    const name = `снятая-${++counter}`;
    const before = new IdbStore(name);
    await before.putBook(описание(КНИГА), байты("это книга"));
    await before.dropBook(КНИГА);
    await before.close();

    const after = new IdbStore(name);
    expect(await after.dropped()).toEqual(new Set([КНИГА]));
    await after.close();
  });

  it("возврат книги снимает отметку", async () => {
    await store.putBook(описание(КНИГА), байты("это книга"));
    await store.dropBook(КНИГА);
    await store.undrop(КНИГА);
    expect(await store.dropped()).toEqual(new Set());
  });

  it("снятие одной книги не трогает другие", async () => {
    await store.putBook(описание(КНИГА), байты("раз"));
    await store.putBook(описание(ДРУГАЯ), байты("два"));
    await store.dropBook(КНИГА);
    expect(await store.dropped()).toEqual(new Set([КНИГА]));
    expect(await store.bookMeta(ДРУГАЯ)).not.toBeNull();
  });

  it("полка отдаёт книги вместе с их местами", async () => {
    await store.putBook(описание(КНИГА), байты("раз"));
    await store.putBook(описание(ДРУГАЯ), байты("два"));
    await store.savePosition(КНИГА, record(120));

    const { books, states } = await store.shelf();
    expect(books.map((b) => b.hash).sort()).toEqual([КНИГА, ДРУГАЯ].sort());
    // Запись о месте только у той книги, которую открывали.
    expect(states).toHaveLength(1);
    expect(states[0]!.hash).toBe(КНИГА);
  });
});

describe("переход на вторую версию базы", () => {
  it("книги появляются, а места и закладки остаются", async () => {
    // База могла остаться от прошлого выпуска: стереть при обновлении места и
    // закладки — ровно то, чего читатель не простит.
    const name = `старая-${++counter}`;
    const before = new IdbStore(name);
    await before.savePosition(КНИГА, record(77));
    await before.saveBookmarks(КНИГА, [{ block: 5, name: "закладка" }], {});
    await before.close();

    const after = new IdbStore(name);
    expect(await after.loadPosition(КНИГА)).toBe(77);
    expect(await after.loadBookmarks(КНИГА)).toHaveLength(1);
    await after.putBook(
      { hash: ДРУГАЯ, name: "к.fb2", title: "К", author: "", size: 3, addedAt: 1 },
      new Blob(["три"]),
    );
    expect(await after.bookFile(ДРУГАЯ)).not.toBeNull();
  });
});
