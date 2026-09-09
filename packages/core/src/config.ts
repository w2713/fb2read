/**
 * Файл настроек: разбор ini и образец для `--write-config`.
 *
 * Ядро только разбирает текст — где лежит файл и как он читается, решает
 * платформа. Порядок старшинства прежний: ключ командной строки, потом
 * конфиг, потом то, что читалка запомнила с прошлого запуска.
 */

import { ACTIONS } from "./keymap.js";

/** Темы оформления в порядке переключения по клавише. */
export const THEME_ORDER = ["auto", "night", "sepia", "day"] as const;

/** Чем терминал умеет показывать картинки. */
export const IMAGE_BACKENDS = ["auto", "kitty", "iterm", "chafa", "sixel", "off"] as const;

export type Theme = (typeof THEME_ORDER)[number];
export type ImageBackend = (typeof IMAGE_BACKENDS)[number];

/** Настройки чтения. */
export interface Prefs {
  width?: number;
  spacing?: number;
  columns?: number;
  theme?: Theme;
  images?: ImageBackend;
  mouse?: boolean;
}

/** Разобранные секции ini: имя секции в пары ключ-значение. */
export type Ini = Record<string, Record<string, string>>;

/**
 * Разбор ini: секции, `ключ = значение`, комментарии на `#` и `;`.
 *
 * Подстановки значений (interpolation) нет намеренно — в эталоне она тоже
 * выключена, иначе знак процента в клавише ломал бы разбор.
 */
export function parseIni(text: string): Ini {
  const out: Ini = {};
  let section = "";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    if (line.startsWith("[") && line.endsWith("]")) {
      section = line.slice(1, -1).trim();
      out[section] ??= {};
      continue;
    }
    const at = line.indexOf("=");
    if (at === -1) continue;
    const key = line.slice(0, at).trim().toLowerCase();
    const value = line.slice(at + 1).trim();
    if (!section) continue;
    (out[section] ??= {})[key] = value;
  }
  return out;
}

const TRUE = new Set(["1", "yes", "true", "on"]);
const FALSE = new Set(["0", "no", "false", "off"]);

/** Настройки синхронизации с сервером. */
export interface SyncPrefs {
  url?: string;
  token?: string;
  /** Сливать ли состояние при открытии и выходе из книги. */
  auto?: boolean;
}

/** Что вышло из конфига: настройки, клавиши и замечания к ним. */
export interface ConfigResult {
  prefs: Prefs;
  sync: SyncPrefs;
  keys: Record<string, string>;
  notes: string[];
}

/** Разбирает содержимое файла настроек. */
export function readConfig(text: string): ConfigResult {
  const ini = parseIni(text);
  const prefs: Prefs = {};
  const notes: string[] = [];
  const reader = ini["reader"] ?? {};

  for (const name of ["width", "spacing", "columns"] as const) {
    if (!(name in reader)) continue;
    const value = Number.parseInt(reader[name]!, 10);
    // Пустое, «сорок» или «8px» — не число: скажем и пойдём дальше.
    if (Number.isNaN(value) || !/^[+-]?\d+$/.test(reader[name]!.trim())) {
      notes.push(`в конфиге неверное значение ${name}`);
    } else {
      prefs[name] = value;
    }
  }

  if ("theme" in reader) {
    const value = reader["theme"]!.trim();
    if ((THEME_ORDER as readonly string[]).includes(value)) prefs.theme = value as Theme;
    else notes.push(`в конфиге неизвестное значение theme=${value}`);
  }
  if ("images" in reader) {
    const value = reader["images"]!.trim();
    if ((IMAGE_BACKENDS as readonly string[]).includes(value)) {
      prefs.images = value as ImageBackend;
    } else {
      notes.push(`в конфиге неизвестное значение images=${value}`);
    }
  }
  if ("mouse" in reader) {
    const value = reader["mouse"]!.trim().toLowerCase();
    if (TRUE.has(value)) prefs.mouse = true;
    else if (FALSE.has(value)) prefs.mouse = false;
    else notes.push("в конфиге mouse должно быть yes или no");
  }

  const sync: SyncPrefs = {};
  const syncSection = ini["sync"] ?? {};
  if (syncSection["url"]) sync.url = syncSection["url"]!.trim();
  if (syncSection["token"]) sync.token = syncSection["token"]!.trim();
  if ("auto" in syncSection) {
    const value = syncSection["auto"]!.trim().toLowerCase();
    if (TRUE.has(value)) sync.auto = true;
    else if (FALSE.has(value)) sync.auto = false;
    else notes.push("в конфиге auto должно быть yes или no");
  }

  return { prefs, sync, keys: ini["keys"] ?? {}, notes };
}

/** Образец конфига со всеми действиями и их клавишами по умолчанию. */
export function configSample(): string {
  const actions = ACTIONS.map(({ action, keys }) => `# ${action} = ${keys.join(", ")}`);
  return `# Настройки fb2read. Значения отсюда сильнее того, что
# читалка запомнила сама, но слабее ключей командной строки.

[reader]
# width = 80          ширина текстовой колонки
# spacing = 1         межстрочный интервал: 1, 2 или 3
# columns = 1         1 — одна колонка, 2 — книжный разворот
# theme = auto        auto, night, sepia, day
# images = auto       auto, kitty, iterm, chafa, sixel, off
# mouse = yes         захватывать ли мышь

[sync]
# Синхронизация книг и позиции чтения со своим сервером.
# Сервер поднимается командой fb2read-server; как — написано в README.
# url = https://books.example.org
# token = ...            либо переменная окружения FB2READ_SYNC_TOKEN
# auto = yes             сливать позицию при открытии и выходе из книги

[keys]
# Клавиши через запятую. Понимаются одиночные символы, имена
# space, enter, backspace, tab, esc, delete, up, down, left, right,
# pgup, pgdn, home, end и сочетания вида ctrl-l.
${actions.join("\n")}
`;
}
