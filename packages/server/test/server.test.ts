/**
 * Сервер синхронизации.
 *
 * Сервер поднимается по-настоящему, на свободном порту, и разговаривает с
 * настоящим SyncClient. Подделывать здесь нечего: цена ошибки — разъехавшиеся
 * позиции на двух устройствах, а такое ловится только сквозным прогоном.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { SyncClient, sha256Hex, type SyncState } from "@fb2read/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, parseTokens } from "../src/server.js";

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

  it("не показывает чужие книги", async () => {
    const hash = await sha256Hex(data);
    await client(TOKEN).upload(hash, "моя.fb2", data);
    expect(await client("sosedskiy-token").list()).toEqual([]);
  });

  it("отказывает книге сверх предела", async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    server = createServer({ dir, tokens: parseTokens(`я:${TOKEN}`), maxBytes: 32 });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const big = new Uint8Array(1024);
    await expect(client().upload(await sha256Hex(big), "толстая.fb2", big)).rejects.toThrow(/МБ|больше/);
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

  it("не берёт тело, которое не разобралось", async () => {
    const response = await fetch(`${url}/api/v1/state/${hash}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: "это не json",
    });
    expect(response.status).toBe(400);
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
