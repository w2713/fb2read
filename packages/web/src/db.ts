/**
 * Состояние читалки в браузере.
 *
 * Тот же `StateStore`, что и в терминале, только за ним IndexedDB вместо файла.
 * Интерфейс в ядре с самого начала асинхронный именно ради этого случая:
 * в браузере синхронного хранилища, пригодного для книг, попросту нет.
 *
 * Ключ книги здесь — отпечаток содержимого, а не путь. Пути в браузере нет
 * вовсе, а отпечаток уже посчитан при разборе; он же роднит запись с той,
 * что лежит на сервере синхронизации.
 */

import {
  mergeBookmarks,
  progressPercent,
  type Bookmark,
  type PositionRecord,
  type RecentEntry,
  type Settings,
  type StateStore,
  type SyncState,
} from "@fb2read/core";
import { openDB, type DBSchema, type IDBPDatabase } from "idb";

const NAME = "fb2read";
const VERSION = 2;

/**
 * Книга, оставшаяся в браузере, — всё, кроме самих байтов.
 *
 * Байты лежат отдельным хранилищем нарочно. Список книг читается при каждом
 * открытии читалки, и тащить ради него сорок мегабайт незачем; а главное —
 * та же книга, открытая повторно, переписывала бы их целиком, если бы лежала
 * с описанием в одной записи.
 *
 * Ключ — отпечаток содержимого: тот же, что у записи о месте, и тот же,
 * которым книга зовётся на сервере синхронизации.
 */
export interface BookMeta {
  hash: string;
  /** Имя файла: у Blob своего имени нет, а показать книгу как-то надо. */
  name: string;
  title: string;
  author: string;
  size: number;
  addedAt: number;
}

interface Schema extends DBSchema {
  /** Позиция и закладки: ключ — отпечаток книги. */
  state: { key: string; value: PositionRecord };
  /** Настройки читалки одной записью. */
  settings: { key: string; value: Settings };
  /** Описания книг: ключ — тот же отпечаток. */
  books: { key: string; value: BookMeta };
  /** Сами байты, отдельно от описаний. */
  files: { key: string; value: Blob };
}

/**
 * Открывает базу, создавая недостающие хранилища.
 *
 * Хранилища досоздаются по одному, а не пересоздаются: во второй версии
 * появились книги, и стереть при этом уже накопленные места и закладки —
 * ровно то, чего читатель не простит.
 */
export function openState(name = NAME): Promise<IDBPDatabase<Schema>> {
  return openDB<Schema>(name, VERSION, {
    upgrade(db) {
      if (!db.objectStoreNames.contains("state")) db.createObjectStore("state");
      if (!db.objectStoreNames.contains("settings")) db.createObjectStore("settings");
      if (!db.objectStoreNames.contains("books")) db.createObjectStore("books");
      if (!db.objectStoreNames.contains("files")) db.createObjectStore("files");
    },
  });
}

export class IdbStore implements StateStore {
  private db: Promise<IDBPDatabase<Schema>>;

  constructor(name = NAME) {
    this.db = openState(name);
  }

  /**
   * Закрывает базу.
   *
   * Нужно там, где базу открывают заново в том же процессе: открытая старая
   * версия не даёт обновиться новой. В самой читалке это не вызывается — там
   * база живёт, пока живёт вкладка.
   */
  async close(): Promise<void> {
    (await this.db).close();
  }

  private async entry(key: string): Promise<PositionRecord | null> {
    return (await (await this.db).get("state", key)) ?? null;
  }

  async loadPosition(key: string): Promise<number> {
    const block = (await this.entry(key))?.block;
    return typeof block === "number" && Number.isFinite(block) ? block : 0;
  }

  async savePosition(key: string, record: PositionRecord): Promise<void> {
    const previous = await this.entry(key);
    // Закладки переживают запись позиции: она случается на каждой прокрутке,
    // а закладки к прокрутке отношения не имеют.
    await (await this.db).put("state", { ...record, bookmarks: previous?.bookmarks ?? [] }, key);
  }

  async loadBookmarks(key: string): Promise<Bookmark[]> {
    const marks = (await this.entry(key))?.bookmarks;
    if (!Array.isArray(marks)) return [];
    return marks.filter((m): m is Bookmark => !!m && typeof m.block === "number");
  }

  async saveBookmarks(key: string, marks: Bookmark[], meta: Partial<PositionRecord>): Promise<void> {
    const entry: PositionRecord = (await this.entry(key)) ?? {
      block: 0,
      title: meta.title ?? "",
      author: meta.author ?? "",
      total: meta.total ?? 0,
      path: meta.path ?? "",
      at: Date.now() / 1000,
    };
    // Отсеиваем на записи, а не только на чтении: закладки приходят и с
    // сервера, а класть мусор в хранилище хуже, чем упасть на нём сразу.
    entry.bookmarks = marks
      .filter((m): m is Bookmark => !!m && typeof m.block === "number")
      .sort((a, b) => a.block - b.block);
    await (await this.db).put("state", entry, key);
  }

  async loadSettings(): Promise<Settings> {
    return (await (await this.db).get("settings", "reader")) ?? {};
  }

  async saveSettings(patch: Settings): Promise<void> {
    const db = await this.db;
    const current = (await db.get("settings", "reader")) ?? {};
    await db.put("settings", { ...current, ...patch }, "reader");
  }

  /**
   * Недавно читанное.
   *
   * В терминале отсюда выбрасываются книги, чьих файлов больше нет; здесь
   * файлов нет ни у одной — они появятся вместе с библиотекой на четвёртом
   * этапе, и тогда же этот список начнёт что-то значить.
   */
  async recent(): Promise<RecentEntry[]> {
    const db = await this.db;
    const out: RecentEntry[] = [];
    for (const key of await db.getAllKeys("state")) {
      const record = await db.get("state", key);
      if (!record) continue;
      out.push({
        path: String(key),
        title: record.title || String(key),
        author: record.author ?? "",
        percent: progressPercent(record.block ?? 0, record.total ?? 0),
        at: record.at ?? 0,
      });
    }
    return out.sort((a, b) => b.at - a.at);
  }

  // --- книги ----------------------------------------------------------------

  /**
   * Кладёт книгу на полку.
   *
   * Ключ — отпечаток содержимого, поэтому та же книга под другим именем ляжет
   * на прежнее место, а не вторым списком: проверка на повтор здесь бесплатна.
   * Байты знакомой книги не переписываются — они те же самые, а стоят сорок
   * мегабайт записи на телефоне.
   *
   * Внутри сделки нельзя ждать ничего постороннего: сделка IndexedDB
   * закрывается сама, стоит очереди задач опустеть, и второе действие уже не
   * пройдёт. Поэтому здесь только `get` и `put`.
   */
  async putBook(meta: BookMeta, data: Blob): Promise<void> {
    const db = await this.db;
    const tx = db.transaction(["books", "files"], "readwrite");
    const known = await tx.objectStore("books").get(meta.hash);
    if (!known) await tx.objectStore("files").put(data, meta.hash);
    // Время добавления у знакомой книги остаётся прежним: она на полке давно.
    await tx.objectStore("books").put({ ...meta, addedAt: known?.addedAt ?? meta.addedAt }, meta.hash);
    await tx.done;
  }

  /** Байты книги; описания без байтов не бывает, а вот наоборот — бывает. */
  async bookFile(hash: string): Promise<Blob | null> {
    return (await (await this.db).get("files", hash)) ?? null;
  }

  async bookMeta(hash: string): Promise<BookMeta | null> {
    return (await (await this.db).get("books", hash)) ?? null;
  }

  /**
   * Убирает книгу с полки.
   *
   * Запись о месте и закладках остаётся: она занимает считаные байты, а
   * синхронизация на ней держится — надгробия снятых закладок должны дожить до
   * следующего обмена. Вернув ту же книгу, читатель попадёт туда, где бросил.
   */
  async dropBook(hash: string): Promise<void> {
    const tx = (await this.db).transaction(["books", "files"], "readwrite");
    await tx.objectStore("books").delete(hash);
    await tx.objectStore("files").delete(hash);
    await tx.done;
  }

  /** Всё, что лежит на полке, вместе с записями о местах. */
  async shelf(): Promise<{ books: BookMeta[]; states: PositionRecord[] }> {
    const db = await this.db;
    const books = await db.getAll("books");
    const states: PositionRecord[] = [];
    for (const book of books) {
      const state = await db.get("state", book.hash);
      if (state) states.push(state);
    }
    return { books, states };
  }

  // --- то, что понадобится синхронизации ------------------------------------

  /** Запись целиком: синхронизации мало одной позиции. */
  async record(key: string): Promise<PositionRecord | null> {
    return this.entry(key);
  }

  /**
   * Кладёт пришедшее с сервера состояние.
   *
   * Закладки именно сливаются, а не заменяются: между отправкой и ответом
   * читатель мог поставить ещё одну, и затирать её нельзя.
   */
  async applyState(key: string, state: SyncState): Promise<void> {
    const previous = await this.entry(key);
    await (await this.db).put(
      "state",
      {
        block: state.block,
        title: state.title || previous?.title || "",
        author: state.author || previous?.author || "",
        total: state.total || previous?.total || 0,
        path: previous?.path ?? "",
        at: state.at,
        hash: state.hash,
        bookmarks: mergeBookmarks(previous?.bookmarks ?? [], state.bookmarks ?? []),
      },
      key,
    );
  }
}
