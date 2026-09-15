/**
 * Хранилище состояния в JSON-файле.
 *
 * Формат тот же, что у версии на Python: один файл, ключ книги — sha1 от
 * абсолютного пути и размера, настройки лежат под `__settings__`. Поэтому
 * позиции чтения переживают переход с одной реализации на другую.
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
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
import { stateFile } from "./paths.js";

/** Состояние книги вместе с тем, где она лежит на этом устройстве. */
export interface LocalSyncState extends SyncState {
  /** Ключ в positions.json. */
  key: string;
  path: string;
}

const SETTINGS_KEY = "__settings__";

type StateFile = Record<string, unknown>;

/**
 * Счётчик временных файлов.
 *
 * Имя временного файла складывается из номера процесса и этого счётчика:
 * одно и то же имя на две записи — верный способ переименовать чужое и упасть
 * на своём. Номера процесса мало: читалка пишет позиции не однажды.
 */
let temporaries = 0;

export class JsonFileStore implements StateStore {
  /**
   * Почему не записалось в прошлый раз, или null.
   *
   * Молча терять позицию нельзя: читатель узнает об этом, только открыв книгу
   * заново и увидев начало. Ронять читалку из-за этого тоже нельзя — поэтому
   * причина запоминается, а показывает её тот, кому есть где сказать.
   */
  lastWriteError: string | null = null;

  constructor(private readonly path: string = stateFile()) {}

  private read(): StateFile {
    try {
      const data: unknown = JSON.parse(readFileSync(this.path, "utf-8"));
      return data && typeof data === "object" && !Array.isArray(data)
        ? (data as StateFile)
        : {};
    } catch {
      // Нет файла или он испорчен — начинаем с чистого листа, но молча:
      // потерять позицию неприятно, а уронить читалку хуже.
      return {};
    }
  }

  /**
   * Записывает файл целиком — через временное имя и переименование.
   *
   * Прямая запись поверх прежнего файла оставляет при обрыве половину, а в
   * этом файле лежат позиции и закладки всех книг разом: разбор половины не
   * удаётся, и читалка честно начинает с чистого листа — то есть теряет всё
   * накопленное. Переименование же атомарно: либо прежний файл, либо новый.
   *
   * Временное имя своё у каждой записи: одно на всех значило бы, что две
   * читалки, запущенные разом, переименуют чужое и упадут на своём.
   */
  private write(data: StateFile): void {
    temporaries += 1;
    const temp = `${this.path}.${process.pid}.${temporaries}.tmp`;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(temp, JSON.stringify(data, null, 1), "utf-8");
      renameSync(temp, this.path);
      this.lastWriteError = null;
    } catch (e) {
      // Диск переполнен или каталог только для чтения: читать книгу это не
      // мешает, но и делать вид, что позиция сохранена, нельзя.
      this.lastWriteError = (e as Error).message;
      try {
        rmSync(temp, { force: true });
      } catch {
        // Убрать за собой не вышло — тем более не повод падать: `force` молчит
        // только о том, что файла нет, а здесь неладно с самим каталогом.
      }
    }
  }

  private entry(key: string): PositionRecord | null {
    const value = this.read()[key];
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as PositionRecord)
      : null;
  }

  async loadPosition(key: string): Promise<number> {
    const block = this.entry(key)?.block;
    const value = typeof block === "number" ? block : Number.parseInt(String(block), 10);
    return Number.isFinite(value) ? value : 0;
  }

  async savePosition(key: string, record: PositionRecord): Promise<void> {
    const data = this.read();
    const previous = this.entry(key);
    data[key] = { ...record, bookmarks: previous?.bookmarks ?? [] };
    this.write(data);
  }

  async loadBookmarks(key: string): Promise<Bookmark[]> {
    const marks = this.entry(key)?.bookmarks;
    if (!Array.isArray(marks)) return [];
    return marks.filter(
      (m): m is Bookmark => !!m && typeof m === "object" && typeof m.block === "number",
    );
  }

  async saveBookmarks(
    key: string,
    marks: Bookmark[],
    meta: Partial<PositionRecord>,
  ): Promise<void> {
    const data = this.read();
    const entry: PositionRecord = this.entry(key) ?? {
      block: 0,
      title: meta.title ?? "",
      author: meta.author ?? "",
      total: meta.total ?? 0,
      path: meta.path ?? "",
      at: Date.now() / 1000,
    };
    entry.bookmarks = [...marks].sort((a, b) => a.block - b.block);
    data[key] = entry;
    this.write(data);
  }

  async loadSettings(): Promise<Settings> {
    const saved = this.read()[SETTINGS_KEY];
    return saved && typeof saved === "object" && !Array.isArray(saved)
      ? (saved as Settings)
      : {};
  }

  async saveSettings(patch: Settings): Promise<void> {
    const data = this.read();
    const current = data[SETTINGS_KEY];
    const settings =
      current && typeof current === "object" && !Array.isArray(current)
        ? (current as Settings)
        : {};
    data[SETTINGS_KEY] = { ...settings, ...patch };
    this.write(data);
  }

  // --- синхронизация -------------------------------------------------------

  /** Запись целиком: нужна синхронизации, которой мало одной позиции. */
  async record(key: string): Promise<PositionRecord | null> {
    return this.entry(key);
  }

  /**
   * Книги, которые можно синхронизировать, — то есть с отпечатком.
   *
   * Книги, читанные до появления синхронизации, отпечатка не имеют: узнать
   * их на другом устройстве не по чему. Отпечаток появится, когда книгу
   * откроют снова, — молча пропускать их поэтому честно, но сказать об этом
   * читателю всё же стоит, чем и занят countWithoutHash.
   */
  async syncableStates(device: string): Promise<LocalSyncState[]> {
    const out: LocalSyncState[] = [];
    for (const [key, value] of Object.entries(this.read())) {
      if (key === SETTINGS_KEY) continue;
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const record = value as PositionRecord;
      if (!record.hash) continue;
      out.push({
        key,
        path: record.path ?? "",
        hash: record.hash,
        block: record.block ?? 0,
        total: record.total ?? 0,
        title: record.title ?? "",
        author: record.author ?? "",
        at: record.at ?? 0,
        device,
        bookmarks: record.bookmarks ?? [],
      });
    }
    return out;
  }

  /** Сколько записей осталось без отпечатка. */
  async countWithoutHash(): Promise<number> {
    let count = 0;
    for (const [key, value] of Object.entries(this.read())) {
      if (key === SETTINGS_KEY) continue;
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      if (!(value as PositionRecord).hash) count += 1;
    }
    return count;
  }

  /**
   * Кладёт пришедшее с сервера состояние в запись книги.
   *
   * Закладки именно сливаются, а не заменяются: между отправкой и ответом
   * читатель мог поставить ещё одну, и затирать её нельзя. Путь остаётся
   * местный — на сервере он чужой и здесь бесполезен.
   */
  async applyState(key: string, state: SyncState, path: string): Promise<void> {
    const data = this.read();
    const previous = this.entry(key);
    const record: PositionRecord = {
      block: state.block,
      title: state.title || previous?.title || "",
      author: state.author || previous?.author || "",
      total: state.total || previous?.total || 0,
      path: path || previous?.path || "",
      at: state.at,
      hash: state.hash,
      bookmarks: mergeBookmarks(previous?.bookmarks ?? [], state.bookmarks ?? []),
    };
    data[key] = record;
    this.write(data);
  }

  async recent(): Promise<RecentEntry[]> {
    const entries: RecentEntry[] = [];
    for (const [key, value] of Object.entries(this.read())) {
      if (key === SETTINGS_KEY) continue;
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const record = value as PositionRecord;
      const path = record.path ?? "";
      if (!path || !existsSync(path)) continue;
      entries.push({
        path,
        title: record.title || path.split(/[\\/]/).pop() || path,
        author: record.author ?? "",
        percent: progressPercent(record.block ?? 0, record.total ?? 0),
        at: record.at ?? 0,
      });
    }
    return entries.sort((a, b) => b.at - a.at);
  }
}
