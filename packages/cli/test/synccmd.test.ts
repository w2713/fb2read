/**
 * Синхронизация по нажатию клавиши — со стороны читалки.
 *
 * Интерфейс проверяется отдельно, на поддельном обработчике; здесь проверяется
 * то, что он вызывает: настоящий HTTP, настоящий файл состояния. Сервер тут
 * простейший, ровно на один нужный путь, — брать целый пакет сервера незачем,
 * а его собственные тесты и так есть.
 */

import { createServer, type Server } from "node:http";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
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
    upload: false,
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

describe("каталог для скачанных книг", () => {
  it("берётся у системы, а не из HOME", async () => {
    // На Windows переменной HOME обычно нет, и книги ложились бы в
    // «Books\fb2read» рядом с тем каталогом, откуда запустили читалку,
    // то есть каждый раз в новом месте.
    const { libraryDir } = await import("../src/sync.js");
    const было = process.env["HOME"];
    const своё = process.env["FB2READ_LIBRARY"];
    delete process.env["HOME"];
    delete process.env["FB2READ_LIBRARY"];
    try {
      expect(libraryDir()).toBe(join(homedir(), "Books", "fb2read"));
      expect(libraryDir().startsWith(".")).toBe(false);
    } finally {
      if (было !== undefined) process.env["HOME"] = было;
      if (своё !== undefined) process.env["FB2READ_LIBRARY"] = своё;
    }
  });

  it("своё место в FB2READ_LIBRARY главнее", async () => {
    const { libraryDir } = await import("../src/sync.js");
    const было = process.env["FB2READ_LIBRARY"];
    process.env["FB2READ_LIBRARY"] = join("тут", "книги");
    try {
      expect(libraryDir()).toBe(join("тут", "книги"));
    } finally {
      if (было === undefined) delete process.env["FB2READ_LIBRARY"];
      else process.env["FB2READ_LIBRARY"] = было;
    }
  });
});

describe("скачивание книги", () => {
  const книга = new TextEncoder().encode(
    '<?xml version="1.0" encoding="utf-8"?><FictionBook><description><title-info>' +
      "<book-title>Война и мир</book-title></title-info></description>" +
      "<body><section><p>Текст.</p></section></body></FictionBook>",
  );

  /** Сервер ровно на те три пути, которые спрашивает pull. */
  function raise(имя: string): Promise<{ url: string; close: () => Promise<void> }> {
    const s = createServer((request, response) => {
      const path = (request.url ?? "").split("?")[0];
      if (path === "/api/v1/books") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({
            books: [
              { hash: HASH, name: имя, size: книга.length, title: "Война и мир", author: "Толстой", updatedAt: 1 },
            ],
          }),
        );
        return;
      }
      if (path === `/api/v1/books/${HASH}`) {
        response.writeHead(200, { "Content-Type": "application/octet-stream" });
        response.end(Buffer.from(книга));
        return;
      }
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ states: [] }));
    });
    return new Promise((done) => {
      s.listen(0, "127.0.0.1", () =>
        done({
          url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`,
          close: () => new Promise<void>((r) => s.close(() => r())),
        }),
      );
    });
  }

  async function pull(имя: string): Promise<string[]> {
    const { cmdPull } = await import("../src/sync.js");
    const lib = mkdtempSync(join(tmpdir(), "fb2read-lib-"));
    const было = process.env["FB2READ_LIBRARY"];
    process.env["FB2READ_LIBRARY"] = lib;
    const сервер = await raise(имя);
    try {
      expect(await cmdPull({ url: сервер.url, token: "proba-token" }, undefined, true, store())).toBe(0);
      return readdirSync(lib);
    } finally {
      await сервер.close();
      if (было === undefined) delete process.env["FB2READ_LIBRARY"];
      else process.env["FB2READ_LIBRARY"] = было;
      rmSync(lib, { recursive: true, force: true });
    }
  }

  it("дописывает расширение имени, пришедшему без него", async () => {
    // Имя приходит с того устройства, где книгу открыли, и расширения может
    // не иметь: браузер отдаёт имя файла как есть, а скачанное из сети лежит
    // в системе нередко без расширения. Такой файл читалка откроет, но в
    // списке каталога его не будет — список отбирает файлы по имени.
    expect(await pull("Война и мир")).toEqual(["Война и мир.fb2"]);
  });

  it("имя с расширением оставляет как есть", async () => {
    expect(await pull("Война и мир.fb2")).toEqual(["Война и мир.fb2"]);
  });
});

describe("выгрузка открытой книги", () => {
  // Настоящий сервер брать сюда незачем: у него свои проверки. А вот молчание
  // при неудаче — как раз то, чего быть не должно, и ловится оно только здесь.
  const книга = new TextEncoder().encode(
    '<?xml version="1.0" encoding="utf-8"?><FictionBook><description><title-info>' +
      "<book-title>Анна Каренина</book-title></title-info></description>" +
      "<body><section><p>Текст.</p></section></body></FictionBook>",
  );

  /** Сервер, который помнит, что ему положили. */
  function raise(было: string[]): Promise<{
    url: string;
    uploaded: { hash: string; name: string; size: number }[];
    close: () => Promise<void>;
  }> {
    const uploaded: { hash: string; name: string; size: number }[] = [];
    const s = createServer((request, response) => {
      const path = (request.url ?? "").split("?")[0]!;
      if (request.method === "GET" && path === "/api/v1/books") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({
            books: было.map((hash) => ({ hash, name: "есть.fb2", size: 1, title: "", author: "", updatedAt: 1 })),
          }),
        );
        return;
      }
      if (request.method === "PUT" && path.startsWith("/api/v1/books/")) {
        const chunks: Buffer[] = [];
        request.on("data", (c: Buffer) => chunks.push(c));
        request.on("end", () => {
          uploaded.push({
            hash: path.slice("/api/v1/books/".length),
            name: decodeURIComponent(String(request.headers["x-name"] ?? "")),
            size: Buffer.concat(chunks).length,
          });
          response.writeHead(200, { "Content-Type": "application/json" });
          response.end(JSON.stringify({ ok: true }));
        });
        return;
      }
      response.writeHead(404);
      response.end();
    });
    return new Promise((done) => {
      s.listen(0, "127.0.0.1", () =>
        done({
          url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`,
          uploaded,
          close: () => new Promise<void>((r) => s.close(() => r())),
        }),
      );
    });
  }

  async function keep(было: string[], hash = HASH) {
    const { keepOnServer } = await import("../src/sync.js");
    const file = join(dir, "Анна Каренина.fb2");
    writeFileSync(file, книга);
    const сервер = await raise(было);
    try {
      const note = await keepOnServer(
        { ...settings, url: сервер.url, upload: true },
        file,
        { hash, title: "Анна Каренина", author: "Толстой" },
      );
      return { note, uploaded: сервер.uploaded };
    } finally {
      await сервер.close();
    }
  }

  it("книга уезжает на сервер целиком и с именем", async () => {
    const { note, uploaded } = await keep([]);
    expect(uploaded).toHaveLength(1);
    expect(uploaded[0]!.name).toBe("Анна Каренина.fb2");
    expect(uploaded[0]!.size).toBe(книга.length);
    expect(note).toContain("Анна Каренина");
  });

  it("книгу, которая уже там, второй раз не льёт", async () => {
    // Иначе каждое открытие книги гнало бы её мегабайты по сети заново.
    const { note, uploaded } = await keep([HASH]);
    expect(uploaded).toEqual([]);
    expect(note).toBe("");
  });

  it("недоступный сервер объясняет словами и не бросает", async () => {
    const { keepOnServer } = await import("../src/sync.js");
    const file = join(dir, "к.fb2");
    writeFileSync(file, книга);
    const note = await keepOnServer(
      { ...settings, url: "http://127.0.0.1:1", upload: true },
      file,
      { hash: HASH, title: "Книга", author: "" },
    );
    expect(note).toMatch(/не удалось выгрузить/);
  });
});

describe("выгрузка каталогом", () => {
  const книга = (название: string) =>
    new TextEncoder().encode(
      '<?xml version="1.0" encoding="utf-8"?><FictionBook><description><title-info>' +
        `<book-title>${название}</book-title></title-info></description>` +
        "<body><section><p>Текст.</p></section></body></FictionBook>",
    );

  /** Сервер, помнящий выгруженное; список отдаёт то, что уже лежит. */
  function raise(): Promise<{ url: string; names: string[]; close: () => Promise<void> }> {
    const names: string[] = [];
    const hashes = new Set<string>();
    const s = createServer((request, response) => {
      const path = (request.url ?? "").split("?")[0]!;
      if (request.method === "GET" && path === "/api/v1/books") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({
            books: [...hashes].map((hash) => ({
              hash, name: "х.fb2", size: 1, title: "", author: "", updatedAt: 1,
            })),
          }),
        );
        return;
      }
      if (request.method === "PUT" && path.startsWith("/api/v1/books/")) {
        const chunks: Buffer[] = [];
        request.on("data", (c: Buffer) => chunks.push(c));
        request.on("end", () => {
          hashes.add(path.slice("/api/v1/books/".length));
          names.push(decodeURIComponent(String(request.headers["x-name"] ?? "")));
          response.writeHead(200, { "Content-Type": "application/json" });
          response.end(JSON.stringify({ ok: true }));
        });
        return;
      }
      // Состояние: принимаем и возвращаем как есть.
      const chunks: Buffer[] = [];
      request.on("data", (c: Buffer) => chunks.push(c));
      request.on("end", () => {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ state: JSON.parse(Buffer.concat(chunks).toString() || "{}") }));
      });
    });
    return new Promise((done) => {
      s.listen(0, "127.0.0.1", () =>
        done({
          url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`,
          names,
          close: () => new Promise<void>((r) => s.close(() => r())),
        }),
      );
    });
  }

  async function push(target: string | undefined, all: boolean, lib: string) {
    const { cmdPush } = await import("../src/sync.js");
    const было = process.env["FB2READ_LIBRARY"];
    process.env["FB2READ_LIBRARY"] = lib;
    const сервер = await raise();
    try {
      const code = await cmdPush({ url: сервер.url, token: "proba-token" }, target, all, store());
      return { code, names: сервер.names };
    } finally {
      await сервер.close();
      if (было === undefined) delete process.env["FB2READ_LIBRARY"];
      else process.env["FB2READ_LIBRARY"] = было;
    }
  }

  function library(): string {
    const lib = mkdtempSync(join(tmpdir(), "fb2read-push-"));
    writeFileSync(join(lib, "Первая.fb2"), книга("Первая"));
    writeFileSync(join(lib, "Вторая.fb2"), книга("Вторая"));
    // Не книга: в каталоге всегда найдётся что-нибудь постороннее.
    writeFileSync(join(lib, "заметки.txt"), "не книга");
    return lib;
  }

  it("каталогом уезжают все книги и только книги", async () => {
    const lib = library();
    const { code, names } = await push(lib, false, lib);
    expect(code).toBe(0);
    expect(names.sort()).toEqual(["Вторая.fb2", "Первая.fb2"]);
    rmSync(lib, { recursive: true, force: true });
  });

  it("--all без пути берёт каталог библиотеки", async () => {
    const lib = library();
    const { code, names } = await push(undefined, true, lib);
    expect(code).toBe(0);
    expect(names).toHaveLength(2);
    rmSync(lib, { recursive: true, force: true });
  });

  it("битая книга не останавливает остальные", async () => {
    // Ради этого всё и затевалось: цикл в оболочке спотыкался на первой же.
    const lib = library();
    const битая = join(lib, "битая.fb2");
    writeFileSync(битая, "");
    rmSync(битая); // файл исчез между чтением каталога и открытием
    const { code, names } = await push(lib, false, lib);
    expect(code).toBe(0);
    expect(names).toHaveLength(2);
    rmSync(lib, { recursive: true, force: true });
  });

  it("без пути и без --all объясняет, чего ждали", async () => {
    const { cmdPush } = await import("../src/sync.js");
    expect(await cmdPush({ url: "http://127.0.0.1:1" }, undefined, false, store())).toBe(2);
  });
});
