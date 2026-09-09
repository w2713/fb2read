/**
 * Синхронизация по нажатию клавиши — со стороны читалки.
 *
 * Интерфейс проверяется отдельно, на поддельном обработчике; здесь проверяется
 * то, что он вызывает: настоящий HTTP, настоящий файл состояния. Сервер тут
 * простейший, ровно на один нужный путь, — брать целый пакет сервера незачем,
 * а его собственные тесты и так есть.
 */

import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Bookmark, SyncState } from "@fb2read/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JsonFileStore } from "../src/store.js";
import { syncOnDemand, type SyncSettings } from "../src/sync.js";

const HASH = "c".repeat(64);
const KEY = "kluch1234567890a";

let server: Server;
let dir: string;
let settings: SyncSettings;
/** Что лежит «на сервере» — подменяется в каждом тесте отдельно. */
let stored: SyncState | null;
/** Чем сервер отвечает вместо обычного слияния. */
let answer: ((incoming: SyncState) => { status: number; body: unknown }) | null;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "fb2read-cli-"));
  stored = null;
  answer = null;

  server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      const incoming = JSON.parse(body) as SyncState;
      const custom = answer?.(incoming);
      if (custom) {
        response.writeHead(custom.status, { "Content-Type": "application/json" });
        response.end(JSON.stringify(custom.body));
        return;
      }
      // Слияние здесь нарочно простейшее: проверяется поведение читалки,
      // а правила слияния — в тестах ядра.
      const merged: SyncState = stored
        ? { ...incoming, bookmarks: [...stored.bookmarks, ...incoming.bookmarks] }
        : incoming;
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ state: merged }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  settings = {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    auto: false,
    device: "ноутбук",
  };
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});

const meta = { hash: HASH, title: "Книга", author: "Автор", total: 100 };

function store(): JsonFileStore {
  return new JsonFileStore(join(dir, "positions.json"));
}

describe("синхронизация по требованию", () => {
  it("отправляет позицию и говорит, что вышло", async () => {
    let seen: SyncState | null = null;
    answer = (incoming) => {
      seen = incoming;
      return { status: 200, body: { state: incoming } };
    };
    const got = await syncOnDemand(settings, store(), KEY, meta, "/книги/к.fb2", 42, []);
    expect(got.text).toBe("синхронизировано");
    expect(seen!.block).toBe(42);
    expect(seen!.device).toBe("ноутбук");
  });

  it("приносит закладку с другого устройства и считает прибавку", async () => {
    stored = { ...meta, block: 0, at: 1, bookmarks: [{ block: 7, at: 1, name: "с телефона" }] };
    const мои: Bookmark[] = [{ block: 3, at: 2, name: "моя" }];
    const got = await syncOnDemand(settings, store(), KEY, meta, "/книги/к.fb2", 10, мои);
    expect(got.text).toContain("закладок прибавилось: 1");
    expect(got.bookmarks?.map((m) => m.name).sort()).toEqual(["моя", "с телефона"]);
  });

  it("записывает пришедшее в файл состояния, а не только показывает", async () => {
    stored = { ...meta, block: 0, at: 1, bookmarks: [{ block: 7, at: 1, name: "с телефона" }] };
    const s = store();
    await syncOnDemand(settings, s, KEY, meta, "/книги/к.fb2", 10, []);
    // Иначе закладка пропала бы при следующем запуске.
    const marks = await s.loadBookmarks(KEY);
    expect(marks.map((m) => m.name)).toEqual(["с телефона"]);
  });

  it("недоступный сервер объясняет словами и не роняет читалку", async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const got = await syncOnDemand(settings, store(), KEY, meta, "/книги/к.fb2", 5, []);
    expect(got.text).toMatch(/^не вышло: /);
    expect(got.bookmarks).toBeUndefined();
  });

  it("отказ сервера тоже объясняет словами", async () => {
    answer = () => ({ status: 401, body: { error: "сервер не принял токен" } });
    const got = await syncOnDemand(settings, store(), KEY, meta, "/книги/к.fb2", 5, []);
    expect(got.text).toContain("токен");
  });

  it("предупреждение сервера доходит до читателя", async () => {
    // Например, про разошедшиеся часы: молча портить позицию нельзя.
    answer = (incoming) => ({
      status: 200,
      body: { state: incoming, warning: "часы устройства расходятся с сервером на 60 мин" },
    });
    const got = await syncOnDemand(settings, store(), KEY, meta, "/книги/к.fb2", 5, []);
    expect(got.text).toContain("часы");
  });
});
