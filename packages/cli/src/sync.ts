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

import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { basename, join, resolve } from "node:path";
import {
  SyncClient,
  SyncError,
  bookKey,
  isBookName,
  mergeState,
  nameWithExt,
  progressPercent,
  quickMeta,
  sha256Hex,
  type Bookmark,
  type RemoteBook,
  type SyncPrefs,
  type SyncState,
} from "@fb2read/core";
import { FileSource } from "./fsSource.js";
import type { JsonFileStore } from "./store.js";

/** Куда складывать книги, скачанные с сервера. */
export function libraryDir(): string {
  // Домашний каталог берётся у системы, а не из HOME: на Windows такой
  // переменной обычно нет вовсе, и книги ложились бы в «Books\fb2read» рядом
  // с тем каталогом, откуда запустили читалку, — то есть каждый раз в новом
  // месте.
  return process.env["FB2READ_LIBRARY"] ?? join(homedir(), "Books", "fb2read");
}

/** Готовые к работе настройки синхронизации. */
export interface SyncSettings {
  url: string;
  token?: string;
  auto: boolean;
  /** Выгружать ли саму книгу на сервер, когда её открыли. */
  upload: boolean;
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
    upload: prefs.upload ?? false,
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

/** Книги в каталоге: те же, что показал бы список, и в том же порядке. */
function booksIn(dir: string): string[] {
  // Вглубь не идём намеренно: `fb2read КАТАЛОГ` показывает ровно то, что лежит
  // в самом каталоге, и выгрузка не должна расходиться со списком.
  return readdirSync(dir)
    .sort()
    .map((name) => join(dir, name))
    .filter((full) => {
      if (!isBookName(full)) return false;
      try {
        return statSync(full).isFile();
      } catch {
        return false; // исчез между чтением каталога и проверкой
      }
    });
}

/** Выгружает одну книгу вместе с её позицией. */
async function pushOne(
  client: SyncClient,
  store: JsonFileStore,
  path: string,
  data: Uint8Array,
  hash: string,
): Promise<void> {
  let meta = { title: "", author: "" };
  try {
    meta = await quickMeta(new FileSource(path));
  } catch {
    // Нечитаемая книга всё равно выгружается: разбирать её будет то
    // устройство, которое скачает.
  }
  await client.upload(hash, basename(path), data, meta);

  // Заодно уезжает позиция: книга без места, на котором её бросили,
  // на другом устройстве откроется с начала.
  const key = await bookKey(path, data.length);
  const local = await localState(store, key, hash);
  if (local) {
    const { warning } = await client.pushState(local);
    if (warning) err(warning);
  }
}

/**
 * Выгружает на сервер книгу, каталог книг или всю библиотеку.
 *
 * Каталог целиком — потому что выгружать по одной невыносимо: за этим люди
 * писали циклы в оболочке, а под Windows и цикл не всякий напишет. Уже
 * лежащее на сервере пропускается по отпечатку, и осечка на одной книге не
 * останавливает остальные: у кого-то в каталоге всегда найдётся битый файл.
 */
export async function cmdPush(
  prefs: SyncPrefs,
  target: string | undefined,
  all: boolean,
  store: JsonFileStore,
): Promise<number> {
  const settings = prepare(prefs);
  if (!settings) return 2;
  if (!target && !all) {
    err("укажите книгу, каталог или --all: fb2read push книга.fb2");
    return 2;
  }

  // --all без пути — это каталог библиотеки: туда же ложится скачанное.
  const where = target ? resolve(target) : libraryDir();
  let files: string[];
  try {
    files = statSync(where).isDirectory() ? booksIn(where) : [where];
  } catch (e) {
    err(`${target ?? where}: ${(e as Error).message}`);
    return 1;
  }
  if (!files.length) {
    err(`в ${where} книг не нашлось`);
    return 1;
  }

  const client = clientFor(settings, 300_000);
  let there: Set<string>;
  try {
    there = new Set((await client.list()).map((book) => book.hash));
  } catch (e) {
    return complain(e);
  }

  let sent = 0;
  let already = 0;
  let failed = 0;
  for (const path of files) {
    try {
      const data = new Uint8Array(readFileSync(path));
      const hash = await sha256Hex(data);
      if (there.has(hash)) {
        already += 1;
        continue;
      }
      out(`выгружаю ${basename(path)} (${Math.round(data.length / 1024)} КБ)`);
      await pushOne(client, store, path, data, hash);
      there.add(hash);
      sent += 1;
    } catch (e) {
      err(`${basename(path)}: ${e instanceof SyncError ? e.message : (e as Error).message}`);
      failed += 1;
    }
  }

  // Итог словами: «готово» после десятка строк не говорит, что вышло.
  const parts = [`выгружено: ${sent}`];
  if (already) parts.push(`уже было: ${already}`);
  if (failed) parts.push(`не вышло: ${failed}`);
  out(parts.join(", "));
  return failed ? 1 : 0;
}

/**
 * Выгружает открытую книгу на сервер, если её там ещё нет.
 *
 * Затевается ради того, чтобы книгу не приходилось отправлять руками: открыл
 * на ноутбуке — вечером она уже на телефоне. Поэтому запускается при открытии
 * и работает, пока человек читает: книга весит мегабайты, и ждать её отправки
 * ни на входе, ни на выходе читателю незачем.
 *
 * Ошибку наружу не пускает: читатель открыл книгу, а не сервер. Но и молчать о
 * ней нельзя — она возвращается строкой, и тот, кто вызвал, её показывает.
 */
export async function keepOnServer(
  settings: SyncSettings,
  path: string,
  meta: { hash: string; title: string; author: string },
): Promise<string> {
  try {
    const client = clientFor(settings, 300_000);
    // Сперва спрашиваем, есть ли книга: заново лить сорок мегабайт при каждом
    // открытии — не то, чего ждут от чтения книги.
    const there = await client.list();
    if (there.some((book) => book.hash === meta.hash)) return "";
    const data = new Uint8Array(readFileSync(path));
    await client.upload(meta.hash, basename(path), data, {
      title: meta.title,
      author: meta.author,
    });
    return `книга выгружена на сервер: ${meta.title || basename(path)}`;
  } catch (e) {
    const why = e instanceof SyncError ? e.message : (e as Error).message;
    return `книгу не удалось выгрузить: ${why}`;
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
      const path = join(dir, nameWithExt(safeFileName(book.name), data));
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
 *
 * Расширения здесь не касаемся: его дописывает nameWithExt, которому видны
 * байты книги.
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
  const path = join(dir, nameWithExt(safeFileName(name), data));
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

/**
 * Обмен состоянием всех книг — молча, для нажатия клавиши в списке.
 *
 * От команды `sync` отличается тем, что ничего не печатает: на экране список
 * книг, и писать поверх него нельзя. Итог возвращается строкой.
 */
export async function syncAllQuiet(
  settings: SyncSettings,
  store: JsonFileStore,
): Promise<string> {
  const local = await store.syncableStates(settings.device);
  if (!local.length) {
    const skipped = await store.countWithoutHash();
    return skipped
      ? `нечего синхронизировать: ${skipped} книг без отпечатка, откройте их`
      : "нечего синхронизировать";
  }
  const client = clientFor(settings, 30_000);
  let changed = 0;
  for (const state of local) {
    const { key, path, ...wire } = state;
    const { state: merged } = await client.pushState(wire);
    await store.applyState(key, merged, path);
    if (differs(wire, merged)) changed += 1;
  }
  return changed
    ? `синхронизировано ${local.length}, обновилось ${changed}`
    : `синхронизировано ${local.length}, всё и так совпадало`;
}

/**
 * Синхронизация одной книги по нажатию клавиши в читалке.
 *
 * Отличается от фоновой тем, что читателю нужен внятный ответ: он нажал и
 * ждёт. Поэтому итог всегда словами — и когда получилось, и когда нет, — а
 * закладки возвращаются наружу, чтобы поставленные на другом устройстве
 * появились сразу, а не после перезапуска.
 */
export async function syncOnDemand(
  settings: SyncSettings,
  store: JsonFileStore,
  key: string,
  meta: { hash: string; title: string; author: string; total: number },
  path: string,
  block: number,
  bookmarks: Bookmark[],
): Promise<{ text: string; bookmarks?: Bookmark[] }> {
  const state: SyncState = {
    hash: meta.hash,
    block,
    total: meta.total,
    title: meta.title,
    author: meta.author,
    at: Date.now() / 1000,
    device: settings.device,
    bookmarks,
  };
  const { state: merged, note } = await syncOne(settings, store, key, state, path);
  if (!merged) return { text: `не вышло: ${note}` };

  const added = merged.bookmarks.length - bookmarks.length;
  const text = note || (added > 0 ? `синхронизировано, закладок прибавилось: ${added}` : "синхронизировано");
  return { text, bookmarks: merged.bookmarks };
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
