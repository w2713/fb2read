/**
 * Настройки, дошедшие до экрана.
 *
 * Здесь проверяется не разбор конфига — он проверен в ядре, — а то, что
 * прочитанное действительно меняет картинку: ширину колонки, тему, клавиши.
 * И то, что читалка не разваливается на странных размерах окна.
 */

import { describe, expect, it } from "vitest";
import { readConfig, strWidth } from "@fb2read/core";
import { harness } from "./harness.js";
import { sampleBook } from "./books.js";

const BASE = {
  width: 60,
  startBlock: 0,
  theme: "night",
  spacing: 1,
  columns: 1,
  mouse: true,
};

/** Собирает читалку так, как её собрал бы запуск с этим конфигом. */
async function withConfig(text: string, size: { rows?: number; columns?: number } = {}) {
  const { prefs, keys } = readConfig(text);
  return harness(
    {
      book: await sampleBook(),
      ...BASE,
      width: prefs.width ?? BASE.width,
      spacing: prefs.spacing ?? BASE.spacing,
      columns: prefs.columns ?? BASE.columns,
      theme: prefs.theme ?? BASE.theme,
      mouse: prefs.mouse ?? BASE.mouse,
      keys,
    },
    size,
  );
}

describe("настройки из конфига", () => {
  it("ширина колонки соблюдается и колонка стоит по центру", async () => {
    const ui = await withConfig("[reader]\nwidth = 40\n", { columns: 100 });
    const body = ui.terminal.lines().slice(1, -1).filter((l) => l.trim());
    for (const line of body) expect(strWidth(line.trim())).toBeLessThanOrEqual(40);
    // Поля слева широкие: колонка не прижата к краю окна.
    const indents = body.map((l) => l.length - l.trimStart().length);
    expect(Math.min(...indents)).toBeGreaterThan(20);
  });

  it("тема из конфига видна на экране", async () => {
    const day = await withConfig("[reader]\ntheme = day\n");
    await day.press("c");
    // День идёт последним, поэтому следующая тема — авто.
    expect(day.terminal.line(day.terminal.rows - 1)).toContain("тема: auto");
  });

  it("межстрочный интервал из конфига разрежает текст", async () => {
    const single = await withConfig("[reader]\nspacing = 1\n");
    const double = await withConfig("[reader]\nspacing = 2\n");
    const filled = (ui: typeof single) =>
      ui.terminal.lines().filter((l) => l.trim()).length;
    expect(filled(double)).toBeLessThan(filled(single));
  });

  it("неверное значение не мешает читать", async () => {
    const config = "[reader]\ntheme = розовая\nwidth = сорок\n";
    expect(readConfig(config).notes).toHaveLength(2);
    const ui = await withConfig(config);
    expect(ui.terminal.text()).toContain("Проверка читалки");
  });
});

describe("переназначенные клавиши", () => {
  it("новая клавиша работает, а старая перестаёт", async () => {
    const ui = await withConfig("[keys]\nnext_chapter = >\nprev_chapter = <\n");
    await ui.press(">");
    const moved = ui.reader.currentBlock();
    expect(moved).toBeGreaterThan(0);
    await ui.press("]"); // прежняя клавиша больше не назначена
    expect(ui.reader.currentBlock()).toBe(moved);
    await ui.press("<");
    expect(ui.reader.currentBlock()).toBeLessThan(moved);
  });

  it("переназначенный выход слушается только новой клавиши", async () => {
    const ui = await withConfig("[keys]\nquit = x\n");
    await ui.press("q");
    expect(ui.reader.done).toBe(false);
    await ui.press("x");
    expect(ui.reader.done).toBe(true);
  });

  it("справка показывает то, что задано в конфиге", async () => {
    const ui = await withConfig("[keys]\ntoc = ctrl-t\n");
    await ui.press("?");
    expect(ui.terminal.text()).toContain("Ctrl+T");
  });
});

describe("устойчивость к размеру окна", () => {
  it.each([
    [4, 15],
    [8, 26],
    [50, 200],
  ])("переживает окно %i на %i и серию нажатий", async (rows, columns) => {
    const ui = await harness({ book: await sampleBook(), ...BASE }, { rows, columns });
    // Тот же набор, что и в эталонных проверках: разворот, интервал, тема,
    // оглавление, отказ от него, справка, закрытие, страница.
    await ui.press("2", "s", "c", "t", "\x1b", "?", "q", " ");
    expect(ui.reader.done).toBe(false);
    for (const line of ui.terminal.lines()) {
      expect(line.length).toBeLessThanOrEqual(columns);
    }
  });

  it("на крохотном окне всё равно показывает текст книги", async () => {
    const ui = await harness({ book: await sampleBook(), ...BASE }, { rows: 6, columns: 24 });
    expect(ui.terminal.text().trim()).not.toBe("");
  });
});
