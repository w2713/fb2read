/**
 * Сервер синхронизации: /api/v1 поверх node:http.
 *
 * Ничего лишнего: ни фреймворка, ни базы. Задача узкая — принять книгу,
 * отдать книгу, слить состояние, — и на неё хватает того, что есть в Node.
 *
 * TLS тут нет намеренно: сервер ставят за Caddy или nginx, которые умеют
 * сертификаты лучше. Пример в README.
 */

import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { SKEW_LIMIT, sha256Hex, type SyncState } from "@fb2read/core";
import { Storage, isHash, safeExt, type BookEntry } from "./storage.js";

/** Настройки сервера. */
export interface ServerOptions {
  /** Каталог с данными. */
  dir: string;
  /** Токены: имя пользователя → токен. Пустой список недопустим. */
  tokens: Map<string, string>;
  /** Предел размера книги в байтах. */
  maxBytes?: number;
  /** Откуда пускать браузер (для PWA); пусто — CORS не выдаётся. */
  origin?: string;
}

const DEFAULT_MAX_BYTES = 200 * 1024 * 1024;

/**
 * Сравнение токенов за одинаковое время.
 *
 * Обычное `===` выходит из сравнения на первом несовпавшем символе, и по
 * времени ответа токен можно подобрать посимвольно. Здесь сравниваются все
 * символы всегда.
 */
function sameToken(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Имя пользователя становится именем каталога, поэтому обезвреживается.
 *
 * Убирается ровно опасное: разделители пути, ведущие точки (иначе `..`
 * выведет наружу), управляющие символы и то, что запрещает Windows. Русские
 * буквы остаются: каталог с именем «сосед» читается глазами, а вырезание
 * всего, кроме латиницы, схлопывало бы «я» и «сосед» в одно пустое имя —
 * и второй токен молча затирал бы первый.
 */
export function safeName(name: string): string {
  const cleaned = name
    // eslint-disable-next-line no-control-regex
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "")
    .replace(/^\.+/, "")
    .trim();
  return cleaned || "default";
}

/**
 * Разбирает FB2READ_SERVER_TOKENS.
 *
 * Формат — `имя:токен` через запятую; несколько записей значат несколько
 * пользователей, у каждого свой каталог. Без имени пользователь называется
 * `default`.
 */
export function parseTokens(raw: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const piece of (raw ?? "").split(",")) {
    const item = piece.trim();
    if (!item) continue;
    const at = item.indexOf(":");
    const name = at === -1 ? "default" : item.slice(0, at).trim();
    const token = at === -1 ? item : item.slice(at + 1).trim();
    if (!token) continue;
    const safe = safeName(name);
    // Два имени, сошедшиеся в одно, поделили бы каталог и потеряли бы токен.
    // Это ошибка настройки, и молчать о ней нельзя.
    if (out.has(safe)) {
      throw new Error(`двое пользователей называются «${safe}»: у каждого должно быть своё имя`);
    }
    out.set(safe, token);
  }
  return out;
}

function json(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
    ...headers,
  });
  response.end(text);
}

/**
 * Читает тело запроса, не давая ему перерасти предел.
 *
 * Перебор — это не обрыв связи: соединение нужно сохранить живым, чтобы
 * отправить внятный отказ. Рвать сокет на середине значит показать читателю
 * «сервер недоступен» вместо «книга слишком велика».
 *
 * Само содержимое сверх предела в память не берётся: остаток дочитывается и
 * выбрасывается. В подавляющем большинстве случаев до этого не доходит —
 * размер виден заранее из Content-Length.
 */
function readBody(request: IncomingMessage, limit: number): Promise<Uint8Array> {
  const declared = Number.parseInt(String(request.headers["content-length"] ?? ""), 10);
  if (Number.isFinite(declared) && declared > limit) {
    request.resume();
    return Promise.reject(new TooBig());
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    request.on("data", (chunk: Buffer) => {
      if (over) return;
      size += chunk.length;
      if (size > limit) {
        over = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (over) reject(new TooBig());
      else resolve(new Uint8Array(Buffer.concat(chunks)));
    });
    request.on("error", reject);
  });
}

class TooBig extends Error {}

/** Собирает обработчик запросов. */
export function createHandler(options: ServerOptions) {
  const storage = new Storage(options.dir);
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

  const cors: Record<string, string> = options.origin
    ? {
        "Access-Control-Allow-Origin": options.origin,
        "Access-Control-Allow-Methods": "GET, PUT, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Name",
        "Access-Control-Max-Age": "86400",
      }
    : {};

  /** Кому принадлежит токен из заголовка, или null. */
  function whose(request: IncomingMessage): string | null {
    const header = request.headers["authorization"];
    if (typeof header !== "string" || !header.startsWith("Bearer ")) return null;
    const token = header.slice(7).trim();
    for (const [user, known] of options.tokens) {
      if (sameToken(token, known)) return user;
    }
    return null;
  }

  return async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://server");
    const path = url.pathname;

    if (request.method === "OPTIONS" && options.origin) {
      response.writeHead(204, cors);
      response.end();
      return;
    }

    // Проба живости: без токена, чтобы reverse proxy мог её опрашивать.
    if (path === "/api/v1/health") {
      json(response, 200, { ok: true }, cors);
      return;
    }

    if (!path.startsWith("/api/v1/")) {
      json(response, 404, { error: "нет такого пути" }, cors);
      return;
    }

    const user = whose(request);
    if (!user) {
      json(response, 401, { error: "нужен токен: Authorization: Bearer ..." }, cors);
      return;
    }

    try {
      await route(request, response, user, url, path);
    } catch (e) {
      if (e instanceof TooBig) {
        json(response, 413, { error: `книга больше ${Math.round(maxBytes / 1048576)} МБ` }, cors);
        return;
      }
      json(response, 500, { error: (e as Error).message }, cors);
    }
  };

  async function route(
    request: IncomingMessage,
    response: ServerResponse,
    user: string,
    url: URL,
    path: string,
  ): Promise<void> {
    const rest = path.slice("/api/v1/".length);

    if (rest === "books" && request.method === "GET") {
      const books = await storage.books(user);
      json(response, 200, { books: books.map(({ ext: _ext, ...rest }) => rest) }, cors);
      return;
    }

    if (rest.startsWith("books/")) {
      const hash = rest.slice("books/".length);
      if (!isHash(hash)) {
        json(response, 400, { error: "отпечаток должен быть sha256 в шестнадцатеричном виде" }, cors);
        return;
      }
      if (request.method === "PUT") return putBook(request, response, user, hash);
      if (request.method === "GET") return getBook(response, user, hash);
      if (request.method === "DELETE") {
        const removed = await storage.deleteBook(user, hash);
        json(response, removed ? 200 : 404, removed ? { ok: true } : { error: "такой книги нет" }, cors);
        return;
      }
    }

    if (rest === "state" && request.method === "GET") {
      const since = Number.parseFloat(url.searchParams.get("since") ?? "0");
      const states = await storage.statesSince(user, Number.isFinite(since) ? since : 0);
      json(response, 200, { states }, cors);
      return;
    }

    if (rest.startsWith("state/") && request.method === "PUT") {
      const hash = rest.slice("state/".length);
      if (!isHash(hash)) {
        json(response, 400, { error: "отпечаток должен быть sha256 в шестнадцатеричном виде" }, cors);
        return;
      }
      return putState(request, response, user, hash);
    }

    json(response, 404, { error: "нет такого пути" }, cors);
  }

  async function putBook(
    request: IncomingMessage,
    response: ServerResponse,
    user: string,
    hash: string,
  ): Promise<void> {
    const data = await readBody(request, maxBytes);

    // Сверяем отпечаток. Иначе книгу можно было бы положить под чужим
    // именем — и другое устройство скачало бы не то, что ждёт.
    const actual = await sha256Hex(data);
    if (actual !== hash) {
      json(response, 400, { error: "содержимое не совпало с отпечатком" }, cors);
      return;
    }

    const header = request.headers["x-name"];
    // Имя приезжает процентным кодированием: в заголовке допустима латиница,
    // а книги называются по-русски.
    let name = "книга.fb2";
    if (typeof header === "string" && header) {
      try {
        name = decodeURIComponent(header);
      } catch {
        name = header;
      }
    }

    const previous = await storage.book(user, hash);
    const entry: BookEntry = {
      hash,
      name,
      size: data.length,
      title: readString(request.headers["x-title"]) || previous?.title || "",
      author: readString(request.headers["x-author"]) || previous?.author || "",
      updatedAt: Date.now() / 1000,
      ext: safeExt(name),
    };
    await storage.putBook(user, entry, data);
    json(response, 200, { ok: true, hash }, cors);
  }

  async function getBook(response: ServerResponse, user: string, hash: string): Promise<void> {
    const data = await storage.readBook(user, hash);
    if (!data) {
      json(response, 404, { error: "такой книги нет" }, cors);
      return;
    }
    response.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Length": data.length,
      ...cors,
    });
    response.end(Buffer.from(data));
  }

  async function putState(
    request: IncomingMessage,
    response: ServerResponse,
    user: string,
    hash: string,
  ): Promise<void> {
    const body = await readBody(request, 4 * 1024 * 1024);
    let incoming: SyncState;
    try {
      incoming = JSON.parse(new TextDecoder().decode(body)) as SyncState;
    } catch {
      json(response, 400, { error: "тело не разобралось как JSON" }, cors);
      return;
    }
    if (!incoming || typeof incoming.block !== "number") {
      json(response, 400, { error: "в состоянии нет позиции" }, cors);
      return;
    }

    const now = Date.now() / 1000;
    incoming = {
      ...incoming,
      hash,
      bookmarks: Array.isArray(incoming.bookmarks) ? incoming.bookmarks : [],
      at: typeof incoming.at === "number" ? incoming.at : now,
    };

    const merged = await storage.mergeIn(user, incoming, now);

    // Слияние держится на времени. Если часы устройства ушли, оно начнёт
    // выигрывать или проигрывать чужие записи ни за что — про это надо
    // сказать, а не молча испортить позицию.
    const skew = Math.abs(incoming.at - now);
    const warning =
      skew > SKEW_LIMIT
        ? `часы устройства расходятся с сервером на ${Math.round(skew / 60)} мин: позиция может слиться неверно`
        : undefined;

    json(response, 200, warning ? { state: merged, warning } : { state: merged }, cors);
  }
}

function readString(value: string | string[] | undefined): string {
  if (typeof value !== "string" || !value) return "";
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Поднимает сервер. Порт 0 значит «любой свободный» — так делают тесты. */
export function createServer(options: ServerOptions): Server {
  if (!options.tokens.size) {
    throw new Error("не задан ни один токен: сервер без них пускал бы кого угодно");
  }
  // Токен приезжает в заголовке Authorization, а заголовки HTTP — только
  // латиница. Кириллический токен не смог бы дойти ни от одного клиента, и
  // сервер отвечал бы «нужен токен» на верный, с точки зрения хозяина, токен.
  // Лучше отказаться запускаться, чем оставить его гадать.
  for (const [user, token] of options.tokens) {
    if (!/^[\x21-\x7e]+$/.test(token)) {
      throw new Error(
        `токен пользователя ${user} содержит не латиницу: такой не передать в заголовке HTTP, ` +
          "возьмите, например, openssl rand -hex 32",
      );
    }
  }
  const handle = createHandler(options);
  return createHttpServer((request, response) => {
    void handle(request, response).catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
}
