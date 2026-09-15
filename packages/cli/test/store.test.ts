/**
 * Хранилище состояния: формат файла и стойкость к поломкам.
 *
 * Формат общий с эталонной реализацией, поэтому проверяется не только
 * «записали и прочитали», но и точная форма JSON.
 */

import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bookKey } from "@fb2read/core";
import { JsonFileStore } from "../src/store.js";

let dir: string;
let path: string;
let store: JsonFileStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fb2read-store-"));
  path = join(dir, "positions.json");
  store = new JsonFileStore(path);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const record = (block: number) => ({
  block,
  title: "Проверка читалки",
  author: "Иван Тестов",
  total: 100,
  path: "/книги/sample.fb2",
  at: 1700000000,
});

describe("позиция чтения", () => {
  it("записывается и читается обратно", async () => {
    await store.savePosition("k1", record(42));
    expect(await store.loadPosition("k1")).toBe(42);
  });

  it("у незнакомой книги равна нулю", async () => {
    expect(await store.loadPosition("нет-такой")).toBe(0);
  });

  it("кладётся в файл в том же виде, что у версии на Python", async () => {
    await store.savePosition("k1", record(42));
    const data = JSON.parse(readFileSync(path, "utf-8"));
    expect(Object.keys(data)).toEqual(["k1"]);
    expect(data.k1).toMatchObject({
      block: 42,
      title: "Проверка читалки",
      author: "Иван Тестов",
      total: 100,
      path: "/книги/sample.fb2",
      at: 1700000000,
      bookmarks: [],
    });
  });

  it("ключ книги считается по пути и размеру, как в эталоне", async () => {
    // sha1("/книги/sample.fb2:1537"), первые 16 знаков.
    expect(await bookKey("/книги/sample.fb2", 1537)).toHaveLength(16);
    expect(await bookKey("/книги/sample.fb2", 1537)).toBe(
      await bookKey("/книги/sample.fb2", 1537),
    );
    expect(await bookKey("/книги/sample.fb2", 1538)).not.toBe(
      await bookKey("/книги/sample.fb2", 1537),
    );
  });
});

describe("закладки", () => {
  it("хранятся по порядку блоков", async () => {
    await store.saveBookmarks(
      "k1",
      [
        { block: 12, name: "Глава", percent: 30 },
        { block: 3, name: "Начало", percent: 5 },
      ],
      { title: "Проверка читалки", total: 40 },
    );
    expect((await store.loadBookmarks("k1")).map((m) => m.block)).toEqual([3, 12]);
  });

  it("переживают сохранение позиции", async () => {
    await store.saveBookmarks("k1", [{ block: 7, name: "метка" }], { total: 40 });
    await store.savePosition("k1", record(25));
    expect((await store.loadBookmarks("k1")).map((m) => m.block)).toEqual([7]);
    expect(await store.loadPosition("k1")).toBe(25);
  });

  it("у незнакомой книги пусты", async () => {
    expect(await store.loadBookmarks("нет-такой")).toEqual([]);
  });

  it("испорченные записи отбрасываются, годные остаются", async () => {
    await store.saveBookmarks("k1", [{ block: 1, name: "ok" }], { total: 10 });
    const data = JSON.parse(readFileSync(path, "utf-8"));
    data.k1.bookmarks = ["мусор", { name: "без блока" }, { block: 2, name: "годная" }];
    writeFileSync(path, JSON.stringify(data), "utf-8");
    expect((await store.loadBookmarks("k1")).map((m) => m.block)).toEqual([2]);
  });
});

describe("настройки", () => {
  it("записываются и читаются", async () => {
    await store.saveSettings({ theme: "night", spacing: 2 });
    await store.saveSettings({ columns: 2 });
    expect(await store.loadSettings()).toEqual({ theme: "night", spacing: 2, columns: 2 });
  });

  it("переживают испорченный файл", async () => {
    writeFileSync(path, "{это не json", "utf-8");
    expect(await store.loadSettings()).toEqual({});
    await store.saveSettings({ theme: "day" });
    expect((await store.loadSettings()).theme).toBe("day");
  });

  it("лежат под отдельным ключом и не попадают в список книг", async () => {
    await store.saveSettings({ theme: "night" });
    expect(Object.keys(JSON.parse(readFileSync(path, "utf-8")))).toEqual(["__settings__"]);
    expect(await store.recent()).toEqual([]);
  });
});

describe("список недавних", () => {
  it("не показывает книги, которых больше нет на диске", async () => {
    await store.savePosition("k1", record(10));
    expect(await store.recent()).toEqual([]);
  });

  it("показывает существующие книги, свежие сверху", async () => {
    const first = join(dir, "первая.fb2");
    const second = join(dir, "вторая.fb2");
    writeFileSync(first, "x");
    writeFileSync(second, "x");
    await store.savePosition("k1", { ...record(10), path: first, title: "Первая", at: 1 });
    await store.savePosition("k2", { ...record(90), path: second, title: "Вторая", at: 2 });
    const recent = await store.recent();
    expect(recent.map((e) => e.title)).toEqual(["Вторая", "Первая"]);
    expect(recent[1]!.percent).toBe(10);
  });
});

describe("запись файла", () => {
  it("идёт через временное имя, а не поверх прежнего файла", async () => {
    // Прямая запись оставляет при обрыве половину файла, а в нём лежат
    // позиции и закладки всех книг разом: разбор половины не удаётся, и
    // читалка начинает с чистого листа — то есть теряет всё накопленное.
    // Переименование же атомарно: либо прежний файл, либо новый.
    //
    // Видно это по номеру узла: переименование подставляет новый файл, а
    // запись поверх оставляет прежний. На Windows номера узлов нет, и там
    // проверяется хотя бы то, что после записи не остаётся мусора.
    await store.savePosition("ключ", record(10));
    const было = statSync(path).ino;
    await store.savePosition("ключ", record(20));
    const стало = statSync(path).ino;
    if (было !== 0 && стало !== 0) expect(стало).not.toBe(было);
    expect(readdirSync(dir)).toEqual(["positions.json"]);
  });

  it("неудача записи не рушит читалку, но и не молчит", async () => {
    // Путь, которого не может быть: positions.json лежит внутри файла.
    const занято = join(dir, "файл");
    writeFileSync(занято, "не каталог");
    const упрямый = new JsonFileStore(join(занято, "positions.json"));
    await упрямый.savePosition("ключ", record(10));

    expect(упрямый.lastWriteError).toBeTruthy();
    // Читать это не мешает: книга откроется, просто с начала.
    expect(await упрямый.loadPosition("ключ")).toBe(0);
    // И мусора после себя не оставляет.
    expect(readdirSync(dir)).toEqual(["файл"]);
  });

  it("удачная запись снимает прошлую жалобу", async () => {
    // Иначе жалоба, однажды записанная, висела бы до конца работы: читалка
    // ругалась бы на каждую следующую книгу, хотя всё давно записывается.
    const занято = join(dir, "под");
    writeFileSync(занято, "не каталог");
    const упрямый = new JsonFileStore(join(занято, "positions.json"));
    await упрямый.savePosition("ключ", record(10));
    expect(упрямый.lastWriteError).toBeTruthy();

    // Помеха ушла — и следующая запись проходит.
    rmSync(занято);
    await упрямый.savePosition("ключ", record(20));
    expect(упрямый.lastWriteError).toBeNull();
    expect(await упрямый.loadPosition("ключ")).toBe(20);
  });
});
