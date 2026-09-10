/**
 * Добавление книги в библиотеку.
 *
 * Файлы здесь настоящие: смысл добавления в том, что книга оказывается на
 * диске в каталоге библиотеки и в списке недавнего, — а это видно только на
 * настоящей файловой системе.
 */

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bookKey } from "@fb2read/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addToLibrary } from "../src/library.js";
import { JsonFileStore } from "../src/store.js";

let dir: string;
let lib: string;
let store: JsonFileStore;

const книга = (название: string) =>
  '<?xml version="1.0" encoding="utf-8"?><FictionBook><description><title-info>' +
  `<book-title>${название}</book-title><author><last-name>Толстой</last-name></author>` +
  "</title-info></description><body><section><p>Текст.</p></section></body></FictionBook>";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fb2read-add-"));
  lib = join(dir, "библиотека");
  store = new JsonFileStore(join(dir, "positions.json"));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

function положить(имя: string, название = "Книга"): string {
  const path = join(dir, имя);
  writeFileSync(path, книга(название));
  return path;
}

describe("добавление в библиотеку", () => {
  it("копирует книгу в каталог библиотеки и заносит в список", async () => {
    const path = положить("Анна Каренина.fb2", "Анна Каренина");
    const got = await addToLibrary(path, lib, store);

    expect(got.count).toBe(1);
    expect(existsSync(join(lib, "Анна Каренина.fb2"))).toBe(true);
    // Оригинал не трогаем: человек мог указать книгу из общей папки.
    expect(existsSync(path)).toBe(true);

    const recent = await store.recent();
    expect(recent.map((e) => e.title)).toEqual(["Анна Каренина"]);
    expect(recent[0]!.author).toBe("Толстой");
  });

  it("каталогом добавляет все книги и только книги", async () => {
    положить("Первая.fb2", "Первая");
    положить("Вторая.fb2", "Вторая");
    writeFileSync(join(dir, "заметки.txt"), "не книга");

    const got = await addToLibrary(dir, lib, store);
    expect(got.count).toBe(2);
    expect(readdirSync(lib).sort()).toEqual(["Вторая.fb2", "Первая.fb2"]);
  });

  it("книгу, уже лежащую в библиотеке, не копирует саму в себя", async () => {
    // Путь к библиотеке нарочно записан криво: сравнивать надо приведённые
    // пути, а не строки, — иначе книга «копируется» сама в себя и остаётся
    // пустой. Каталог с точкой в середине — обычное дело для того, что
    // собрано из кусков программой.
    const path = положить("Тут.fb2", "Тут");
    await addToLibrary(path, lib, store);
    const кривой = join(lib, ".", "");
    const inside = join(lib, "Тут.fb2");
    const было = readFileSync(inside);

    const got = await addToLibrary(inside, кривой, store);
    expect(got.count).toBe(1);
    expect(readdirSync(lib)).toEqual(["Тут.fb2"]);
    // Содержимое цело — копирования в себя не было.
    expect(readFileSync(inside)).toEqual(было);
    // И сказано про неё правильно: книга не «уже была» где-то ещё, она
    // ровно там, куда её и кладут.
    expect(got.text).toBe("добавлено: 1");
  });

  it("не отматывает в начало книгу, которую уже читали", async () => {
    // Добавление — не открытие: место должно остаться там, где его бросили.
    const path = положить("Читанная.fb2", "Читанная");
    await addToLibrary(path, lib, store);
    const внутри = join(lib, "Читанная.fb2");
    // Ключ считается ровно так же, как в самой читалке: по пути и размеру
    // файла в байтах. Взять тут длину строки — и проверка пройдёт вхолостую,
    // потому что ключ окажется чужим.
    const k = await bookKey(внутри, statSync(внутри).size);
    await store.savePosition(k, {
      block: 42,
      title: "Читанная",
      author: "",
      total: 100,
      path: внутри,
      at: 1,
    });
    expect(await store.loadPosition(k)).toBe(42);

    await addToLibrary(path, lib, store);
    expect(await store.loadPosition(k)).toBe(42);
  });

  it("повторное добавление того же файла не плодит копий", async () => {
    const path = положить("Одна.fb2", "Одна");
    await addToLibrary(path, lib, store);
    const got = await addToLibrary(path, lib, store);
    expect(got.text).toContain("уже было");
    expect(readdirSync(lib)).toEqual(["Одна.fb2"]);
  });

  it("опечатку в пути объясняет словами, а не молчит", async () => {
    const got = await addToLibrary(join(dir, "нет-такой.fb2"), lib, store);
    expect(got.count).toBe(0);
    expect(got.text).toContain("не нашёл");
  });

  it("файл, не похожий на книгу, называет прямо", async () => {
    const path = join(dir, "письмо.txt");
    writeFileSync(path, "здравствуйте");
    const got = await addToLibrary(path, lib, store);
    expect(got.count).toBe(0);
    expect(got.text).toContain("не похоже на книгу");
  });
});
