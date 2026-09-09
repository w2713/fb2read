/**
 * Действия читалки и их клавиши.
 *
 * В отличие от версии на curses, клавиша здесь — каноническое имя
 * (`"j"`, `"pgdn"`, `"ctrl-l"`), а не число. Разные коды одного смысла
 * (CR и LF, DEL и BS) сводит воедино разбор ввода, а не раскладка,
 * поэтому раскладка одинаково годится и терминалу, и браузеру.
 */

/** Действие: имя, описание для справки, клавиши по умолчанию. */
export interface ActionSpec {
  action: string;
  text: string;
  keys: string[];
}

/**
 * Действия в том порядке, в каком они показываются в справке и в образце
 * конфига.
 */
export const ACTIONS: readonly ActionSpec[] = [
  { action: "line_down", text: "строка вниз", keys: ["down", "j"] },
  { action: "line_up", text: "строка вверх", keys: ["up", "k"] },
  {
    action: "page_down",
    text: "страница вперёд (в развороте — обе)",
    keys: ["space", "pgdn", "f", "right"],
  },
  { action: "page_up", text: "страница назад", keys: ["b", "pgup", "left"] },
  { action: "half_down", text: "полстраницы вниз", keys: ["d"] },
  { action: "half_up", text: "полстраницы вверх", keys: ["u"] },
  { action: "book_start", text: "в начало книги", keys: ["g", "home"] },
  { action: "book_end", text: "в конец книги", keys: ["G", "end"] },
  { action: "next_chapter", text: "следующая глава", keys: ["]"] },
  { action: "prev_chapter", text: "предыдущая глава", keys: ["["] },
  { action: "toc", text: "оглавление", keys: ["t", "o"] },
  { action: "note_follow", text: "перейти к сноске на экране", keys: ["enter"] },
  { action: "note_back", text: "вернуться из сноски", keys: ["backspace"] },
  { action: "image", text: "показать иллюстрацию", keys: ["p"] },
  { action: "search", text: "поиск по книге", keys: ["/"] },
  { action: "search_next", text: "следующее совпадение", keys: ["n"] },
  { action: "search_prev", text: "предыдущее совпадение", keys: ["N"] },
  { action: "match_list", text: "список всех совпадений", keys: ["l"] },
  { action: "bookmark_add", text: "поставить или снять закладку", keys: ["M"] },
  {
    action: "bookmark_list",
    text: "закладки: переход, удаление, экспорт",
    keys: ["'", '"'],
  },
  { action: "wider", text: "шире колонка", keys: ["+", "="] },
  { action: "narrower", text: "уже колонка", keys: ["-"] },
  { action: "spacing", text: "межстрочный интервал (1 / 2 / 3)", keys: ["s"] },
  { action: "one_column", text: "одна колонка", keys: ["1"] },
  { action: "two_columns", text: "книжный разворот", keys: ["2"] },
  { action: "toggle_columns", text: "переключить разворот", keys: ["v"] },
  { action: "theme", text: "тема: авто, ночь, сепия, день", keys: ["c"] },
  { action: "mouse", text: "отпустить мышь и вернуть захват", keys: ["m"] },
  { action: "info", text: "сведения о книге", keys: ["i"] },
  { action: "redraw", text: "перерисовать экран", keys: ["ctrl-l"] },
  { action: "help", text: "эта справка", keys: ["?", "h"] },
  { action: "quit", text: "выход (позиция сохраняется)", keys: ["q", "Q"] },
];

/** Имена клавиш, которые понимает конфиг, и их канонический вид. */
const NAMED: Readonly<Record<string, string>> = {
  space: "space",
  enter: "enter",
  return: "enter",
  tab: "tab",
  esc: "esc",
  backspace: "backspace",
  delete: "delete",
  up: "up",
  down: "down",
  left: "left",
  right: "right",
  pgup: "pgup",
  pgdn: "pgdn",
  home: "home",
  end: "end",
};

/** Имя клавиши из конфига в канонический вид; null, если имя непонятно. */
export function parseKey(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return null;
  const low = trimmed.toLowerCase();
  if (low in NAMED) return NAMED[low]!;
  if (low.startsWith("ctrl-") && low.length === 6) return low;
  if ([...trimmed].length === 1) return trimmed;
  return null;
}

/** Раскладка: клавиша в действие, плюс сами привязки и замечания. */
export interface Keymap {
  keymap: Record<string, string>;
  bindings: Record<string, string[]>;
  problems: string[];
}

/** Собирает раскладку, накладывая на умолчания то, что задано в конфиге. */
export function buildKeymap(overrides: Record<string, string> = {}): Keymap {
  const keymap: Record<string, string> = {};
  const bindings: Record<string, string[]> = {};
  const problems: string[] = [];
  const known = new Set(ACTIONS.map((a) => a.action));

  for (const action of Object.keys(overrides)) {
    if (!known.has(action)) problems.push(`неизвестное действие в конфиге: ${action}`);
  }

  for (const { action, keys } of ACTIONS) {
    const names =
      action in overrides ? overrides[action]!.split(/[,\s]+/).filter(Boolean) : keys;
    const chosen: string[] = [];
    for (const name of names) {
      const code = parseKey(name);
      if (!code) {
        problems.push(`непонятная клавиша «${name}» для ${action}`);
        continue;
      }
      chosen.push(name);
      if (!(code in keymap)) keymap[code] = action;
    }
    bindings[action] = chosen;
  }
  return { keymap, bindings, problems };
}

const PRETTY: Readonly<Record<string, string>> = {
  space: "Space",
  enter: "Enter",
  backspace: "Backspace",
  pgup: "PgUp",
  pgdn: "PgDn",
  home: "Home",
  end: "End",
  up: "↑",
  down: "↓",
  left: "←",
  right: "→",
  esc: "Esc",
  tab: "Tab",
};

/** Как клавиша выглядит в справке. */
export function keyTitle(name: string): string {
  const low = name.toLowerCase();
  if (low in PRETTY) return PRETTY[low]!;
  if (low.startsWith("ctrl-")) return "Ctrl+" + name.slice(5).toUpperCase();
  return name;
}

/** Справка строится из действующей раскладки, а не из готовой таблицы. */
export function helpRows(bindings: Record<string, string[]>): Array<[string, string]> {
  const rows: Array<[string, string]> = ACTIONS.map(({ action, text }) => [
    (bindings[action] ?? []).map(keyTitle).join(" "),
    text,
  ]);
  rows.push(
    ["", ""],
    ["колесо / клик", "листать, клик по сноске или картинке"],
    ["правая кнопка", "вернуться из сноски"],
    ["", ""],
    ["Размер шрифта", "задаётся терминалом, а не читалкой:"],
    ["", "Ctrl + «+» и Ctrl + «-» в большинстве эмуляторов,"],
    ["", "Ctrl + колесо мыши, в консоли Linux — setfont."],
    ["", "Текст сам переливается под новый размер окна."],
  );
  return rows;
}
