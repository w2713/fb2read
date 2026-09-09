/** Конфиг и раскладка клавиш. */

import { describe, expect, it } from "vitest";
import { configSample, readConfig } from "../src/config.js";
import { ACTIONS, buildKeymap, helpRows, keyTitle, parseKey } from "../src/keymap.js";
import { plural, progressPercent } from "../src/state.js";

describe("конфиг", () => {
  it("читает настройки чтения", () => {
    const { prefs, notes } = readConfig(
      "[reader]\nwidth = 72\nspacing = 2\ncolumns = 2\ntheme = night\nmouse = no\n",
    );
    expect(prefs).toEqual({
      width: 72,
      spacing: 2,
      columns: 2,
      theme: "night",
      mouse: false,
    });
    expect(notes).toEqual([]);
  });

  it("жалуется на неверные значения, но продолжает работать", () => {
    const { prefs, notes } = readConfig(
      "[reader]\nwidth = сорок\ntheme = радуга\nmouse = может быть\nspacing = 2\n",
    );
    expect(prefs).toEqual({ spacing: 2 });
    expect(notes).toHaveLength(3);
  });

  it("отдаёт переопределения клавиш как есть", () => {
    const { keys } = readConfig("[keys]\nquit = q, Q, esc\nnext_chapter = ]\n");
    expect(keys).toEqual({ quit: "q, Q, esc", next_chapter: "]" });
  });

  it("не спотыкается о комментарии, пустые строки и знак процента", () => {
    const { prefs } = readConfig("# так надо\n\n[reader]\n; и так\nwidth = 90\n");
    expect(prefs.width).toBe(90);
  });

  it("образец конфига перечисляет все действия и сам читается", () => {
    const sample = configSample();
    for (const { action } of ACTIONS) expect(sample).toContain(action);
    // Все строки с действиями закомментированы, поэтому настроек не даёт.
    expect(readConfig(sample)).toEqual({ prefs: {}, sync: {}, keys: {}, notes: [] });
  });

  it("читает настройки синхронизации", () => {
    const { sync, notes } = readConfig(
      "[sync]\nurl = https://books.example.org\ntoken = abc123\nauto = yes\n",
    );
    expect(sync).toEqual({ url: "https://books.example.org", token: "abc123", auto: true });
    expect(notes).toEqual([]);
  });

  it("без раздела [sync] синхронизации нет", () => {
    expect(readConfig("[reader]\nwidth = 72\n").sync).toEqual({});
  });

  it("жалуется на непонятное auto, но остальное берёт", () => {
    const { sync, notes } = readConfig("[sync]\nurl = http://localhost\nauto = когда-нибудь\n");
    expect(sync.url).toBe("http://localhost");
    expect(sync.auto).toBeUndefined();
    expect(notes).toEqual(["в конфиге auto должно быть yes или no"]);
  });
});

describe("раскладка клавиш", () => {
  it.each([
    ["j", "j"],
    ["Space", "space"],
    ["enter", "enter"],
    ["return", "enter"],
    ["ctrl-l", "ctrl-l"],
    ["PgDn", "pgdn"],
    ["", null],
    ["непонятно", null],
  ])("разбирает %j", (name, expected) => {
    expect(parseKey(name)).toBe(expected);
  });

  it("по умолчанию собирается без замечаний", () => {
    const { keymap, problems } = buildKeymap();
    expect(problems).toEqual([]);
    expect(keymap["q"]).toBe("quit");
    expect(keymap["down"]).toBe("line_down");
    expect(keymap["ctrl-l"]).toBe("redraw");
  });

  it("переопределение из конфига вытесняет умолчание", () => {
    const { keymap, bindings } = buildKeymap({ quit: "x, esc" });
    expect(keymap["x"]).toBe("quit");
    expect(keymap["esc"]).toBe("quit");
    expect(keymap["q"]).toBeUndefined();
    expect(bindings["quit"]).toEqual(["x", "esc"]);
  });

  it("непонятные клавиши и действия называет, но раскладку не рушит", () => {
    const { keymap, problems } = buildKeymap({ quit: "абракадабра", летать: "f" });
    expect(problems).toHaveLength(2);
    expect(keymap["down"]).toBe("line_down");
  });

  it("справка строится из действующих клавиш", () => {
    const { bindings } = buildKeymap({ quit: "x" });
    const rows = helpRows(bindings);
    expect(rows.find(([, text]) => text.startsWith("выход"))![0]).toBe("x");
  });

  it.each([
    ["space", "Space"],
    ["up", "↑"],
    ["ctrl-l", "Ctrl+L"],
    ["j", "j"],
  ])("показывает %j как %j", (name, shown) => {
    expect(keyTitle(name)).toBe(shown);
  });
});

describe("мелочи", () => {
  it.each([
    [1, "1 книга"],
    [2, "2 книги"],
    [5, "5 книг"],
    [11, "11 книг"],
    [21, "21 книга"],
    [104, "104 книги"],
  ])("склоняет %i", (n, expected) => {
    expect(plural(n, "книга", "книги", "книг")).toBe(expected);
  });

  it.each([
    [0, 100, 0],
    [50, 100, 51],
    [99, 100, 100],
    [10, 0, null],
  ])("считает процент для блока %i из %i", (block, total, expected) => {
    expect(progressPercent(block, total)).toBe(expected);
  });
});
