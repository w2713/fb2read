/**
 * Сервер синхронизации.
 *
 * Сервер поднимается по-настоящему, на свободном порту, и разговаривает с
 * настоящим SyncClient. Подделывать здесь нечего: цена ошибки — разъехавшиеся
 * позиции на двух устройствах, а такое ловится только сквозным прогоном.
 */

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { SyncClient, sha256Hex, type SyncState } from "@fb2read/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, parseTokens } from "../src/server.js";
import { Storage } from "../src/storage.js";
import { VERSION } from "../src/version.js";

const TOKEN = "b8f1c0d2e3a45f6789ab";

let server: Server;
let dir: string;
let url: string;

function client(token = TOKEN, device = "ноутбук"): SyncClient {
  return new SyncClient({ url, token, device, timeoutMs: 5000 });
}

function state(patch: Partial<SyncState> & { hash: string }): SyncState {
  return {
    block: 0,
    total: 100,
    title: "Книга",
    author: "Автор",
    at: 1_700_000_000,
    bookmarks: [],
    ...patch,
  };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "fb2read-server-"));
  server = createServer({ dir, tokens: parseTokens(`я:${TOKEN},сосед:sosedskiy-token`) });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});

describe("доступ", () => {
  it("без токена не пускает", async () => {
    const anon = new SyncClient({ url, timeoutMs: 5000 });
    await expect(anon.list()).rejects.toThrow(/токен/);
  });

  it("не пускает с чужим токеном", async () => {
    await expect(client("podobrannyj").list()).rejects.toThrow(/токен/);
  });

  it("не пускает ни с началом верного токена, ни с ним же и лишним хвостом", async () => {
    // Токены сравниваются по отпечаткам: у них всегда 32 байта, и время
    // ответа не говорит ни о длине настоящего токена, ни о том, сколько
    // символов сошлось.
    await expect(client(TOKEN.slice(0, 10)).list()).rejects.toThrow(/токен/);
    await expect(client(`${TOKEN}hvost`).list()).rejects.toThrow(/токен/);
    // А верный по-прежнему пускают.
    expect(await client(TOKEN).list()).toEqual([]);
  });

  it("не поднимается вовсе без токенов: иначе пускал бы кого угодно", () => {
    expect(() => createServer({ dir, tokens: new Map() })).toThrow(/токен/);
  });

  it("не поднимается с токеном, который не пройдёт в заголовке", () => {
    // Кириллицу в Authorization не передать: клиент упал бы невнятной
    // ошибкой, а сервер отвечал бы «нужен токен» на верный токен.
    expect(() => createServer({ dir, tokens: parseTokens("я:токен-по-русски") })).toThrow(/латиниц/);
  });

  it("клиент отказывается от такого токена сразу, а не в глубине fetch", () => {
    expect(() => new SyncClient({ url, token: "токен-по-русски" })).toThrow(/латинс/);
  });

  it("разбирает несколько токенов и обезвреживает имена каталогов", () => {
    const tokens = parseTokens("я:a, сосед:b, ../побег:c, bezymyannyj");
    // Русские имена сохраняются: каталог «сосед» читается глазами. Вырезать
    // всё, кроме латиницы, значило бы схлопнуть «я» и «сосед» в одно имя.
    expect(tokens.get("я")).toBe("a");
    expect(tokens.get("сосед")).toBe("b");
    // А вот выход наружу обезврежен.
    expect(tokens.get("побег")).toBe("c");
    expect([...tokens.keys()].some((k) => k.includes("/") || k.startsWith("."))).toBe(false);
    expect(tokens.get("default")).toBe("bezymyannyj");
  });

  it("не даёт двум пользователям поделить один каталог", () => {
    // Иначе они видели бы книги друг друга, а один из токенов молча
    // переставал бы работать.
    expect(() => parseTokens("я:a, /я:b")).toThrow(/называются/);
  });

  it("не даёт двум пользователям один токен", () => {
    // Токен ищется перебором и находит первого, поэтому у второго всё
    // ложилось бы в чужой каталог: проверено — каталога «сосед» не
    // появлялось вовсе, а книга соседа оказывалась в полке «я».
    // Пробел после двоеточия ничего не меняет: токен сначала обрезается.
    expect(() => parseTokens("я:obshchij, сосед: obshchij")).toThrow(/один токен/);
  });

  it("жалоба на общий токен называет людей, но не сам токен", () => {
    // Она уходит в журнал сервера, а там секрету не место.
    let complaint = "";
    try {
      parseTokens("я:sekretnyj-token, сосед:sekretnyj-token");
    } catch (e) {
      complaint = (e as Error).message;
    }
    expect(complaint).toContain("«я»");
    expect(complaint).toContain("«сосед»");
    expect(complaint).not.toContain("sekretnyj-token");
  });
});

describe("проба живости", () => {
  it("отвечает без токена и называет свою версию", async () => {
    // Без токена нарочно: узнать, с какой версией говоришь, нужно как раз
    // тогда, когда что-то не сходится, — а токен в такую минуту может
    // оказаться и неверным. Той же пробой живости пользуется reverse proxy.
    const anon = new SyncClient({ url, timeoutMs: 5000 });
    const health = await anon.health();
    expect(health.ok).toBe(true);
    expect(health.version).toBe(VERSION);
  });

  it("версия — та же, что печатается при запуске", async () => {
    // Иначе сервер говорил бы про себя одно, а показывал другое.
    const manifest = JSON.parse(
      readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf-8"),
    ) as { version: string };
    expect((await client().health()).version).toBe(manifest.version);
  });
});

describe("книги", () => {
  const data = new TextEncoder().encode("<FictionBook>проба</FictionBook>");

  it("принимает, отдаёт и перечисляет книгу", async () => {
    const hash = await sha256Hex(data);
    const c = client();
    await c.upload(hash, "Война и мир.fb2", data);

    const books = await c.list();
    expect(books).toHaveLength(1);
    expect(books[0]!.name).toBe("Война и мир.fb2");
    expect(books[0]!.size).toBe(data.length);

    expect(await c.download(hash)).toEqual(data);
  });

  it("дописывает расширение имени, пришедшему без него", async () => {
    // Имя приходит с того устройства, где книгу открыли: браузер отдаёт его
    // как есть, а скачанное из сети лежит в системе нередко без расширения.
    // Починить это надо здесь, иначе книга разъедется по всем устройствам
    // файлом, которого не видно в списке каталога, — список отбирает по имени.
    const hash = await sha256Hex(data);
    const c = client();
    await c.upload(hash, "Война и мир", data);
    expect((await c.list())[0]!.name).toBe("Война и мир.fb2");
  });

  it("отвергает содержимое, не совпавшее с отпечатком", async () => {
    // Иначе книгу можно положить под чужим именем, и другое устройство
    // скачает не то, что ждёт.
    const чужой = await sha256Hex(new TextEncoder().encode("совсем другое"));
    await expect(client().upload(чужой, "подмена.fb2", data)).rejects.toThrow(/отпечат/);
  });

  it("не принимает отпечаток, похожий на путь", async () => {
    await expect(client().upload("../../etc/passwd", "x.fb2", data)).rejects.toThrow();
  });

  it("повторная выгрузка не портит книгу", async () => {
    const hash = await sha256Hex(data);
    const c = client();
    await c.upload(hash, "книга.fb2", data);
    await c.upload(hash, "книга.fb2", data);
    expect(await c.list()).toHaveLength(1);
    expect(await c.download(hash)).toEqual(data);
  });

  it("удаляет книгу вместе с состоянием", async () => {
    const hash = await sha256Hex(data);
    const c = client();
    await c.upload(hash, "книга.fb2", data);
    await c.pushState(state({ hash, block: 5 }));

    await c.remove(hash);
    expect(await c.list()).toEqual([]);
    expect(await c.states(0)).toEqual([]);
    await expect(c.download(hash)).rejects.toThrow(/нет/);
  });

  it("удалённая книга не возвращается следующей выгрузкой", async () => {
    // Иначе forget не работает вовсе: любое устройство, где книга осталась,
    // возвращает её при первом же обмене — и делает это само, без спроса.
    const hash = await sha256Hex(data);
    const c = client();
    await c.upload(hash, "книга.fb2", data);
    await c.remove(hash);

    await expect(c.upload(hash, "книга.fb2", data)).rejects.toThrow(/удалена/);
    expect(await c.list()).toEqual([]);
  });

  it("список книг называет удалённые, чтобы их не слали заново", async () => {
    // Устройство спрашивает список перед выгрузкой: так оно молча пропустит
    // удалённое, а не будет получать отказ на каждую попытку.
    const hash = await sha256Hex(data);
    const c = client();
    await c.upload(hash, "книга.fb2", data);
    expect([...(await c.shelf()).buried]).toEqual([]);
    await c.remove(hash);
    expect([...(await c.shelf()).buried]).toEqual([hash]);
  });

  it("явная выгрузка возвращает удалённую книгу", async () => {
    // Удаление бывает и по ошибке, а иначе вернуть книгу нечем: сервер
    // отказывал бы навсегда, и полка стала бы только уменьшаться.
    const hash = await sha256Hex(data);
    const c = client();
    await c.upload(hash, "книга.fb2", data);
    await c.remove(hash);

    await c.upload(hash, "книга.fb2", data, {}, { revive: true });
    expect(await c.list()).toHaveLength(1);
    // Надгробия больше нет: сама собой книга теперь выгружается как обычная.
    expect([...(await c.shelf()).buried]).toEqual([]);
    await c.upload(hash, "книга.fb2", data);
    expect(await c.list()).toHaveLength(1);
  });

  it("надгробие переживает перезапуск сервера", async () => {
    // Оно лежит файлом рядом с указателем: сервер перезапускают чаще, чем
    // удаляют книги, и забывчивое надгробие не стоило бы ничего.
    const hash = await sha256Hex(data);
    await client().upload(hash, "книга.fb2", data);
    await client().remove(hash);

    await new Promise<void>((resolve) => server.close(() => resolve()));
    server = createServer({ dir, tokens: parseTokens(`я:${TOKEN}`) });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    await expect(client().upload(hash, "книга.fb2", data)).rejects.toThrow(/удалена/);
  });

  it("надгробие одного не мешает другому выгружать свою книгу", async () => {
    // Оно лежит в каталоге пользователя: сосед про мои удаления знать не
    // должен, иначе моё forget отбирало бы книгу у него.
    const hash = await sha256Hex(data);
    await client(TOKEN).upload(hash, "моя.fb2", data);
    await client(TOKEN).remove(hash);

    await client("sosedskiy-token").upload(hash, "его.fb2", data);
    expect(await client("sosedskiy-token").list()).toHaveLength(1);
  });

  it("удаление уносит и осиротевшее состояние", async () => {
    // Состояние книги, которой на сервере нет, хранится отдельно. Без этого
    // forget оставлял бы позицию и закладки, а они разъезжаются по всем
    // устройствам наравне с книгой.
    const hash = await sha256Hex(data);
    const c = client();
    await c.pushState(state({ hash, block: 7 }));
    expect(await c.states(0)).toHaveLength(1);

    // Удаление засчитывается: что-то же на сервере было.
    await c.remove(hash);
    expect(await c.states(0)).toEqual([]);

    // А вот когда не было ничего — честное «нет такого».
    const пусто = await sha256Hex(new TextEncoder().encode("этого сервер не видел"));
    await expect(c.remove(пусто)).rejects.toThrow(/нет/);
  });

  it("не показывает чужие книги", async () => {
    const hash = await sha256Hex(data);
    await client(TOKEN).upload(hash, "моя.fb2", data);
    expect(await client("sosedskiy-token").list()).toEqual([]);
  });

  it("отказывает книге сверх предела и называет предел понятно", async () => {
    // «Книга больше 0 МБ» — вот что говорилось раньше при небольшом пределе:
    // мегабайты округлялись до нуля, и отказ не значил ничего.
    await new Promise<void>((resolve) => server.close(() => resolve()));
    server = createServer({ dir, tokens: parseTokens(`я:${TOKEN}`), maxBytes: 32 });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const big = new Uint8Array(1024);
    await expect(client().upload(await sha256Hex(big), "толстая.fb2", big)).rejects.toThrow(
      /книга больше 32 Б/,
    );
  });

  it("предел в килобайтах называется килобайтами", async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    server = createServer({ dir, tokens: parseTokens(`я:${TOKEN}`), maxBytes: 2048 });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const big = new Uint8Array(4096);
    await expect(client().upload(await sha256Hex(big), "толстая.fb2", big)).rejects.toThrow(
      /книга больше 2 КБ/,
    );
  });
});

describe("состояние", () => {
  const hash = "a".repeat(64);

  it("сливает позицию по времени", async () => {
    const c = client();
    await c.pushState(state({ hash, block: 10, at: 1000 }));
    const { state: merged } = await c.pushState(state({ hash, block: 40, at: 2000 }));
    expect(merged.block).toBe(40);

    // Запись постарше не отменяет ту, что новее.
    const { state: again } = await c.pushState(state({ hash, block: 1, at: 500 }));
    expect(again.block).toBe(40);
  });

  it("объединяет закладки двух устройств и помнит снятие", async () => {
    const c = client();
    await c.pushState(state({ hash, at: 1000, bookmarks: [{ block: 3, at: 1000, name: "первая" }] }));
    await c.pushState(state({ hash, at: 1100, bookmarks: [{ block: 8, at: 1100, name: "вторая" }] }));

    const { state: merged } = await c.pushState(
      state({ hash, at: 1200, bookmarks: [{ block: 3, at: 1200, deleted: true }] }),
    );
    const blocks = merged.bookmarks.map((m) => `${m.block}${m.deleted ? " (снята)" : ""}`);
    expect(blocks).toEqual(["3 (снята)", "8"]);
  });

  it("отдаёт только изменившееся после указанного времени", async () => {
    const c = client();
    await c.pushState(state({ hash, block: 1 }));
    const between = Date.now() / 1000;
    // Отбор идёт по отметке сервера: у клиента `at` может быть каким угодно.
    await new Promise((r) => setTimeout(r, 20));
    await c.pushState(state({ hash: "b".repeat(64), block: 2 }));

    const fresh = await c.states(between);
    expect(fresh.map((s) => s.hash)).toEqual(["b".repeat(64)]);
    expect((await c.states(0)).map((s) => s.hash).sort()).toEqual(["a".repeat(64), "b".repeat(64)]);
  });

  it("хранит позицию и для книги, которой на сервере нет", async () => {
    // Синхронизировать позицию можно без выгрузки книги: это отдельная
    // команда и отдельное желание.
    const c = client();
    await c.pushState(state({ hash, block: 7 }));
    expect((await c.states(0)).map((s) => s.block)).toEqual([7]);
    expect(await c.list()).toEqual([]);
  });

  it("предупреждает о разошедшихся часах", async () => {
    // Слияние держится на времени: ушедшие часы будут выигрывать или
    // проигрывать чужие записи ни за что.
    const давно = Date.now() / 1000 - 3600;
    const { warning } = await client().pushState(state({ hash, at: давно }));
    expect(warning).toMatch(/часы/);
  });

  it("молчит, когда часы в порядке", async () => {
    const { warning } = await client().pushState(state({ hash, at: Date.now() / 1000 }));
    expect(warning).toBeUndefined();
  });

  it("не путается, когда два запроса по одной книге приходят разом", async () => {
    // «Прочитать, слить, записать» с ожиданием между шагами: без очереди
    // один запрос затёр бы другого, и закладка пропала бы.
    const c = client();
    await Promise.all([
      c.pushState(state({ hash, at: 1000, bookmarks: [{ block: 1, at: 1000 }] })),
      c.pushState(state({ hash, at: 1001, bookmarks: [{ block: 2, at: 1001 }] })),
      c.pushState(state({ hash, at: 1002, bookmarks: [{ block: 3, at: 1002 }] })),
    ]);
    const [merged] = await c.states(0);
    expect(merged!.bookmarks.map((m) => m.block).sort()).toEqual([1, 2, 3]);
  });

  it("отказ состоянию называет свой предел, а не книжный", async () => {
    // Состояние читается со своим пределом в четыре мегабайта, а в ответ
    // приходило «книга больше 200 МБ»: и про книгу, которой в запросе не
    // было, и про предел, которого никто не переступал. Читатель после
    // такого ищет толстую книгу, а дело в записи о закладках.
    const hash = await sha256Hex(new TextEncoder().encode("огромное состояние"));
    // Кириллица в JSON занимает по два байта на букву — пяти миллионов
    // хватает с запасом, а строить десятки тысяч закладок незачем.
    const раздутое = state({ hash, title: "я".repeat(2_600_000) });
    await expect(client().pushState(раздутое)).rejects.toThrow(
      /запись о месте и закладках больше 4 МБ/,
    );
    // И ничего не записалось: отказ — это отказ.
    expect(await client().states(0)).toEqual([]);
  });

  it("не берёт тело, которое не разобралось", async () => {
    const response = await fetch(`${url}/api/v1/state/${hash}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: "это не json",
    });
    expect(response.status).toBe(400);
  });
});

describe("присланному состоянию не верят на слово", () => {
  // Сервер хранит это и рассылает по всем устройствам. Раньше проверялось
  // только одно — что позиция число, — и в хранилище попадало что угодно.
  const data = new TextEncoder().encode("книга для мусора");

  it("отрицательная позиция становится началом книги", async () => {
    // Отказывать нельзя: сбитое устройство перестало бы синхронизироваться
    // вовсе. А позиция, съехавшая в начало, поправится первым же чтением.
    const hash = await sha256Hex(data);
    const { state: merged } = await client().pushState(state({ hash, block: -5 }));
    expect(merged.block).toBe(0);
  });

  it("дробная позиция округляется вниз", async () => {
    const hash = await sha256Hex(data);
    const { state: merged } = await client().pushState(state({ hash, block: 3.7 }));
    expect(merged.block).toBe(3);
  });

  it("отрицательная длина книги обнуляется", async () => {
    const hash = await sha256Hex(data);
    const { state: merged } = await client().pushState(state({ hash, block: 1, total: -100 }));
    expect(merged.total).toBe(0);
  });

  it("непомерное название обрезается", async () => {
    // Иначе название на три мегабайта уедет на каждое устройство и станет
    // строкой в списке книг.
    const hash = await sha256Hex(data);
    const { state: merged } = await client().pushState(
      state({ hash, block: 1, title: "я".repeat(5000) }),
    );
    expect(merged.title).toHaveLength(300);
  });

  it("мусор вместо закладок отбрасывается, годные остаются", async () => {
    const hash = await sha256Hex(data);
    const { state: merged } = await client().pushState(
      state({
        hash,
        block: 1,
        // Настоящий клиент такого не пришлёт, но сервер отвечает всем.
        bookmarks: [null, {}, "строка", { block: 2.9 }, { block: 7, name: "годная" }] as never,
      }),
    );
    expect(merged.bookmarks.map((m) => m.block)).toEqual([2, 7]);
    expect(merged.bookmarks[1]!.name).toBe("годная");
  });

  it("незнакомые поля закладки не хранятся", async () => {
    // Сервер не склад: он сравнивает закладки и решает, какая победила, —
    // значит, должен понимать всё, что хранит и рассылает.
    const hash = await sha256Hex(data);
    const { state: merged } = await client().pushState(
      state({ hash, block: 1, bookmarks: [{ block: 3, чужое: "не наше" }] as never }),
    );
    expect(merged.bookmarks).toEqual([{ block: 3 }]);
  });

  it("пятисотка не выносит наружу путей с диска сервера", async () => {
    // Спрашивает сервер кто угодно, у кого есть хоть какой-то токен, а в
    // сообщении ошибки лежат пути и имена пользователей. Хозяину сервера они
    // нужны — и их место в журнале, а не в ответе.
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const файл = join(dir, "вместо-каталога");
    writeFileSync(файл, "я файл, а не каталог");
    server = createServer({ dir: файл, tokens: parseTokens(`я:${TOKEN}`) });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const журнал: string[] = [];
    const перехват = vi.spyOn(process.stderr, "write").mockImplementation((line) => {
      журнал.push(String(line));
      return true;
    });
    let жалоба = "";
    try {
      await client().pushState(state({ hash: await sha256Hex(data), block: 1 }));
    } catch (e) {
      жалоба = (e as Error).message;
    } finally {
      перехват.mockRestore();
    }

    expect(жалоба).toContain("500");
    expect(жалоба).not.toContain(файл);
    expect(жалоба).not.toMatch(/ENOTDIR|ENOENT/);
    // А хозяину сервера подробность досталась.
    expect(журнал.join("")).toMatch(/ENOTDIR|ENOENT/);
  });
});

describe("сквозной обмен двух устройств", () => {
  it("книга, выгруженная с одного, читается на другом с того же места", async () => {
    const книга = new TextEncoder().encode("<FictionBook>текст книги</FictionBook>");
    const hash = await sha256Hex(книга);

    // Ноутбук: выгрузил книгу, дочитал до 120-го абзаца, отметил закладку.
    const ноутбук = client(TOKEN, "ноутбук");
    await ноутбук.upload(hash, "Анна Каренина.fb2", книга);
    await ноутбук.pushState(
      state({ hash, block: 120, at: 1000, device: "ноутбук", bookmarks: [{ block: 40, at: 1000, name: "мысль" }] }),
    );

    // Телефон: увидел книгу, скачал, узнал позицию.
    const телефон = client(TOKEN, "телефон");
    const список = await телефон.list();
    expect(список.map((b) => b.name)).toEqual(["Анна Каренина.fb2"]);
    expect(await телефон.download(hash)).toEqual(книга);

    const [состояние] = await телефон.states(0);
    expect(состояние!.block).toBe(120);
    expect(состояние!.bookmarks.map((m) => m.name)).toEqual(["мысль"]);

    // Телефон читает дальше и снимает закладку.
    await телефон.pushState(
      state({ hash, block: 300, at: 2000, device: "телефон", bookmarks: [{ block: 40, at: 2000, deleted: true }] }),
    );

    // Ноутбук забирает результат: позиция телефона, закладки нет.
    const [обратно] = await ноутбук.states(0);
    expect(обратно!.block).toBe(300);
    expect(обратно!.bookmarks.filter((m) => !m.deleted)).toEqual([]);

    // И она не возвращается, даже если ноутбук пришлёт её снова со старым
    // временем: он о снятии не знал.
    const { state: после } = await ноутбук.pushState(
      state({ hash, block: 300, at: 2001, bookmarks: [{ block: 40, at: 1000, name: "мысль" }] }),
    );
    expect(после.bookmarks.filter((m) => !m.deleted)).toEqual([]);
  });
});

describe("несколько книг разом", () => {
  /** Книга с заданным содержимым: у каждой свой отпечаток. */
  async function книга(n: number): Promise<{ data: Uint8Array; hash: string }> {
    const data = new TextEncoder().encode(`книга номер ${n} `.repeat(n * 5));
    return { data, hash: await sha256Hex(data) };
  }

  it("две выгрузки одновременно — обе книги в списке", async () => {
    // Указатель книг один на пользователя, а очередь была заведена на книгу:
    // две выгрузки разом читали указатель одинаковым и писали по очереди,
    // теряя одну запись. Вдобавок обе брали одно и то же временное имя —
    // вторая падала на переименовании, и сервер отвечал 500.
    const api = client();
    const первая = await книга(1);
    const вторая = await книга(2);
    await Promise.all([
      api.upload(первая.hash, "первая.fb2", первая.data, { title: "Первая" }),
      api.upload(вторая.hash, "вторая.fb2", вторая.data, { title: "Вторая" }),
    ]);

    const список = (await api.list()).map((book) => book.title).sort();
    expect(список).toEqual(["Вторая", "Первая"]);
    // И обе по-настоящему скачиваются: запись в указателе без байтов ничего
    // не стоит.
    expect((await api.download(первая.hash)).length).toBe(первая.data.length);
    expect((await api.download(вторая.hash)).length).toBe(вторая.data.length);
  });

  it("пять выгрузок разом не теряют ни одной", async () => {
    const api = client();
    const книги = await Promise.all([1, 2, 3, 4, 5].map((n) => книга(n)));
    await Promise.all(книги.map((к, i) => api.upload(к.hash, `книга-${i}.fb2`, к.data, {})));
    expect((await api.list()).length).toBe(5);
  });

  it("удаление одной книги не теряет другую, выгружаемую в тот же миг", async () => {
    const api = client();
    const старая = await книга(3);
    const новая = await книга(4);
    await api.upload(старая.hash, "старая.fb2", старая.data, { title: "Старая" });

    await Promise.all([
      api.remove(старая.hash),
      api.upload(новая.hash, "новая.fb2", новая.data, { title: "Новая" }),
    ]);

    expect((await api.list()).map((book) => book.title)).toEqual(["Новая"]);
  });

  it("неудачная запись не оставляет временного файла", async () => {
    // Неудача бывает: кончилось место, права, чужой каталог на пути. Мусор
    // после неё копился бы молча и занимал ровно столько же, сколько данные.
    const storage = new Storage(join(dir, "своё"));
    // На месте указателя — каталог: переименовать файл поверх него нельзя.
    mkdirSync(join(dir, "своё", "я"), { recursive: true });
    mkdirSync(join(dir, "своё", "я", "index.json"));

    const data = new TextEncoder().encode("книга");
    const hash = await sha256Hex(data);
    await expect(
      storage.putBook(
        "я",
        { hash, name: "к.fb2", size: data.length, title: "К", author: "", updatedAt: 1, ext: ".fb2" },
        data,
      ),
    ).rejects.toThrow();

    const мусор = readdirSync(join(dir, "своё", "я")).filter((name) => name.endsWith(".tmp"));
    expect(мусор).toEqual([]);
  });

  it("после выгрузки не остаётся временных файлов", async () => {
    const api = client();
    const книги = await Promise.all([6, 7].map((n) => книга(n)));
    await Promise.all(книги.map((к, i) => api.upload(к.hash, `к-${i}.fb2`, к.data, {})));
    const мусор = readdirSync(join(dir, "я")).filter((name) => name.endsWith(".tmp"));
    expect(мусор).toEqual([]);
  });
});

describe("ушедшие часы", () => {
  const ВПЕРЁД = 10 * 365 * 24 * 3600;

  it("время из будущего не морозит книгу навсегда", async () => {
    // Иначе одно устройство с неверной датой выигрывает у всех и навсегда:
    // ни одна честная запись больше не окажется «позже».
    const hash = "e".repeat(64);
    const сейчас = Date.now() / 1000;
    await client(TOKEN, "телефон").pushState(
      state({ hash, block: 10, at: сейчас + ВПЕРЁД }),
    );

    const { state: после } = await client(TOKEN, "ноутбук").pushState(
      state({ hash, block: 900, at: Date.now() / 1000 }),
    );
    expect(после.block).toBe(900);
  });

  it("записанное время — серверное, а не присланное", async () => {
    const hash = "f".repeat(64);
    const сейчас = Date.now() / 1000;
    const { state: записано } = await client(TOKEN, "телефон").pushState(
      { hash, block: 10, total: 100, title: "Книга", author: "", at: сейчас + ВПЕРЁД, bookmarks: [] },
    );
    expect(записано.at).toBeLessThanOrEqual(Date.now() / 1000 + 1);
  });

  it("о расхождении часов по-прежнему предупреждают", async () => {
    // Обрезка чинит слияние, но не часы: узнать о них читатель должен.
    const hash = "0".repeat(64);
    const { warning } = await client(TOKEN, "телефон").pushState(
      state({ hash, block: 1, at: Date.now() / 1000 + ВПЕРЁД }),
    );
    expect(warning).toContain("часы устройства расходятся");
    expect(warning).toContain("серверным");
  });

  it("надгробие из будущего не бессмертно", async () => {
    const hash = "1".repeat(64);
    const сейчас = Date.now() / 1000;
    await client(TOKEN, "телефон").pushState(
      state({ hash, block: 1, at: сейчас, bookmarks: [{ block: 5, at: сейчас + ВПЕРЁД, deleted: true }] }),
    );

    // Читатель ставит закладку заново — и она остаётся.
    const { state: после } = await client(TOKEN, "ноутбук").pushState(
      state({ hash, block: 1, at: Date.now() / 1000, bookmarks: [{ block: 5, at: Date.now() / 1000, name: "моя" }] }),
    );
    expect(после.bookmarks.filter((m) => !m.deleted).map((m) => m.name)).toEqual(["моя"]);
  });

  it("отставшие часы не подменяются: они вредят только своему хозяину", async () => {
    // Подмена затёрла бы верную запись о том, когда книгу читали на самом деле.
    const hash = "2".repeat(64);
    const давно = 1_600_000_000;
    const { state: записано } = await client(TOKEN, "старый").pushState(
      state({ hash, block: 7, at: давно }),
    );
    expect(записано.at).toBe(давно);
  });

  it("закладка без времени остаётся без времени", async () => {
    // Придуманный час поставил бы её выше тех, о которых точно известно,
    // когда их сделали.
    const hash = "3".repeat(64);
    const { state: после } = await client(TOKEN, "ноутбук").pushState(
      state({ hash, block: 1, at: Date.now() / 1000, bookmarks: [{ block: 9, name: "из старого файла" }] }),
    );
    expect(после.bookmarks[0]).toEqual({ block: 9, name: "из старого файла" });
  });
});
