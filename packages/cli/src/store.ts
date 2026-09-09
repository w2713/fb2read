/**
 * Хранилище состояния в JSON-файле.
 *
 * Формат тот же, что у версии на Python: один файл, ключ книги — sha1 от
 * абсолютного пути и размера, настройки лежат под `__settings__`. Поэтому
 * позиции чтения переживают переход с одной реализации на другую.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import {
  progressPercent,
  type Bookmark,
  type PositionRecord,
  type RecentEntry,
  type Settings,
  type StateStore,
} from "@fb2read/core";
import { stateFile } from "./paths.js";

const SETTINGS_KEY = "__settings__";

type StateFile = Record<string, unknown>;

export class JsonFileStore implements StateStore {
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

  private write(data: StateFile): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(this.path, JSON.stringify(data, null, 1), "utf-8");
    } catch {
      // Диск переполнен или каталог только для чтения: читать книгу это
      // не мешает.
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
