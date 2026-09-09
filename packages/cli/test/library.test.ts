/**
 * Экран списка книг.
 *
 * Проверяется то же, что и в читалке: что нарисовано в каждой строке, каким
 * начертанием и куда уходит выбор после нажатия или щелчка.
 */

import { describe, expect, it } from "vitest";
import { libraryHarness } from "./harness.js";
import type { ChooserEntry } from "../src/ui/chooser.js";

const BOOKS: ChooserEntry[] = [
  { path: "/книги/первая.fb2", title: "Проверка читалки", author: "Иван Тестов", percent: 56 },
  { path: "/книги/вторая.fb2", title: "Большая книга", author: "Длинный", percent: null },
  { path: "/книги/третья.epub", title: "Пример EPUB", author: "Анна Автор", percent: 100 },
];

const many = (count: number): ChooserEntry[] =>
  Array.from({ length: count }, (_, i) => ({
    path: `/книги/книга-${i}.fb2`,
    title: `Книга номер ${i}`,
    author: "",
    percent: null,
  }));

describe("список книг", () => {
  it("в заголовке число книг со склонением", async () => {
    const ui = await libraryHarness(BOOKS);
    expect(ui.terminal.line(0)).toContain("Библиотека — 3 книги");
    const one = await libraryHarness(BOOKS.slice(0, 1));
    expect(one.terminal.line(0)).toContain("Библиотека — 1 книга");
    const five = await libraryHarness(many(5));
    expect(five.terminal.line(0)).toContain("Библиотека — 5 книг");
  });

  it("показывает автора, название и процент", async () => {
    const ui = await libraryHarness(BOOKS);
    expect(ui.terminal.line(1)).toContain("56%");
    expect(ui.terminal.line(1)).toContain("Иван Тестов — Проверка читалки");
  });

  it("книгу с сервера помечает облаком вместо процента", async () => {
    const ui = await libraryHarness([
      ...BOOKS,
      { path: "", title: "Только на сервере", author: "Автор", percent: null, remote: "a".repeat(64) },
    ]);
    const row = ui.terminal.line(4);
    expect(row).toContain("☁");
    expect(row).toContain("Только на сервере");
    // Точка значит «не начата», облако — «её тут вообще нет»: путать нельзя.
    expect(row).not.toContain("·");
  });

  it("выбор книги с сервера сообщает, что скачивать", async () => {
    const remote = { path: "", title: "Только на сервере", author: "", percent: null, remote: "b".repeat(64) };
    const ui = await libraryHarness([remote]);
    await ui.press("\r");
    // Путь пустой, поэтому библиотеке нужна сама запись — иначе скачивать
    // будет нечего.
    expect(ui.chooser.pickedEntry?.remote).toBe("b".repeat(64));
  });

  it("у неоткрытой книги вместо процента точка", async () => {
    const ui = await libraryHarness(BOOKS);
    expect(ui.terminal.line(2)).toContain("·");
    expect(ui.terminal.line(2)).not.toMatch(/\d%/);
  });

  it("внизу подсказка", async () => {
    const ui = await libraryHarness(BOOKS);
    expect(ui.terminal.line(ui.terminal.rows - 1)).toContain("Enter или клик — читать");
  });

  it("выбранная строка выделена обращением цветов", async () => {
    const ui = await libraryHarness(BOOKS);
    expect(ui.terminal.style(1, 2).inverse).toBe(true);
    expect(ui.terminal.style(2, 2).inverse).toBe(false);
    await ui.press("j");
    expect(ui.terminal.style(1, 2).inverse).toBe(false);
    expect(ui.terminal.style(2, 2).inverse).toBe(true);
  });

  it("дочитанные книги приглушены", async () => {
    const ui = await libraryHarness(BOOKS);
    const row = ui.terminal.findRow("Пример EPUB");
    expect(row).toBeGreaterThan(0);
    expect(ui.terminal.style(row, 2).dim).toBe(true);
    // Недочитанная — обычным начертанием.
    const unread = ui.terminal.findRow("Большая книга");
    expect(ui.terminal.style(unread, 2).dim).toBe(false);
  });
});

describe("ходьба по списку", () => {
  it("j и k двигают выбор, за края не уезжает", async () => {
    const ui = await libraryHarness(BOOKS);
    await ui.press("k", "k");
    expect(ui.terminal.style(1, 2).inverse).toBe(true);
    await ui.press("j", "j", "j", "j");
    expect(ui.terminal.style(3, 2).inverse).toBe(true);
  });

  it("стрелки работают наравне с буквами", async () => {
    const ui = await libraryHarness(BOOKS);
    await ui.press("\x1b[B");
    expect(ui.terminal.style(2, 2).inverse).toBe(true);
    await ui.press("\x1b[A");
    expect(ui.terminal.style(1, 2).inverse).toBe(true);
  });

  it("g и G прыгают в начало и конец", async () => {
    const ui = await libraryHarness(BOOKS);
    await ui.press("G");
    expect(ui.terminal.style(3, 2).inverse).toBe(true);
    await ui.press("g");
    expect(ui.terminal.style(1, 2).inverse).toBe(true);
  });

  it("длинный список прокручивается вместе с выбором", async () => {
    const ui = await libraryHarness(many(60), { rows: 12 });
    expect(ui.terminal.text()).toContain("Книга номер 0");
    await ui.press("G");
    expect(ui.terminal.text()).toContain("Книга номер 59");
    expect(ui.terminal.text()).not.toContain("Книга номер 0");
    await ui.press("g");
    expect(ui.terminal.text()).toContain("Книга номер 0");
  });

  it("PgDn и PgUp листают страницами", async () => {
    const ui = await libraryHarness(many(60), { rows: 12 });
    await ui.press("\x1b[6~");
    expect(ui.terminal.text()).toContain("Книга номер 9");
    await ui.press("\x1b[5~");
    expect(ui.terminal.text()).toContain("Книга номер 0");
  });
});

describe("выбор книги", () => {
  it("Enter отдаёт путь выбранной книги", async () => {
    const ui = await libraryHarness(BOOKS);
    await ui.press("j", "\r");
    expect(await ui.picked()).toBe("/книги/вторая.fb2");
  });

  it("q заканчивает работу без выбора", async () => {
    const ui = await libraryHarness(BOOKS);
    await ui.press("q");
    expect(await ui.picked()).toBeNull();
  });

  it("Esc тоже выходит", async () => {
    const ui = await libraryHarness(BOOKS);
    await ui.press("\x1b");
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(await ui.picked()).toBeNull();
  });

  it("щелчок по строке открывает именно её", async () => {
    const ui = await libraryHarness(BOOKS);
    const row = ui.terminal.findRow("Пример EPUB");
    ui.terminal.click(5, row);
    expect(await ui.picked()).toBe("/книги/третья.epub");
  });

  it("щелчок ниже последней книги ничего не открывает", async () => {
    const ui = await libraryHarness(BOOKS);
    ui.terminal.click(5, 10);
    await ui.settle();
    expect(ui.chooser.done).toBe(false);
  });

  it("колесо двигает выбор на одну книгу", async () => {
    const ui = await libraryHarness(BOOKS);
    ui.terminal.wheel("down");
    await ui.settle();
    expect(ui.terminal.style(2, 2).inverse).toBe(true);
    ui.terminal.wheel("up");
    await ui.settle();
    expect(ui.terminal.style(1, 2).inverse).toBe(true);
  });
});

describe("изменение размера окна", () => {
  it("список перестраивается и выбор остаётся видимым", async () => {
    const ui = await libraryHarness(many(40), { rows: 24 });
    await ui.press("G");
    expect(ui.terminal.text()).toContain("Книга номер 39");
    await ui.resize(10, 60);
    expect(ui.terminal.text()).toContain("Книга номер 39");
    for (const line of ui.terminal.lines()) expect(line.length).toBeLessThanOrEqual(60);
  });
});

describe("книга, которая не открылась", () => {
  it("сообщение занимает экран и уходит от любой клавиши", async () => {
    const ui = await libraryHarness(BOOKS);
    ui.chooser.showFailure("битая.fb2: файл повреждён");
    await ui.settle();
    expect(ui.terminal.text()).toContain("файл повреждён");
    expect(ui.terminal.text()).toContain("любая клавиша — назад к списку");
    await ui.press("x");
    // Экран закончился без выбора: цикл библиотеки покажет список заново.
    expect(await ui.picked()).toBeNull();
  });
});

describe("синхронизация из списка", () => {
  it("подсказка называет клавишу, когда сервер настроен", async () => {
    const ui = await libraryHarness(BOOKS, { onSync: async () => ({ text: "готово" }) });
    // Именно это отвечает на «не вижу, где синхронизация»: клавиша названа
    // прямо на экране, а не только в README.
    expect(ui.terminal.line(ui.terminal.rows - 1)).toContain("S — синхронизировать");
  });

  it("без сервера подсказка прежняя и не обещает лишнего", async () => {
    const ui = await libraryHarness(BOOKS);
    expect(ui.terminal.line(ui.terminal.rows - 1)).not.toContain("синхронизировать");
  });

  it("по S сообщает о начале, потом об исходе", async () => {
    let release: (v: { text: string }) => void = () => {};
    const ui = await libraryHarness(BOOKS, {
      onSync: () => new Promise((resolve) => (release = resolve)),
    });
    await ui.press("S");
    expect(ui.terminal.line(ui.terminal.rows - 1)).toContain("синхронизирую");

    release({ text: "синхронизировано 3, обновилось 1" });
    await ui.settle();
    expect(ui.terminal.line(ui.terminal.rows - 1)).toContain("обновилось 1");
  });

  it("обновляет сам список, а не только подпись", async () => {
    const ui = await libraryHarness(BOOKS, {
      onSync: async () => ({
        text: "готово",
        entries: [
          ...BOOKS,
          { path: "", title: "Приехала с сервера", author: "", percent: null, remote: "d".repeat(64) },
        ],
      }),
    });
    await ui.press("S");
    await ui.settle();
    expect(ui.terminal.text()).toContain("Приехала с сервера");
    expect(ui.terminal.line(0)).toContain("4 книги");
  });

  it("без настроенного сервера объясняет, чего не хватает", async () => {
    const ui = await libraryHarness(BOOKS);
    await ui.press("S");
    await ui.settle();
    expect(ui.terminal.line(ui.terminal.rows - 1)).toContain("[sync]");
  });

  it("S не выбирает книгу и не закрывает список", async () => {
    const ui = await libraryHarness(BOOKS, { onSync: async () => ({ text: "готово" }) });
    await ui.press("S");
    await ui.settle();
    expect(ui.chooser.done).toBe(false);
    expect(ui.chooser.picked).toBeNull();
  });
});
