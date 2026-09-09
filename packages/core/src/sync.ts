/**
 * Синхронизация: слияние состояния и клиент сервера.
 *
 * Слияние вынесено в чистые функции без сети и времени: те же правила
 * работают и на устройстве, и на сервере, и проверяются тестами без
 * поднятия чего бы то ни было. Клиент — тонкая обёртка над fetch.
 *
 * Книга узнаётся по отпечатку содержимого (sha256), а не по пути: на другом
 * устройстве путь другой, а книга та же. Ключ позиции в positions.json при
 * этом остаётся прежним, совместимым с версией на Python.
 *
 * Время везде в секундах, как в positions.json.
 */

import type { Bookmark } from "./state.js";

// --- Что синхронизации нужно от платформы ---------------------------------
//
// Типы сети описаны здесь, а не в globals.d.ts, и взяты из globalThis по
// имени. Причина не в чистоплюйстве: объявленный глобально `fetch` сливается
// с тем, что объявляет платформа, и сборка ломается на несовпадении
// сигнатур — Node принимает URL, а нам довольно строки. Так список допущений
// лежит рядом с кодом, который их делает, и ни с чем не спорит.

/** Ответ сервера — ровно то, что читает клиент. */
export interface SyncResponse {
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

/** Запрос: метод, заголовки, тело и признак отмены. */
export interface SyncRequest {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  signal?: unknown;
}

/** Чем ходить в сеть. Подменяется в тестах и в браузере. */
export type SyncFetch = (url: string, init?: SyncRequest) => Promise<SyncResponse>;

interface Ambient {
  fetch?: SyncFetch;
  AbortController?: new () => { signal: unknown; abort(): void };
  setTimeout?: (handler: () => void, ms: number) => unknown;
  clearTimeout?: (id: unknown) => void;
}

const ambient = globalThis as unknown as Ambient;

/** Состояние книги в том виде, в каком оно ходит между устройствами. */
export interface SyncState {
  hash: string;
  block: number;
  total: number;
  title: string;
  author: string;
  /** Когда позиция была записана, в секундах. */
  at: number;
  /** Чьё это устройство — видно в `fb2read remote`. */
  device?: string;
  bookmarks: Bookmark[];
}

/** Книга на сервере. */
export interface RemoteBook {
  hash: string;
  name: string;
  size: number;
  title: string;
  author: string;
  updatedAt: number;
}

/** Расхождение часов, после которого сервер предупреждает, в секундах. */
export const SKEW_LIMIT = 300;

/**
 * Слияние позиций: побеждает та, что записана позже.
 *
 * При равном времени берётся вторая. На сервере вторая — это та, что пришла
 * сейчас, так что при совпадении до секунды выигрывает более поздний приход.
 * Совсем без правила тут нельзя: две записи с одинаковым `at` иначе давали
 * бы разный ответ в зависимости от порядка аргументов.
 */
export function mergePosition(a: SyncState, b: SyncState): SyncState {
  return b.at >= a.at ? b : a;
}

/**
 * Слияние закладок: объединение по номеру блока.
 *
 * На один блок остаётся одна запись — та, что новее. Снятие закладки хранится
 * не как отсутствие, а как надгробие `{block, deleted: true}`: иначе закладка,
 * снятая на ноутбуке, вернулась бы с телефона, который о снятии не знает.
 *
 * Список от этого не растёт без предела: записей ровно столько, сколько
 * разных блоков когда-либо отмечали, — повторные постановка и снятие
 * переписывают одну и ту же запись.
 *
 * У закладок из старых файлов времени нет; такая считается самой давней и
 * уступает любой датированной. Это верно по сути: датированную запись сделали
 * заведомо позже, чем ту, которую версия без синхронизации даже не помечала.
 */
export function mergeBookmarks(
  a: readonly Bookmark[] = [],
  b: readonly Bookmark[] = [],
): Bookmark[] {
  const best = new Map<number, Bookmark>();
  for (const mark of [...a, ...b]) {
    if (!mark || typeof mark.block !== "number") continue;
    const previous = best.get(mark.block);
    if (!previous || (mark.at ?? 0) >= (previous.at ?? 0)) best.set(mark.block, mark);
  }
  return [...best.values()].sort((x, y) => x.block - y.block);
}

/** Полное слияние состояния книги: позиция по времени, закладки объединением. */
export function mergeState(a: SyncState, b: SyncState): SyncState {
  const winner = mergePosition(a, b);
  return { ...winner, bookmarks: mergeBookmarks(a.bookmarks, b.bookmarks) };
}

/** Закладки без надгробий — то, что показывают читателю. */
export function liveBookmarks(marks: readonly Bookmark[] = []): Bookmark[] {
  return marks.filter((m) => !m.deleted);
}

/** Ошибка синхронизации с готовым к печати сообщением. */
export class SyncError extends Error {
  constructor(
    message: string,
    /** Код ответа сервера, если ответ вообще был. */
    readonly status = 0,
  ) {
    super(message);
    this.name = "SyncError";
  }
}

/** Как связываться с сервером. */
export interface SyncOptions {
  /** Адрес сервера, например https://books.example.org */
  url: string;
  token?: string;
  /** Имя устройства: видно в списке книг на сервере. */
  device?: string;
  /** Сколько ждать ответа, в миллисекундах. */
  timeoutMs?: number;
  /** Подменяется в тестах и в браузере. */
  fetch?: SyncFetch;
}

/**
 * Токен уезжает в заголовке Authorization, а заголовки HTTP — только
 * латиница. Кириллический токен не отвергается сетью, а роняет сам вызов
 * невнятной ошибкой про ByteString, поэтому лучше сказать прямо и сразу.
 */
function checkToken(token: string): void {
  if (!/^[\x21-\x7e]+$/.test(token)) {
    throw new SyncError(
      "токен должен состоять из латинских букв, цифр и знаков: в заголовке HTTP другого не передать",
    );
  }
}

/** Убирает завершающие косые черты, чтобы адрес складывался предсказуемо. */
function trimSlashes(url: string): string {
  return url.replace(/\/+$/, "");
}

/**
 * Клиент сервера синхронизации.
 *
 * Все ошибки — сети, кода ответа, разбора — приходят как SyncError с текстом,
 * который можно показать читателю без перевода.
 */
export class SyncClient {
  private readonly base: string;
  private readonly timeoutMs: number;
  private readonly send: SyncFetch;

  constructor(private readonly options: SyncOptions) {
    if (!options.url) throw new SyncError("не задан адрес сервера");
    if (options.token) checkToken(options.token);
    this.base = `${trimSlashes(options.url)}/api/v1`;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    const send = options.fetch ?? ambient.fetch;
    if (!send) throw new SyncError("здесь нет fetch: синхронизация недоступна");
    this.send = send;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const out: Record<string, string> = { ...extra };
    if (this.options.token) out["Authorization"] = `Bearer ${this.options.token}`;
    return out;
  }

  /**
   * Запрос с ограничением по времени.
   *
   * Без таймаута читалка при недоступном сервере ждала бы до упора: сеть
   * может не отвечать, не разрывая соединение.
   */
  private async request(path: string, init: SyncRequest = {}): Promise<SyncResponse> {
    const controller = ambient.AbortController ? new ambient.AbortController() : null;
    const timer = controller ? ambient.setTimeout?.(() => controller.abort(), this.timeoutMs) : null;
    let response: SyncResponse;
    try {
      response = await this.send(`${this.base}${path}`, { ...init, signal: controller?.signal });
    } catch (e) {
      const reason = (e as Error).name === "AbortError" ? "сервер не ответил вовремя" : (e as Error).message;
      throw new SyncError(`сервер недоступен: ${reason}`);
    } finally {
      if (timer !== null) ambient.clearTimeout?.(timer);
    }
    if (!response.ok) throw new SyncError(await describe(response), response.status);
    return response;
  }

  private async json<T>(path: string, init: SyncRequest = {}): Promise<T> {
    const response = await this.request(path, init);
    const text = await response.text();
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new SyncError("сервер ответил не тем, что ожидалось");
    }
  }

  /** Книги, лежащие на сервере. */
  async list(): Promise<RemoteBook[]> {
    const data = await this.json<{ books?: RemoteBook[] }>("/books", { headers: this.headers() });
    return data.books ?? [];
  }

  /**
   * Выгружает книгу.
   *
   * Повторная выгрузка того же содержимого ничего не портит: имя файла и
   * отпечаток совпадут, сервер просто подтвердит, что книга уже есть.
   */
  async upload(
    hash: string,
    name: string,
    data: Uint8Array,
    meta: { title?: string; author?: string } = {},
  ): Promise<void> {
    // Имена и названия бывают русскими, а в заголовке допустима только
    // латиница, поэтому они едут процентным кодированием.
    const headers: Record<string, string> = {
      "Content-Type": "application/octet-stream",
      "X-Name": encodeURIComponent(name),
    };
    if (meta.title) headers["X-Title"] = encodeURIComponent(meta.title);
    if (meta.author) headers["X-Author"] = encodeURIComponent(meta.author);
    await this.request(`/books/${hash}`, {
      method: "PUT",
      headers: this.headers(headers),
      body: data,
    });
  }

  /** Скачивает книгу по отпечатку. */
  async download(hash: string): Promise<Uint8Array> {
    const response = await this.request(`/books/${hash}`, { headers: this.headers() });
    return new Uint8Array(await response.arrayBuffer());
  }

  /** Удаляет книгу вместе с её состоянием. */
  async remove(hash: string): Promise<void> {
    await this.request(`/books/${hash}`, { method: "DELETE", headers: this.headers() });
  }

  /** Состояния, изменённые после указанного времени (в секундах). */
  async states(since = 0): Promise<SyncState[]> {
    const data = await this.json<{ states?: SyncState[] }>(`/state?since=${since}`, {
      headers: this.headers(),
    });
    return data.states ?? [];
  }

  /**
   * Отправляет состояние книги и получает слитое.
   *
   * Ответ может нести предупреждение — например, о разошедшихся часах:
   * тогда слияние по времени врёт, и читателю лучше об этом знать.
   */
  async pushState(state: SyncState): Promise<{ state: SyncState; warning?: string }> {
    const body = { ...state, device: state.device ?? this.options.device };
    return this.json<{ state: SyncState; warning?: string }>(`/state/${state.hash}`, {
      method: "PUT",
      headers: this.headers({ "Content-Type": "application/json" }),
      body: JSON.stringify(body),
    });
  }
}

/** Разбирает ответ с ошибкой: сервер объясняет причину, если может. */
async function describe(response: SyncResponse): Promise<string> {
  let detail = "";
  try {
    const text = await response.text();
    const data: unknown = JSON.parse(text);
    if (data && typeof data === "object" && typeof (data as { error?: unknown }).error === "string") {
      detail = (data as { error: string }).error;
    } else if (text) {
      detail = text.slice(0, 200);
    }
  } catch {
    // Ответ без тела или не JSON — обойдёмся кодом.
  }
  if (response.status === 401 || response.status === 403) {
    return detail || "сервер не принял токен";
  }
  if (response.status === 404) return detail || "на сервере такого нет";
  if (response.status === 413) return detail || "книга больше, чем сервер согласен принять";
  return detail ? `сервер ответил ${response.status}: ${detail}` : `сервер ответил ${response.status}`;
}
