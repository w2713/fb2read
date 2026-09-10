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
const VERSION = 1;

interface Schema extends DBSchema {
  /** Позиция и закладки: ключ — отпечаток книги. */
  state: { key: string; value: PositionRecord };
  /** Настройки читалки одной записью. */
  settings: { key: string; value: Settings };
}

/** Открывает базу, создавая хранилища при первом заходе. */
export function openState(name = NAME): Promise<IDBPDatabase<Schema>> {
  return openDB<Schema>(name, VERSION, {
    upgrade(db) {
      if (!db.objectStoreNames.contains("state")) db.createObjectStore("state");
      if (!db.objectStoreNames.contains("settings")) db.createObjectStore("settings");
    },
  });
}

export class IdbStore implements StateStore {
  private db: Promise<IDBPDatabase<Schema>>;

  constructor(name = NAME) {
    this.db = openState(name);
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
