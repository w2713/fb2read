/**
 * Оглавление, поиск, сноски, закладки и мышь.
 *
 * Всё это в версии на curses было вложенными циклами событий; здесь каждое
 * окно — состояние читалки, и проверяется оно тем же способом, что и текст:
 * по тому, что видно на экране.
 */

import { describe, expect, it } from "vitest";
import type { Bookmark } from "@fb2read/core";
import { harness, type ReaderHarness } from "./harness.js";
import { epubBook, sampleBook } from "./books.js";

const OPTIONS = {
  width: 60,
  startBlock: 0,
  theme: "night",
  spacing: 1,
  columns: 1,
  mouse: true,
};

async function open(extra: object = {}, size: object = {}) {
  return harness({ book: await sampleBook(), ...OPTIONS, ...extra }, size);
}

describe("оглавление", () => {
  it("открывается по t и показывает главы", async () => {
    const ui = await open();
    await ui.press("t");
    const screen = ui.terminal.text();
    expect(screen).toContain("Оглавление");
    expect(screen).toContain("Глава первая");
    expect(screen).toContain("Глава вторая");
  });

  it("Enter переносит к выбранной главе", async () => {
    const ui = await open();
    await ui.press("t", "j", "j", "\r");
    expect(ui.terminal.text()).not.toContain("Оглавление");
    expect(ui.reader.currentBlock()).toBeGreaterThan(0);
  });

  it("q закрывает без перехода", async () => {
    const ui = await open();
    const before = ui.reader.currentBlock();
    await ui.press("t", "q");
    expect(ui.terminal.text()).not.toContain("Оглавление");
    expect(ui.reader.currentBlock()).toBe(before);
    expect(ui.reader.done).toBe(false); // q закрыл окно, а не книгу
  });

  it("клик мышью выбирает строку", async () => {
    const ui = await open();
    const row = ui.terminal.findRow("Глава вторая");
    expect(row).toBeGreaterThan(0);
    await ui.press("t");
    const inPopup = ui.terminal.findRow("Глава вторая");
    ui.terminal.click(ui.terminal.line(inPopup).indexOf("Глава"), inPopup);
    await ui.press("");
    expect(ui.terminal.text()).not.toContain("Оглавление");
  });
});

describe("справка и сведения", () => {
  it("по ? показывает действующие клавиши", async () => {
    const ui = await open();
    await ui.press("?");
    const screen = ui.terminal.text();
    expect(screen).toContain("Клавиши");
    expect(screen).toContain("строка вниз");
  });

  it("справка листается, когда не влезает на экран", async () => {
    const ui = await open();
    await ui.press("?");
    // «позиция сохраняется» есть только в последней строке справки,
    // поэтому по нему видно, докрутили ли список до конца.
    expect(ui.terminal.text()).toContain("листать");
    expect(ui.terminal.text()).not.toContain("позиция сохраняется");
    await ui.press("G");
    expect(ui.terminal.text()).toContain("позиция сохраняется");
  });

  it("справка знает о переназначенных клавишах", async () => {
    const ui = await open({ keys: { quit: "x" } });
    await ui.press("?", "G");
    const row = ui.terminal.findRow("позиция сохраняется");
    expect(row).toBeGreaterThan(0);
    // Строка справки — рамка, потом клавиши, потом описание.
    expect(ui.terminal.line(row).replace(/^\s*│\s*/, "").startsWith("x")).toBe(true);
  });

  it("по i показывает сведения о книге и внесённые правки", async () => {
    const ui = await open();
    await ui.press("i");
    const screen = ui.terminal.text();
    expect(screen).toContain("О книге");
    expect(screen).toContain("Проверка читалки");
    expect(screen).toContain("Правка");
  });
});

describe("поиск", () => {
  it("по / принимает запрос и находит слово", async () => {
    const ui = await open();
    await ui.press("/");
    expect(ui.terminal.line(ui.terminal.rows - 1)).toContain("/");
    await ui.press("ключесловом", "\r");
    expect(ui.terminal.line(ui.terminal.rows - 1)).toContain("совпадение 1 из");
  });

  it("подсвечивает найденное обращением цветов", async () => {
    const ui = await open();
    await ui.press("/", "ключесловом", "\r");
    const row = ui.terminal.findRow("ключесловом");
    expect(row).toBeGreaterThan(0);
    const at = ui.terminal.line(row).indexOf("ключесловом");
    expect(ui.terminal.style(row, at).inverse).toBe(true);
  });

  it("подсвечены все совпадения на экране и ничего лишнего", async () => {
    const ui = await open();
    await ui.press("/", "глава", "\r");
    // Собираем слова из обращённых ячеек: подсветиться должно ровно
    // искомое, а не куски соседних слов.
    const words = new Set<string>();
    for (let row = 0; row < ui.terminal.rows; row++) {
      let word = "";
      for (let column = 0; column < ui.terminal.columns; column++) {
        const cell = ui.terminal.style(row, column);
        if (cell.inverse && cell.char.trim()) word += cell.char;
        else if (word) {
          words.add(word.toLowerCase());
          word = "";
        }
      }
      if (word) words.add(word.toLowerCase());
    }
    expect([...words]).toEqual(["глава"]);
  });

  it("счётчик совпадений растёт по n", async () => {
    const ui = await open();
    await ui.press("/", "глава", "\r");
    expect(ui.terminal.line(ui.terminal.rows - 1)).toContain("совпадение 1 из");
    await ui.press("n");
    expect(ui.terminal.line(ui.terminal.rows - 1)).toContain("совпадение 2 из");
  });

  it("N с первого совпадения уходит в конец и говорит об этом", async () => {
    const ui = await open();
    await ui.press("/", "глава", "\r", "N");
    expect(ui.terminal.line(ui.terminal.rows - 1)).toContain("поиск с начала");
  });

  it("не различает регистр и букву ё прямо на экране", async () => {
    const ui = await open();
    await ui.press("/", "ЁЛОЧКАМИ", "\r");
    expect(ui.terminal.line(ui.terminal.rows - 1)).toContain("совпадение 1 из 1");
    const row = ui.terminal.findRow("ёлочками");
    expect(row).toBeGreaterThan(0);
    expect(ui.terminal.style(row, ui.terminal.line(row).indexOf("ёлочками")).inverse).toBe(true);
  });

  it("выбор в списке совпадений переносит к нему", async () => {
    const ui = await open();
    await ui.press("/", "глава", "\r", "l", "j", "\r");
    expect(ui.terminal.line(ui.terminal.rows - 1)).toContain("совпадение 2 из");
  });

  it("пустой запрос убирает подсветку с экрана", async () => {
    const ui = await open();
    await ui.press("/", "глава", "\r");
    await ui.press("/", "\r");
    let inverse = 0;
    for (let row = 1; row < ui.terminal.rows - 1; row++) {
      for (let column = 0; column < ui.terminal.columns; column++) {
        if (ui.terminal.style(row, column).inverse) inverse += 1;
      }
    }
    expect(inverse).toBe(0);
  });

  it("список совпадений без запроса подсказывает начать поиск", async () => {
    const ui = await open();
    await ui.press("l");
    expect(ui.terminal.line(ui.terminal.rows - 1)).toContain("сначала задайте поиск");
  });

  it("на ненайденном честно говорит об этом", async () => {
    const ui = await open();
    await ui.press("/", "такогонетвкниге", "\r");
    expect(ui.terminal.line(ui.terminal.rows - 1)).toContain("не найдено");
  });

  it("пустой запрос сбрасывает поиск", async () => {
    const ui = await open();
    await ui.press("/", "ключесловом", "\r");
    await ui.press("/", "\r");
    expect(ui.terminal.line(ui.terminal.rows - 1)).toContain("поиск сброшен");
  });

  it("n и N ходят по совпадениям", async () => {
    const ui = await open();
    await ui.press("/", "глава", "\r");
    await ui.press("n");
    expect(ui.terminal.line(ui.terminal.rows - 1)).toMatch(/совпадение \d+ из \d+/);
  });

  it("l показывает список совпадений с процентами", async () => {
    const ui = await open();
    await ui.press("/", "глава", "\r", "l");
    const screen = ui.terminal.text();
    expect(screen).toContain("Совпадения");
    expect(screen).toMatch(/\d+%/);
  });

  it("Esc отменяет ввод запроса", async () => {
    const ui = await open();
    await ui.press("/", "чтотонибудь", "\x1b");
    await new Promise((resolve) => setTimeout(resolve, 10));
    await ui.press("j");
    expect(ui.terminal.line(ui.terminal.rows - 1)).not.toContain("не найдено");
  });

  it("Backspace стирает набранное", async () => {
    const ui = await open();
    await ui.press("/", "ключе", "\x7f", "\x7f");
    expect(ui.terminal.line(ui.terminal.rows - 1).trimEnd()).toBe("/клю");
  });
});

describe("сноски", () => {
  it("Enter переходит к тексту сноски, Backspace возвращает", async () => {
    const ui = await open();
    const before = ui.reader.currentBlock();
    await ui.press("\r");
    expect(ui.terminal.text()).toContain("Это текст сноски");
    await ui.press("\x7f");
    expect(ui.reader.currentBlock()).toBe(before);
  });

  it("клик по маркеру открывает сноску", async () => {
    const ui = await open();
    const row = ui.terminal.findRow("[1]");
    const column = ui.terminal.line(row).indexOf("[1]");
    ui.terminal.click(column, row);
    await ui.press("");
    expect(ui.terminal.text()).toContain("Это текст сноски");
  });

  it("правая кнопка возвращает из сноски", async () => {
    const ui = await open();
    const before = ui.reader.currentBlock();
    await ui.press("\r");
    ui.terminal.click(1, 5, 2);
    await ui.press("");
    expect(ui.reader.currentBlock()).toBe(before);
  });

  it("когда ссылок на экране нет, говорит об этом", async () => {
    const ui = await open();
    await ui.press("G", "\r");
    expect(ui.terminal.line(ui.terminal.rows - 1)).toContain("нет ссылок");
  });
});

describe("закладки", () => {
  it("M ставит закладку и отмечает абзац полоской", async () => {
    const saved: Bookmark[][] = [];
    const ui = await open({ saveBookmarks: (marks: Bookmark[]) => saved.push(marks) });
    await ui.press("M");
    expect(ui.terminal.line(ui.terminal.rows - 1)).toContain("закладка поставлена");
    expect(saved.at(-1)).toHaveLength(1);
    expect(ui.terminal.text()).toContain("▌");
  });

  it("повторное M снимает закладку", async () => {
    const ui = await open();
    await ui.press("M", "M");
    expect(ui.terminal.line(ui.terminal.rows - 1)).toContain("закладка снята");
  });

  it("апостроф показывает список закладок", async () => {
    const ui = await open();
    await ui.press("M", "'");
    expect(ui.terminal.text()).toContain("Закладки");
  });

  it("удаление последней закладки закрывает список", async () => {
    const ui = await open();
    await ui.press("M", "'", "d");
    expect(ui.terminal.line(ui.terminal.rows - 1)).toContain("закладок больше нет");
    expect(ui.terminal.text()).not.toContain("Закладки");
  });

  it("после удаления список остаётся открытым, пока закладки есть", async () => {
    const ui = await open();
    await ui.press("M", "]", "M", "'");
    expect(ui.terminal.text()).toContain("Закладки");
    await ui.press("d");
    // Удалять по одной удобнее, чем каждый раз заходить в список заново.
    expect(ui.terminal.text()).toContain("Закладки");
    expect(ui.reader.bookmarks).toHaveLength(1);
  });

  it("e выгружает закладки и говорит куда", async () => {
    const written: Array<{ text: string }> = [];
    const ui = await open({
      exportBookmarks: (marks: unknown[]) => {
        written.push({ text: `закладок: ${marks.length}` });
        return "закладки сохранены: /куда-то/книга — закладки.md";
      },
    });
    await ui.press("M", "'", "e");
    expect(written).toHaveLength(1);
    expect(ui.terminal.line(ui.terminal.rows - 1)).toContain("закладки сохранены");
    expect(ui.terminal.text()).not.toContain("Закладки"); // окно закрылось
  });

  it("в списке закладок подсказка перечисляет все действия", async () => {
    const ui = await open();
    await ui.press("M", "'");
    expect(ui.terminal.text()).toContain("e — экспорт");
    expect(ui.terminal.text()).toContain("d — удалить");
  });

  it("Enter в списке переносит к закладке", async () => {
    const ui = await open();
    await ui.press("]", "M");            // закладка во второй главе
    const marked = ui.reader.currentBlock();
    await ui.press("g");                 // ушли в начало
    expect(ui.reader.currentBlock()).toBeLessThan(marked);
    await ui.press("'", "\r");
    expect(ui.reader.currentBlock()).toBe(marked);
  });

  it("без закладок подсказывает, как поставить", async () => {
    const ui = await open();
    await ui.press("'");
    expect(ui.terminal.line(ui.terminal.rows - 1)).toContain("поставить — M");
  });
});

describe("мышь", () => {
  it("колесо листает текст", async () => {
    const ui = await open();
    const before = ui.terminal.line(1);
    ui.terminal.wheel("down");
    await ui.press("");
    expect(ui.terminal.line(1)).not.toBe(before);
    ui.terminal.wheel("up");
    await ui.press("");
    expect(ui.terminal.line(1)).toBe(before);
  });

  it("m отпускает мышь и возвращает захват", async () => {
    const ui = await open();
    expect(ui.terminal.mouseEnabled).toBe(true);
    await ui.press("m");
    expect(ui.terminal.mouseEnabled).toBe(false);
    expect(ui.terminal.line(ui.terminal.rows - 1)).toContain("отпущена");
    await ui.press("m");
    expect(ui.terminal.mouseEnabled).toBe(true);
  });
});

describe("вид текста", () => {
  it("s меняет межстрочный интервал по кругу", async () => {
    const ui = await open();
    await ui.press("s");
    expect(ui.terminal.line(ui.terminal.rows - 1)).toContain("интервал: 2");
    await ui.press("s", "s");
    expect(ui.terminal.line(ui.terminal.rows - 1)).toContain("интервал: 1");
  });

  it("c переключает тему по кругу", async () => {
    const ui = await open({ theme: "auto" });
    await ui.press("c");
    expect(ui.terminal.line(ui.terminal.rows - 1)).toContain("тема: night");
    await ui.press("c", "c", "c");
    expect(ui.terminal.line(ui.terminal.rows - 1)).toContain("тема: auto");
  });

  it("плюс и минус меняют ширину колонки", async () => {
    const ui: ReaderHarness = await open({}, { columns: 100 });
    const before = ui.reader.currentBlock();
    await ui.press("-", "-");
    expect(ui.reader.maxWidth).toBe(52);
    await ui.press("+");
    expect(ui.reader.maxWidth).toBe(56);
    expect(ui.reader.currentBlock()).toBe(before);
  });
});

describe("EPUB на экране", () => {
  it("открывается, ходит по оглавлению и по сноске между файлами", async () => {
    const ui = await harness({ book: await epubBook(), ...OPTIONS });
    expect(ui.terminal.line(0)).toContain("Анна Автор — Пример EPUB");

    await ui.press("t", "j", "\r");
    expect(ui.reader.currentBlock()).toBeGreaterThan(0);

    await ui.press("g", "\r");
    expect(ui.terminal.text()).toContain("Это текст сноски из EPUB");
    await ui.press("\x7f");
    expect(ui.terminal.text()).not.toContain("Это текст сноски из EPUB");
  });

  it("ищет по тексту так же, как в FB2", async () => {
    const ui = await harness({ book: await epubBook(), ...OPTIONS });
    await ui.press("/", "ключесловом", "\r");
    expect(ui.terminal.line(ui.terminal.rows - 1)).toContain("совпадение 1 из");
  });
});
