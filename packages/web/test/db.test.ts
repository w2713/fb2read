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
