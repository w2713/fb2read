/**
 * Синхронизация по нажатию клавиши — со стороны читалки.
 *
 * Интерфейс проверяется отдельно, на поддельном обработчике; здесь проверяется
 * то, что он вызывает: настоящий HTTP, настоящий файл состояния. Сервер тут
 * простейший, ровно на один нужный путь, — брать целый пакет сервера незачем,
 * а его собственные тесты и так есть.
 */

import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Hex, type Bookmark, type SyncState } from "@fb2read/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

describe("обмен состоянием всей полки", () => {
  /** Считает записи файла: у хранилища они частные, но проверке видны. */
  function счётчик(куда: JsonFileStore): () => number {
    let n = 0;
    const скрытое = куда as unknown as { write: (data: unknown) => void };
    const писало = скрытое.write.bind(куда);
    скрытое.write = (data) => {
      n += 1;
      писало(data);
    };
    return () => n;
  }

  it("пишет файл состояния один раз, а не по разу на книгу", async () => {
    // Файл один на все книги, и правка книга за книгой разбирала и писала его
    // целиком. Замерено на 300 книгах (файл 103 КБ): 300 записей на 204 мс и
    // 602 разбора на 580 мс — три четверти секунды ни за что.
    const { cmdSync } = await import("../src/sync.js");
    const свой = store();
    for (let i = 0; i < 3; i += 1) {
      await свой.applyState(
        `kluch${i}`,
        {
          hash: String(i).repeat(64).slice(0, 64),
          block: i,
          total: 100,
          title: `Книга ${i}`,
          author: "Автор",
          at: 1_700_000_000,
          bookmarks: [],
        },
        join(dir, `книга-${i}.fb2`),
      );
    }

    const записей = счётчик(свой);
    expect(await cmdSync({ url: settings.url, token: "proba-token" }, свой)).toBe(0);
    expect(записей()).toBe(1);
    // И слитое доехало до файла: одна запись — не повод потерять места.
    expect(await свой.loadPosition("kluch2")).toBe(2);
  });

  it("тихий обмен из списка книг пишет так же — один раз", async () => {
    // Это тот же обмен, только по нажатию клавиши в списке: на экране список,
    // и печатать поверх него нельзя, поэтому итог возвращается строкой.
    const { syncAllQuiet } = await import("../src/sync.js");
    const свой = store();
    for (let i = 0; i < 3; i += 1) {
      await свой.applyState(
        `kluch${i}`,
        {
          hash: String(i).repeat(64).slice(0, 64),
          block: i,
          total: 100,
          title: `Книга ${i}`,
          author: "Автор",
          at: 1_700_000_000,
          bookmarks: [],
        },
        join(dir, `книга-${i}.fb2`),
      );
    }

    const записей = счётчик(свой);
    const итог = await syncAllQuiet(settings, свой);
    expect(итог).toContain("синхронизировано 3");
    expect(записей()).toBe(1);
  });

  it("пустой обмен файла не трогает", async () => {
    const { cmdSync } = await import("../src/sync.js");
    const свой = store();
    const записей = счётчик(свой);
    expect(await cmdSync({ url: settings.url, token: "proba-token" }, свой)).toBe(0);
    expect(записей()).toBe(0);
  });
});

describe("скачивание всей полки", () => {
  const книга = (название: string) =>
    new TextEncoder().encode(
      '<?xml version="1.0" encoding="utf-8"?><FictionBook><description><title-info>' +
        `<book-title>${название}</book-title></title-info></description>` +
        "<body><section><p>Текст.</p></section></body></FictionBook>",
    );

  /** Сервер, записывающий каждый путь: считаем запросы, а не догадываемся. */
  function raise(
    книги: { hash: string; name: string; data: Uint8Array }[],
    местаЛомаются = false,
  ): Promise<{
    url: string;
    log: string[];
    close: () => Promise<void>;
  }> {
    const log: string[] = [];
    const s = createServer((request, response) => {
      const path = (request.url ?? "").split("?")[0]!;
      log.push(path);
      if (path === "/api/v1/books") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({
            books: книги.map((b) => ({
              hash: b.hash, name: b.name, size: b.data.length, title: b.name, author: "", updatedAt: 1,
            })),
          }),
        );
        return;
      }
      const found = книги.find((b) => path === `/api/v1/books/${b.hash}`);
      if (found) {
        response.writeHead(200, { "Content-Type": "application/octet-stream" });
        response.end(Buffer.from(found.data));
        return;
      }
      if (местаЛомаются) {
        response.writeHead(500, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: "сервер поперхнулся" }));
        return;
      }
      // Места: у первой книги есть, у остальных нет.
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          states: книги[0]
            ? [{ hash: книги[0].hash, block: 20, total: 100, title: книги[0].name, author: "", at: 1, bookmarks: [] }]
            : [],
        }),
      );
    });
    return new Promise((done) => {
      s.listen(0, "127.0.0.1", () =>
        done({
          url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`,
          log,
          close: () => new Promise<void>((r) => s.close(() => r())),
        }),
      );
    });
  }

  async function pullAll(сколько: number, местаЛомаются = false) {
    const { cmdPull } = await import("../src/sync.js");
    const книги = await Promise.all(
      Array.from({ length: сколько }, async (_, i) => {
        const data = книга(`Книга ${i + 1}`);
        return { hash: await sha256Hex(data), name: `Книга ${i + 1}.fb2`, data };
      }),
    );
    const lib = mkdtempSync(join(tmpdir(), "fb2read-pull-"));
    const было = process.env["FB2READ_LIBRARY"];
    process.env["FB2READ_LIBRARY"] = lib;
    const сервер = await raise(книги, местаЛомаются);
    try {
      const code = await cmdPull({ url: сервер.url, token: "proba-token" }, undefined, true, store());
      // Читаем файл состояния до уборки: recent() отбрасывает записи, у
      // которых книги на диске уже нет.
      // Файла может не быть вовсе: без пришедших мест писать в него нечего.
      let записано: Record<string, { block?: number } | undefined> = {};
      try {
        записано = JSON.parse(readFileSync(join(dir, "positions.json"), "utf-8")) as typeof записано;
      } catch {
        записано = {};
      }
      return { code, log: сервер.log, files: readdirSync(lib).sort(), записано };
    } finally {
      await сервер.close();
      if (было === undefined) delete process.env["FB2READ_LIBRARY"];
      else process.env["FB2READ_LIBRARY"] = было;
      rmSync(lib, { recursive: true, force: true });
    }
  }

  it("места спрашиваются один раз, а не по разу на книгу", async () => {
    // Здесь и была O(n²): список мест выгружался заново для каждой книги, и
    // на пяти книгах выходило одиннадцать запросов вместо семи.
    const { code, log, files, записано } = await pullAll(3);
    expect(code).toBe(0);
    expect(files).toEqual(["Книга 1.fb2", "Книга 2.fb2", "Книга 3.fb2"]);
    expect(log.filter((path) => path === "/api/v1/state")).toHaveLength(1);
    expect(log).toHaveLength(5);
    // И место при этом доехало: один запрос вместо трёх — не повод потерять
    // позицию, ради которой всё и затевалось.
    expect(Object.values(записано).filter((r) => r?.block === 20)).toHaveLength(1);
  });

  it("книги скачиваются, даже если места не пришли, и об этом сказано", async () => {
    // Без позиции книга откроется с начала — досадно; без книги открывать
    // будет нечего вовсе. Молчать при этом нельзя: читатель решит, что
    // позиция потерялась сама.
    const жалобы: string[] = [];
    const перехват = vi.spyOn(process.stderr, "write").mockImplementation((line) => {
      жалобы.push(String(line));
      return true;
    });
    let итог: Awaited<ReturnType<typeof pullAll>>;
    try {
      итог = await pullAll(2, true);
    } finally {
      перехват.mockRestore();
    }
    expect(итог.code).toBe(0);
    expect(итог.files).toEqual(["Книга 1.fb2", "Книга 2.fb2"]);
    expect(жалобы.join("")).toContain("места с сервера не пришли");
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
  function raise(было: string[], похоронено: string[] = []): Promise<{
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
            buried: похоронено,
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

  async function keep(было: string[], hash = HASH, похоронено: string[] = []) {
    const { keepOnServer } = await import("../src/sync.js");
    const file = join(dir, "Анна Каренина.fb2");
    writeFileSync(file, книга);
    const сервер = await raise(было, похоронено);
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

  it("удалённую с сервера при открытии не возвращает", async () => {
    // Иначе forget не значит ничего: книга осталась на устройстве, читатель
    // её открыл — и она уехала обратно, никого не спросив. Молча: убрал он
    // её сам, а вернёт явное `fb2read push книга.fb2`.
    const { note, uploaded } = await keep([], HASH, [HASH]);
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
  function raise(похоронено: string[] = []): Promise<{
    url: string;
    names: string[];
    revived: string[];
    close: () => Promise<void>;
  }> {
    const names: string[] = [];
    const revived: string[] = [];
    const hashes = new Set<string>();
    const buried = new Set(похоронено);
    const s = createServer((request, response) => {
      const path = (request.url ?? "").split("?")[0]!;
      if (request.method === "GET" && path === "/api/v1/books") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({
            books: [...hashes].map((hash) => ({
              hash, name: "х.fb2", size: 1, title: "", author: "", updatedAt: 1,
            })),
            buried: [...buried],
          }),
        );
        return;
      }
      if (request.method === "PUT" && path.startsWith("/api/v1/books/")) {
        const chunks: Buffer[] = [];
        request.on("data", (c: Buffer) => chunks.push(c));
        request.on("end", () => {
          const hash = path.slice("/api/v1/books/".length);
          const revive = request.headers["x-revive"] === "1";
          if (buried.has(hash) && !revive) {
            response.writeHead(410, { "Content-Type": "application/json" });
            response.end(JSON.stringify({ error: "эта книга удалена с сервера" }));
            return;
          }
          if (revive) {
            revived.push(hash);
            buried.delete(hash);
          }
          hashes.add(hash);
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
          revived,
          close: () => new Promise<void>((r) => s.close(() => r())),
        }),
      );
    });
  }

  async function push(target: string | undefined, all: boolean, lib: string, похоронено: string[] = []) {
    const { cmdPush } = await import("../src/sync.js");
    const было = process.env["FB2READ_LIBRARY"];
    process.env["FB2READ_LIBRARY"] = lib;
    const сервер = await raise(похоронено);
    try {
      const code = await cmdPush({ url: сервер.url, token: "proba-token" }, target, all, store());
      return { code, names: сервер.names, revived: сервер.revived };
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

  it("каталогом удалённое с сервера не возвращается", async () => {
    // «Выгрузи библиотеку» — не «верни всё, что я когда-то удалил»: иначе
    // одна такая выгрузка отменяла бы все прошлые forget разом.
    const lib = library();
    const первая = await sha256Hex(книга("Первая"));
    const { code, names } = await push(lib, false, lib, [первая]);
    expect(code).toBe(0);
    expect(names).toEqual(["Вторая.fb2"]);
    rmSync(lib, { recursive: true, force: true });
  });

  it("названную книгу сервер возвращает по просьбе", async () => {
    // Удаляют и по ошибке, а иначе вернуть книгу нечем вовсе.
    const lib = library();
    const первая = await sha256Hex(книга("Первая"));
    const { code, names, revived } = await push(join(lib, "Первая.fb2"), false, lib, [первая]);
    expect(code).toBe(0);
    expect(names).toEqual(["Первая.fb2"]);
    expect(revived).toEqual([первая]);
    rmSync(lib, { recursive: true, force: true });
  });

  it("без пути и без --all объясняет, чего ждали", async () => {
    const { cmdPush } = await import("../src/sync.js");
    expect(await cmdPush({ url: "http://127.0.0.1:1" }, undefined, false, store())).toBe(2);
  });
});

describe("удаление книги с сервера", () => {
  /** Сервер, помнящий, что у него просили удалить. */
  function raise(books: { hash: string; name: string; title: string }[]): Promise<{
    url: string;
    deleted: string[];
    close: () => Promise<void>;
  }> {
    const deleted: string[] = [];
    const s = createServer((request, response) => {
      const path = (request.url ?? "").split("?")[0]!;
      if (request.method === "DELETE" && path.startsWith("/api/v1/books/")) {
        deleted.push(path.slice("/api/v1/books/".length));
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ ok: true }));
        return;
      }
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          books: books.map((b) => ({ ...b, size: 1, author: "", updatedAt: 1 })),
        }),
      );
    });
    return new Promise((done) => {
      s.listen(0, "127.0.0.1", () =>
        done({
          url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`,
          deleted,
          close: () => new Promise<void>((r) => s.close(() => r())),
        }),
      );
    });
  }

  const ОДНА = "1".repeat(64);
  const ДРУГАЯ = "2".repeat(64);
  // Общее начало с ОДНОЙ: именно так и возникает неоднозначность.
  const ПОХОЖАЯ = "1".repeat(8) + "3".repeat(56);

  async function forget(target: string | undefined, books = [{ hash: ОДНА, name: "к.fb2", title: "Книга" }]) {
    const { cmdForget } = await import("../src/sync.js");
    const сервер = await raise(books);
    try {
      const code = await cmdForget({ url: сервер.url, token: "proba-token" }, target);
      return { code, deleted: сервер.deleted };
    } finally {
      await сервер.close();
    }
  }

  it("удаляет книгу по началу отпечатка", async () => {
    // Отпечаток целиком никто набирать не станет — как и с номерами коммитов.
    const { code, deleted } = await forget(ОДНА.slice(0, 8));
    expect(code).toBe(0);
    expect(deleted).toEqual([ОДНА]);
  });

  it("удаляет книгу по имени файла", async () => {
    const { code, deleted } = await forget("к.fb2");
    expect(code).toBe(0);
    expect(deleted).toEqual([ОДНА]);
  });

  it("при неоднозначности не удаляет ничего, а спрашивает", async () => {
    // Удаление необратимо: выбрать за читателя тут нельзя. Начало отпечатка
    // подходит двум книгам — значит, не удаляется ни одна.
    const { code, deleted } = await forget("1".repeat(8), [
      { hash: ОДНА, name: "первая.fb2", title: "Первая" },
      { hash: ПОХОЖАЯ, name: "вторая.fb2", title: "Вторая" },
    ]);
    expect(code).toBe(1);
    expect(deleted).toEqual([]);
  });

  it("книга с чужим началом отпечатка под удаление не попадает", async () => {
    const { code, deleted } = await forget(ОДНА.slice(0, 8), [
      { hash: ОДНА, name: "первая.fb2", title: "Первая" },
      { hash: ДРУГАЯ, name: "вторая.fb2", title: "Вторая" },
    ]);
    expect(code).toBe(0);
    expect(deleted).toEqual([ОДНА]);
  });

  it("о ненайденной книге говорит словами", async () => {
    const { code, deleted } = await forget("нет-такой");
    expect(code).toBe(1);
    expect(deleted).toEqual([]);
  });

  it("без аргумента объясняет, чего ждали", async () => {
    const { cmdForget } = await import("../src/sync.js");
    expect(await cmdForget({ url: "http://127.0.0.1:1" }, undefined)).toBe(2);
  });
});
