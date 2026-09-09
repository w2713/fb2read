/**
 * Читалка на экране.
 *
 * Проверяется то, что иначе видно только глазами: что нарисовано в каждой
 * строке, каким начертанием, куда уехал текст после нажатия и как всё
 * перестроилось при изменении размера окна.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { harness, type Harness } from "./harness.js";
import { sampleBook, wideBook } from "./books.js";

const OPTIONS = {
  width: 60,
  startBlock: 0,
  theme: "night",
  spacing: 1,
  columns: 1,
  mouse: true,
};

async function open(size?: { rows?: number; columns?: number }, extra: object = {}) {
  return harness({ book: await sampleBook(), ...OPTIONS, ...extra }, size);
}

let ui: Harness;

describe("первый кадр", () => {
  beforeEach(async () => {
    ui = await open();
  });

  it("показывает автора и название в полосе сверху", async () => {
    expect(ui.terminal.line(0)).toContain("Иван Тестов — Проверка читалки");
  });

  it("показывает процент прочитанного", async () => {
    expect(ui.terminal.line(0)).toMatch(/\d+%/);
  });

  it("сразу говорит, что файл открыт с исправлениями", async () => {
    // В книге есть вложение, оно вырезается при разборе — это правка,
    // и читатель должен узнать о ней, не спрашивая.
    expect(ui.terminal.line(ui.terminal.rows - 1)).toContain("исправлениями");
  });

  it("после первого нажатия внизу подсказка", async () => {
    await ui.press("j");
    expect(ui.terminal.line(ui.terminal.rows - 1)).toContain("справка");
  });

  it("показывает текст книги", async () => {
    expect(ui.terminal.text()).toContain("Проверка читалки");
  });

  it("заходит в альтернативный экран и прячет курсор", async () => {
    expect(ui.terminal.raw).toContain("\x1b[?1049h");
    expect(ui.terminal.raw).toContain("\x1b[?25l");
  });

  it("захватывает мышь отчётами SGR", async () => {
    expect(ui.terminal.raw).toContain("\x1b[?1006h");
  });
});

describe("листание", () => {
  beforeEach(async () => {
    ui = await open();
  });

  it("j опускает текст на строку", async () => {
    const before = ui.terminal.line(1);
    await ui.press("j");
    expect(ui.terminal.line(1)).not.toBe(before);
  });

  it("k возвращает обратно", async () => {
    const before = ui.terminal.line(1);
    await ui.press("j", "k");
    expect(ui.terminal.line(1)).toBe(before);
  });

  it("пробел листает страницу, а не строку", async () => {
    await ui.press("j");
    const afterLine = ui.terminal.line(1);
    await ui.press("k", " ");
    expect(ui.terminal.line(1)).not.toBe(afterLine);
  });

  it("G уводит в конец книги, g возвращает в начало", async () => {
    await ui.press("G");
    expect(ui.terminal.line(0)).toContain("100%");
    await ui.press("g");
    expect(ui.terminal.line(0)).toContain("0%");
  });

  it("в начале книги выше не уезжает", async () => {
    await ui.press("k", "k", "k");
    expect(ui.terminal.line(0)).toContain("0%");
  });

  it("] и [ ходят по главам", async () => {
    await ui.press("]");
    const after = ui.terminal.text();
    expect(after).toContain("Глава");
    await ui.press("[");
    expect(ui.terminal.line(0)).toContain("0%");
  });

  it("стрелки работают наравне с буквами", async () => {
    const before = ui.terminal.line(1);
    await ui.press("\x1b[B");
    expect(ui.terminal.line(1)).not.toBe(before);
    await ui.press("\x1b[A");
    expect(ui.terminal.line(1)).toBe(before);
  });
});

describe("книжный разворот", () => {
  it("на широком окне рисует две колонки с корешком", async () => {
    ui = await open({ columns: 120 }, { columns: 2 });
    const rows = ui.terminal.lines().slice(1, -1);
    expect(rows.some((line) => line.includes("│"))).toBe(true);
  });

  it("на узком окне честно говорит, что одна колонка", async () => {
    ui = await open({ columns: 50 }, { columns: 2 });
    expect(ui.terminal.line(ui.terminal.rows - 1)).toContain("окно шире");
  });

  it("клавиша 2 включает разворот, 1 возвращает одну колонку", async () => {
    ui = await open({ columns: 120 });
    await ui.press("2");
    expect(ui.terminal.line(ui.terminal.rows - 1)).toContain("разворот");
    await ui.press("1");
    expect(ui.terminal.line(ui.terminal.rows - 1)).toContain("одна колонка");
  });
});

describe("изменение размера окна", () => {
  it("текст переливается под новую ширину", async () => {
    ui = await open({ columns: 100 });
    const wide = ui.terminal.line(2);
    await ui.resize(24, 46);
    const narrow = ui.terminal.line(2);
    expect(narrow).not.toBe(wide);
    for (const line of ui.terminal.lines()) expect(line.length).toBeLessThanOrEqual(46);
  });

  it("после сужения и возврата книга остаётся на том же месте", async () => {
    ui = await open({ columns: 100 });
    await ui.press("]");
    const chapter = ui.session.reader.currentBlock();
    await ui.resize(24, 50);
    await ui.resize(24, 100);
    expect(ui.session.reader.currentBlock()).toBe(chapter);
  });
});

describe("начертание", () => {
  it("курсив и полужирный доходят до экрана", async () => {
    ui = await open();
    const row = ui.terminal.findRow("курсивом");
    expect(row).toBeGreaterThan(0);
    const line = ui.terminal.line(row);
    const italicAt = line.indexOf("курсивом") + 2;
    const boldAt = line.indexOf("полужирным") + 2;
    expect(ui.terminal.style(row, italicAt).italic).toBe(true);
    expect(ui.terminal.style(row, boldAt).bold).toBe(true);
  });

  it("маркер сноски подчёркнут", async () => {
    ui = await open();
    const row = ui.terminal.findRow("[1]");
    expect(row).toBeGreaterThan(0);
    const at = ui.terminal.line(row).indexOf("[1]") + 1;
    expect(ui.terminal.style(row, at).underline).toBe(true);
  });

  it("широкие символы занимают два знакоместа", async () => {
    ui = await harness({ book: await wideBook(), ...OPTIONS }, { columns: 80 });
    for (const line of ui.terminal.lines()) {
      expect(line.length).toBeLessThanOrEqual(80);
    }
    expect(ui.terminal.text()).toContain("日本語");
  });
});

describe("выход", () => {
  it("q заканчивает чтение и возвращает терминал", async () => {
    ui = await open();
    await ui.press("q");
    await new Promise((resolve) => setImmediate(resolve));
    expect(ui.session.reader.done).toBe(true);
    expect(ui.terminal.raw).toContain("\x1b[?1049l");
    expect(ui.terminal.raw).toContain("\x1b[?25h");
  });
});
