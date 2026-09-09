/**
 * Синхронизация со стороны читалки: команды и фоновое слияние.
 *
 * Правила слияния живут в ядре и здесь не повторяются. Тут — где взять
 * настройки, что считать книгой, куда класть скачанное и как сказать
 * читателю о том, что вышло.
 *
 * Главное правило: синхронизация никогда не мешает читать. Нет сети, нет
 * сервера, не тот токен — книга всё равно открывается, а о неудаче
 * сообщается словами и один раз.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { basename, join, resolve } from "node:path";
import {
  SyncClient,
  SyncError,
  bookKey,
  mergeState,
  progressPercent,
  quickMeta,
  sha256Hex,
  type RemoteBook,
  type SyncPrefs,
  type SyncState,
} from "@fb2read/core";
import { FileSource } from "./fsSource.js";
import type { JsonFileStore } from "./store.js";

/** Куда складывать книги, скачанные с сервера. */
export function libraryDir(): string {
  return process.env["FB2READ_LIBRARY"] ?? join(process.env["HOME"] ?? ".", "Books", "fb2read");
}

/** Готовые к работе настройки синхронизации. */
export interface SyncSettings {
  url: string;
  token?: string;
  auto: boolean;
  device: string;
}

/**
 * Собирает настройки из конфига и окружения.
 *
 * Переменная окружения сильнее конфига: так токен можно держать вне файла —
 * например, доставать из менеджера паролей при входе в систему.
 */
export function syncSettings(prefs: SyncPrefs): SyncSettings | null {
  const url = process.env["FB2READ_SYNC_URL"] ?? prefs.url;
  if (!url) return null;
  const token = process.env["FB2READ_SYNC_TOKEN"] ?? prefs.token;
  const settings: SyncSettings = {
    url,
    auto: prefs.auto ?? false,
    device: process.env["FB2READ_DEVICE"] ?? hostname(),
  };
  if (token) settings.token = token;
  return settings;
}

/** Клиент по настройкам; таймаут короткий — читалка не должна ждать. */
export function clientFor(settings: SyncSettings, timeoutMs = 10_000): SyncClient {
  const options = {
    url: settings.url,
    device: settings.device,
    timeoutMs,
    ...(settings.token ? { token: settings.token } : {}),
  };
  return new SyncClient(options);
}

/** Печать без затей: команды синхронизации выводят обычные строки. */
type Say = (line: string) => void;

const out: Say = (line) => process.stdout.write(`${line}\n`);
const err: Say = (line) => process.stderr.write(`fb2read: ${line}\n`);

/** Общее начало всех команд: настройки есть — работаем, нет — объясняем. */
function prepare(prefs: SyncPrefs): SyncSettings | null {
  const settings = syncSettings(prefs);
  if (!settings) {
    err("сервер не настроен");
    err("добавьте в конфиг раздел [sync] с адресом url, либо задайте FB2READ_SYNC_URL");
    err("образец конфига пишется командой: fb2read --write-config");
    return null;
  }
  return settings;
}

/** Ошибку синхронизации показываем словами, а не следом вызовов. */
function complain(e: unknown): number {
  err(e instanceof SyncError ? e.message : (e as Error).message);
  return 1;
}

// --- fb2read remote --------------------------------------------------------

/** Список книг на сервере с прогрессом чтения. */
export async function cmdRemote(prefs: SyncPrefs): Promise<number> {
  const settings = prepare(prefs);
  if (!settings) return 2;
  const client = clientFor(settings);
  try {
    const [books, states] = await Promise.all([client.list(), client.states(0)]);
    if (!books.length) {
      out("на сервере книг нет");
      return 0;
    }
    const byHash = new Map(states.map((s) => [s.hash, s]));
    for (const book of books.sort((a, b) => a.name.localeCompare(b.name, "ru"))) {
      const state = byHash.get(book.hash);
      const percent = state ? progressPercent(state.block, state.total) : null;
      const mark = percent === null ? "   -" : `${String(percent).padStart(3)}%`;
      const where = state?.device ? `  ${state.device}` : "";
      out(`${mark}  ${book.title || book.name}${where}`);
    }
    return 0;
  } catch (e) {
    return complain(e);
  }
}

// --- fb2read push ----------------------------------------------------------

/** Выгружает книгу и её состояние на сервер. */
export async function cmdPush(prefs: SyncPrefs, file: string | undefined, store: JsonFileStore): Promise<number> {
  const settings = prepare(prefs);
  if (!settings) return 2;
  if (!file) {
    err("укажите книгу: fb2read push книга.fb2");
    return 2;
  }

  let data: Uint8Array;
  const path = resolve(file);
  try {
    data = new Uint8Array(readFileSync(path));
  } catch (e) {
    err(`${file}: ${(e as Error).message}`);
    return 1;
  }

  const hash = await sha256Hex(data);
  let meta = { title: "", author: "" };
  try {
    meta = await quickMeta(new FileSource(path));
  } catch {
    // Нечитаемая книга всё равно выгружается: разбирать её будет то
    // устройство, которое скачает.
  }

  const client = clientFor(settings, 120_000);
  try {
    out(`выгружаю ${basename(path)} (${Math.round(data.length / 1024)} КБ)`);
    await client.upload(hash, basename(path), data, meta);

    // Заодно уезжает позиция: книга без места, на котором её бросили,
    // на другом устройстве откроется с начала.
    const key = await bookKey(path, data.length);
    const local = await localState(store, key, hash);
    if (local) {
      const { warning } = await client.pushState(local);
      if (warning) err(warning);
    }
    out("готово");
    return 0;
  } catch (e) {
    return complain(e);
  }
}

// --- fb2read pull ----------------------------------------------------------

/** Скачивает книгу (или все) в каталог библиотеки. */
export async function cmdPull(
  prefs: SyncPrefs,
  target: string | undefined,
  all: boolean,
  store: JsonFileStore,
): Promise<number> {
  const settings = prepare(prefs);
  if (!settings) return 2;
  const client = clientFor(settings, 120_000);

  let books: RemoteBook[];
  try {
    books = await client.list();
  } catch (e) {
    return complain(e);
  }

  let wanted: RemoteBook[];
  if (all) {
    wanted = books;
  } else if (target) {
    // Отпечаток целиком набирать никто не станет, поэтому годится начало —
    // ровно как с номерами коммитов.
    wanted = books.filter((b) => b.hash.startsWith(target) || b.name === target);
    if (wanted.length > 1) {
      err(`под «${target}» подходит несколько книг, уточните:`);
      for (const b of wanted) err(`  ${b.hash.slice(0, 12)}  ${b.name}`);
      return 1;
    }
  } else {
    err("укажите книгу или --all: fb2read pull <отпечаток|имя>");
    if (books.length) {
      err("на сервере лежат:");
      for (const b of books) err(`  ${b.hash.slice(0, 12)}  ${b.name}`);
    }
    return 2;
  }

  if (!wanted.length) {
    err(target ? `на сервере нет «${target}»` : "на сервере книг нет");
    return 1;
  }

  const dir = libraryDir();
  try {
    mkdirSync(dir, { recursive: true });
  } catch (e) {
    err(`не удалось создать ${dir}: ${(e as Error).message}`);
    return 1;
  }

  let failed = 0;
  for (const book of wanted) {
    try {
      const data = await client.download(book.hash);
      const path = join(dir, safeFileName(book.name));
      writeFileSync(path, data);
      out(`${book.name} → ${path}`);
      await restorePosition(client, store, path, data, book.hash);
    } catch (e) {
      err(`${book.name}: ${e instanceof SyncError ? e.message : (e as Error).message}`);
      failed += 1;
    }
  }
  return failed ? 1 : 0;
}

/**
 * Ставит скачанной книге позицию с сервера.
 *
 * Ключ позиции считается от пути и размера, а путь у скачанной книги новый,
 * поэтому позицию надо перенести явно — иначе книга откроется с начала, и
 * весь смысл затеи пропадёт.
 */
async function applyRemoteState(
  client: SyncClient,
  store: JsonFileStore,
  path: string,
  data: Uint8Array,
  hash: string,
): Promise<number | null> {
  const states = await client.states(0);
  const state = states.find((s) => s.hash === hash);
  if (!state) return null;
  const key = await bookKey(path, data.length);
  await store.applyState(key, state, path);
  return progressPercent(state.block, state.total);
}

/** То же для команды pull, но с рассказом в терминал. */
async function restorePosition(
  client: SyncClient,
  store: JsonFileStore,
  path: string,
  data: Uint8Array,
  hash: string,
): Promise<void> {
  const percent = await applyRemoteState(client, store, path, data, hash);
  if (percent) out(`   позиция с сервера: ${percent}%`);
}

/**
 * Имя файла без сюрпризов.
 *
 * Убирается ровно опасное: разделители пути, ведущие точки и то, что
 * запрещает Windows. Пробелы, дефисы и кириллица остаются — «Война и
 * мир.fb2» должна остаться собой, а не превратиться в «Войнаимир.fb2».
 */
export function safeFileName(name: string): string {
  const cleaned = name
    // eslint-disable-next-line no-control-regex
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "")
    .replace(/^\.+/, "")
    .trim();
  return cleaned || "книга.fb2";
}

// --- fb2read sync ----------------------------------------------------------

/** Двусторонний обмен состоянием: книги не передаются. */
export async function cmdSync(prefs: SyncPrefs, store: JsonFileStore): Promise<number> {
  const settings = prepare(prefs);
  if (!settings) return 2;
  const client = clientFor(settings, 30_000);

  const local = await store.syncableStates(settings.device);
  const skipped = await store.countWithoutHash();

  try {
    let changed = 0;
    for (const state of local) {
      // Ключ и путь на сервер не едут: там они бесполезны, а путь на диске
      // этого устройства — не то, что стоит рассылать.
      const { key, path, ...wire } = state;
      const { state: merged, warning } = await client.pushState(wire);
      if (warning) err(warning);
      // Записываем всегда. Сравнивать по числу закладок нельзя: снятая и
      // поставленная дают одно и то же число, и слитое состояние тогда не
      // сохранялось бы — снятая закладка воскресала бы при каждом обмене.
      await store.applyState(key, merged, path);
      if (differs(wire, merged)) changed += 1;
    }
    out(
      local.length
        ? `обменялись состоянием ${local.length} книг, обновилось ${changed}`
        : "нечего синхронизировать",
    );
    if (skipped) {
      // Книги, читанные до появления синхронизации, отпечатка не имеют:
      // узнать их на другом устройстве не по чему.
      out(`${skipped} книг без отпечатка пропущено — они подхватятся, когда вы их откроете`);
    }
    return 0;
  } catch (e) {
    return complain(e);
  }
}

// --- книги с сервера в списке ---------------------------------------------

/** Книга, которая есть на сервере, но не на этом устройстве. */
export interface RemoteOnly {
  hash: string;
  title: string;
  author: string;
  name: string;
}

/**
 * Книги с сервера, которых здесь нет.
 *
 * Спрашивать сервер при каждом открытии списка нельзя молча: если он
 * недоступен, список должен появиться немедленно и без облаков. Поэтому
 * ошибка здесь не поднимается — просто пустой ответ.
 */
export async function remoteOnly(settings: SyncSettings, haveHashes: Set<string>): Promise<RemoteOnly[]> {
  try {
    const books = await clientFor(settings, 3000).list();
    return books
      .filter((b) => !haveHashes.has(b.hash))
      .map((b) => ({ hash: b.hash, title: b.title || b.name, author: b.author, name: b.name }));
  } catch {
    return [];
  }
}

/** Скачивает книгу с сервера в каталог библиотеки и возвращает путь. */
export async function downloadBook(
  settings: SyncSettings,
  store: JsonFileStore,
  hash: string,
  name: string,
): Promise<string> {
  const client = clientFor(settings, 120_000);
  const data = await client.download(hash);
  const dir = libraryDir();
  mkdirSync(dir, { recursive: true });
  const path = join(dir, safeFileName(name));
  writeFileSync(path, data);
  await applyRemoteState(client, store, path, data, hash);
  return path;
}

/**
 * Пришло ли с сервера что-то новое.
 *
 * Только для счёта в отчёте: закладки сравниваются по блоку, времени и
 * пометке о снятии, потому что важна не длина списка, а его содержимое.
 */
function differs(sent: SyncState, got: SyncState): boolean {
  if (sent.block !== got.block) return true;
  const mark = (m: { block: number; at?: number; deleted?: boolean }): string =>
    `${m.block}:${m.at ?? 0}:${m.deleted ? 1 : 0}`;
  const before = new Set(sent.bookmarks.map(mark));
  return got.bookmarks.some((m) => !before.has(mark(m)));
}

// --- фоновое слияние -------------------------------------------------------

/**
 * Сливает состояние одной книги при открытии или выходе.
 *
 * Возвращает строку для строки состояния или пустую строку. Ошибку сюда
 * пропускать нельзя ни в каком виде: читатель открыл книгу, а не сервер.
 */
export async function syncOne(
  settings: SyncSettings,
  store: JsonFileStore,
  key: string,
  state: SyncState,
  path: string,
): Promise<{ state: SyncState | null; note: string }> {
  try {
    const client = clientFor(settings, 3000);
    const { state: merged, warning } = await client.pushState(state);
    const combined = mergeState(state, merged);
    await store.applyState(key, combined, path);
    if (warning) return { state: combined, note: warning };
    if (combined.block !== state.block) {
      const percent = progressPercent(combined.block, combined.total);
      return { state: combined, note: `с сервера пришла позиция ${percent ?? 0}%` };
    }
    return { state: combined, note: "" };
  } catch (e) {
    // Молча пережить нельзя — читатель должен понимать, синхронизируется
    // ли он, — но и мешать чтению это не должно.
    return { state: null, note: e instanceof SyncError ? e.message : (e as Error).message };
  }
}

/** Состояние книги из хранилища в виде, готовом к отправке. */
async function localState(store: JsonFileStore, key: string, hash: string): Promise<SyncState | null> {
  const record = await store.record(key);
  if (!record) return null;
  return {
    hash,
    block: record.block ?? 0,
    total: record.total ?? 0,
    title: record.title ?? "",
    author: record.author ?? "",
    at: record.at ?? Date.now() / 1000,
    bookmarks: record.bookmarks ?? [],
  };
}
